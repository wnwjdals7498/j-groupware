import path from "node:path";
import { fileURLToPath } from "node:url";
import { readControlJson, readControlFile } from "./control-files.mjs";
import {
  loadProvisionServiceControl,
  createProvisionServiceRuntime,
} from "./provision-service.mjs";
import { BaseEnvironment } from "./base-environment.mjs";
import { BundleInstaller } from "./bundle-install.mjs";
import { ProvisionError } from "./provision-error.mjs";
import { externalPath } from "../gateway/gateway.mjs";

export const BOOTSTRAP_CONTROL = "/etc/jgw/bootstrap/control.json";
const exact = (input, fields) =>
  input &&
  typeof input === "object" &&
  !Array.isArray(input) &&
  Object.keys(input).sort().join(",") === [...fields].sort().join(",");
const fail = () => {
  throw new ProvisionError("invalid_bootstrap_control");
};
// Uses existing sealed credentials and prepared OS/PG tools only. No credential
// issuance, package manager, OS CA trust write or agent/timer registration.
export async function loadBootstrapRuntimeControl(file = BOOTSTRAP_CONTROL) {
  if (process.platform !== "linux" || process.getuid() !== 0)
    throw new ProvisionError("root_required");
  const input = await readControlJson(file, 8192);
  if (
    !exact(input, [
      "installerControlFile",
      "baseProfileFile",
      "bundleInstallFile",
    ])
  )
    fail();
  for (const value of Object.values(input)) externalPath(value);
  const control = await loadProvisionServiceControl(input.installerControlFile);
  const profile = await readControlJson(input.baseProfileFile, 8192);
  if (
    !exact(profile, [
      "port",
      "publicOrigin",
      "authApiOrigin",
      "certificate",
      "key",
    ])
  )
    fail();
  const baseEnvironment = new BaseEnvironment({
    ...profile,
    bootstrap: control.bootstrap,
    databasePort: control.environment.databasePort,
    services: Object.fromEntries(
      Object.entries(control.environment.profiles).map(([service, value]) => [
        service,
        "https://127.0.0.1:" + value.port,
      ]),
    ),
  });
  const install = await readControlJson(input.bundleInstallFile, 8192);
  if (!exact(install, ["npmConfig", "cache", "npmCli"])) fail();
  for (const value of Object.values(install)) externalPath(value);
  // Private npm credentials and immutable installer code stay outside all writes.
  for (const inputFile of [
    file,
    ...Object.values(input),
    install.npmConfig,
    install.npmCli,
    profile.certificate,
    profile.key,
  ])
    if (
      [...Object.values(control.roots), install.cache].some(
        (root) => inputFile === root || inputFile.startsWith(root + "/"),
      )
    )
      fail();
  if (
    [...Object.values(control.roots), path.dirname(control.bootstrap.ca)].some(
      (root) =>
        install.cache === root ||
        install.cache.startsWith(root + "/") ||
        root.startsWith(install.cache + "/"),
    )
  )
    fail();
  await readControlFile(install.npmConfig);
  await readControlFile(install.npmCli, {
    privateFile: false,
    maximum: 4 * 1024 * 1024,
  });
  const bundles = new BundleInstaller({
    root: control.roots.bundleRoot,
    ...install,
  });
  return { control, baseEnvironment, bundles };
}
export function createBootstrapRuntime({ control, baseEnvironment, bundles }) {
  const runtime = createProvisionServiceRuntime(control);
  const bootstrap = runtime.createBaseBootstrap(baseEnvironment, bundles);
  return {
    run: (signal) => bootstrap.run(signal),
    close: () => runtime.close(),
  };
}
export async function runBootstrapCli(argv = process.argv.slice(2)) {
  if (argv.length) throw new ProvisionError("invalid_bootstrap_arguments");
  const runtime = createBootstrapRuntime(await loadBootstrapRuntimeControl());
  const controller = new AbortController(),
    stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  try {
    process.stdout.write(
      JSON.stringify(await runtime.run(controller.signal)) + "\n",
    );
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"])
      process.removeListener(signal, stop);
    await runtime.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runBootstrapCli().catch((error) => {
    process.stderr.write(
      (error instanceof ProvisionError ? error.code : "bootstrap_failed") +
        "\n",
    );
    process.exitCode = 1;
  });
