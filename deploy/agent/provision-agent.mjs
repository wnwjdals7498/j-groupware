import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";
import { readPreparedBootstrap } from "./base-environment.mjs";
import { readControlJson, readControlFile } from "./control-files.mjs";
import { ProductEnvironment } from "./product-environment.mjs";
import { ProductReadiness, ServiceInventory } from "./product-readiness.mjs";
import { ServiceStateFiles } from "./service-lifecycle.mjs";
import { ConsoleAgentClient } from "./console-client.mjs";
import { AgentReconciler, DirectoryLock } from "./reconciler.mjs";
import { provisionCommand } from "./provision-command.mjs";
import { externalPath } from "../gateway/gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";

// Existing sealed credentials only. Loading control does not issue credentials,
// register a timer, import operator code, or execute the installer.
export async function loadProvisionAgentControl(file) {
  const input = await readControlJson(file, 8192);
  if (
    Object.keys(input).sort().join(",") !==
    "bootstrapRoot,installer,lockRoot,productProfileFile,stateRoot"
  )
    throw new ProvisionError("invalid_agent_control");
  for (const value of Object.values(input)) externalPath(value);
  const bootstrap = await readPreparedBootstrap(input.bootstrapRoot);
  const products = await readControlJson(input.productProfileFile, 16384);
  if (
    !Object.hasOwn(products, "databasePort") ||
    !Object.hasOwn(products, "profiles") ||
    Object.keys(products).some(
      (key) =>
        !["databasePort", "profiles", "notificationOrigin"].includes(key),
    )
  )
    throw new ProvisionError("invalid_agent_profile");
  const environment = new ProductEnvironment({
    ...products,
    tenant: bootstrap.tenant,
    keycloakOrigin: bootstrap.keycloakOrigin,
    serviceKey: bootstrap.serviceKey,
  });
  return {
    bootstrap,
    environment,
    installer: input.installer,
    stateRoot: input.stateRoot,
    lockRoot: input.lockRoot,
  };
}

export function createProvisionAgentRuntime({
  bootstrap,
  environment,
  installer,
  stateRoot,
  lockRoot,
  fetch,
}) {
  if (environment?.tenant !== bootstrap?.tenant)
    throw new ProvisionError("invalid_agent_profile");
  const client = new ConsoleAgentClient({
    tenant: bootstrap.tenant,
    origin: bootstrap.consoleOrigin,
    key: bootstrap.agentKey,
    ...(fetch ? { fetch } : {}),
  });
  const state = new ServiceStateFiles(stateRoot, bootstrap.tenant),
    readiness = new ProductReadiness({ environment }),
    inventory = new ServiceInventory({
      tenant: bootstrap.tenant,
      state,
      readiness,
    });
  const reconciler = new AgentReconciler({
    tenant: bootstrap.tenant,
    lock: new DirectoryLock(lockRoot),
    desired: (signal) => client.desired(signal),
    inventory: (signal) => inventory.read(signal),
    provision: provisionCommand(installer),
    report: (result, signal) => client.report(result, signal),
  });
  // Construction is inert; one explicit run holds the lock through mutation,
  // actual postcondition observation and the console's accepted status report.
  return { runOnce: (signal) => reconciler.run(signal) };
}

async function main() {
  if (
    process.argv.length !== 5 ||
    process.argv[2] !== "--config" ||
    process.argv[4] !== "--once"
  )
    throw new ProvisionError("invalid_agent_arguments");
  const config = await loadProvisionAgentControl(process.argv[3]),
    ca = await readControlFile(config.bootstrap.ca, { privateFile: false }),
    agent = new Agent({
      connect: {
        ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
    }),
    controller = new AbortController(),
    stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  try {
    const runtime = createProvisionAgentRuntime({
      ...config,
      fetch: (input, init) =>
        undiciFetch(String(input), { ...init, dispatcher: agent }),
    });
    const result = await runtime.runOnce(controller.signal);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.outcome !== "synchronized" || result.reported !== true)
      process.exitCode = 1;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"])
      process.removeListener(signal, stop);
    await agent.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      (error instanceof ProvisionError ? error.code : "agent_run_failed") +
        "\n",
    );
    process.exitCode = 1;
  });
}
