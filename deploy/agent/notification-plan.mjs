import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { externalPath } from "../gateway/gateway.mjs";
import { readControlJson } from "./control-files.mjs";
import { ProvisionError } from "./provision-error.mjs";

const invalid = () => {
  throw new ProvisionError("invalid_notification_plan");
};
const fields = [
  "version",
  "tenant",
  "ownerId",
  "executionUser",
  "executionGroup",
  "topology",
  "authOrigin",
  "bundleRoot",
  "controlFile",
  "caFile",
  "credentialsFile",
  "databaseFile",
  "manifestRoot",
];

/** An inert plan for an explicitly selected owner and supported local topology. */
export function renderNotificationPlan(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== [...fields].sort().join() ||
    input.version !== 1
  )
    invalid();
  try {
    assertCustomerTenantId(input.tenant);
  } catch {
    invalid();
  }
  if (
    typeof input.ownerId !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,62}$/.test(input.ownerId) ||
    typeof input.executionUser !== "string" ||
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.executionUser) ||
    typeof input.executionGroup !== "string" ||
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.executionGroup) ||
    input.topology !== "customer-local"
  )
    invalid();
  let origin;
  try {
    origin = new URL(input.authOrigin);
  } catch {
    invalid();
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.authOrigin ||
    !/^[a-z0-9.-]+\.jgw\.test$/.test(origin.hostname) ||
    origin.port === "3001" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    invalid();
  const paths = [
    "bundleRoot",
    "controlFile",
    "caFile",
    "credentialsFile",
    "databaseFile",
    "manifestRoot",
  ];
  for (const name of paths) {
    try {
      externalPath(input[name]);
    } catch {
      invalid();
    }
    if (!/^[A-Za-z0-9_./-]+$/.test(input[name])) invalid();
  }
  if (
    new Set(paths.map((name) => input[name])).size !== paths.length ||
    ["controlFile", "caFile", "credentialsFile", "databaseFile"].some((name) =>
      [input.manifestRoot, input.bundleRoot].some((root) =>
        input[name].startsWith(root + "/"),
      ),
    )
  )
    invalid();
  const control = {
    tenant: input.tenant,
    authOrigin: input.authOrigin,
    caFile: input.caFile,
    credentialsFile: input.credentialsFile,
    databaseFile: input.databaseFile,
    manifestRoot: input.manifestRoot,
  };
  const service = `[Unit]\nDescription=Refresh J Groupware notification lease\nAfter=network-online.target jgw-postgres.service\nWants=network-online.target\n\n[Service]\nType=oneshot\nUser=${input.executionUser}\nGroup=${input.executionGroup}\nExecStart=/usr/bin/node ${input.bundleRoot}/j-groupware/deploy/agent/notification-worker.mjs --config ${input.controlFile} --once\nTimeoutStartSec=30\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=${input.manifestRoot}\n`;
  const timer =
    "[Unit]\nDescription=Refresh notification lease before its 60-second expiry\n\n[Timer]\nOnBootSec=20s\nOnUnitInactiveSec=20s\nAccuracySec=1s\nUnit=jgw-notification-refresh.service\n\n[Install]\nWantedBy=timers.target\n";
  return Object.freeze({
    tenant: input.tenant,
    ownerId: input.ownerId,
    topology: input.topology,
    activation: "pending",
    acceptance_complete: false,
    control: JSON.stringify(control) + "\n",
    service,
    timer,
    not_run_list: [
      "credential-provision-and-refresh",
      "execution-account-and-file-access",
      "customer-local-postgres-and-private-receiver",
      "systemd-activation",
      "customer-vm-acceptance",
    ],
  });
}

async function main(argv) {
  if (
    argv.length !== 3 ||
    argv[0] !== "--profile" ||
    !["--validate-only", "--print-plan"].includes(argv[2])
  )
    invalid();
  const plan = renderNotificationPlan(await readControlJson(argv[1], 16384));
  if (argv[2] === "--print-plan") {
    process.stdout.write(JSON.stringify(plan) + "\n");
    return;
  }
  process.stdout.write(
    JSON.stringify({
      tenant: plan.tenant,
      phase: "notification_plan_validated",
      activation: plan.activation,
      acceptance_complete: false,
      not_run_list: plan.not_run_list,
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      (error instanceof ProvisionError
        ? error.code
        : "notification_plan_failed") + "\n",
    );
    process.exitCode = 1;
  });
