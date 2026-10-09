import path from "node:path";
import { readControlFile, readControlJson } from "./control-files.mjs";
import { readPreparedBootstrap } from "./base-environment.mjs";
import { installationDirectory, installationFile } from "./install-files.mjs";
import { externalPath, execute } from "../gateway/gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";

export const AGENT_CONTROL = "/etc/jgw/agent/control.json";
export function renderProvisionAgentUnits(
  bundleRoot,
  controlFile = AGENT_CONTROL,
) {
  for (const value of [bundleRoot, controlFile]) {
    externalPath(value);
    if (!/^[a-zA-Z0-9_./-]+$/.test(value))
      throw new ProvisionError("invalid_agent_installation");
  }
  return {
    "jgw-provision-agent.service": `[Unit]\nDescription=Reconcile J Groupware subscriptions\nAfter=network-online.target jgw-postgres.service\nWants=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nGroup=root\nWorkingDirectory=${bundleRoot}/j-groupware\nExecStart=/usr/bin/node ${bundleRoot}/j-groupware/deploy/agent/provision-agent.mjs --config ${controlFile} --once\nUMask=0077\nTimeoutStartSec=900\nKillMode=control-group\nPrivateTmp=true\nNoNewPrivileges=true\n`,
    "jgw-provision-agent.timer":
      "[Unit]\nDescription=Reconcile J Groupware every minute\n\n[Timer]\nOnBootSec=60s\nOnUnitActiveSec=60s\nAccuracySec=1s\nUnit=jgw-provision-agent.service\n\n[Install]\nWantedBy=timers.target\n",
  };
}
// Preparation copies existing sealed inputs; it does not create any key or enable a timer.
export async function prepareProvisionAgent({
  bootstrapRoot,
  productProfileFile,
  bundleRoot,
  stateRoot,
  lockRoot,
  controlRoot = "/etc/jgw/agent",
  unitRoot = "/etc/systemd/system",
}) {
  if (process.getuid() !== 0) throw new ProvisionError("root_required");
  const { loadProvisionAgentControl } = await import("./provision-agent.mjs");
  for (const value of [
    bootstrapRoot,
    productProfileFile,
    bundleRoot,
    stateRoot,
    lockRoot,
    controlRoot,
    unitRoot,
  ])
    externalPath(value);
  const bootstrap = await readPreparedBootstrap(bootstrapRoot);
  await readControlFile(productProfileFile);
  if (
    [stateRoot, lockRoot, controlRoot, unitRoot].some((root) =>
      [bootstrapRoot, productProfileFile].some(
        (input) => input === root || input.startsWith(root + "/"),
      ),
    )
  )
    throw new ProvisionError("overlapping_agent_installation");
  const control = {
    bootstrapRoot,
    installer: bundleRoot + "/j-groupware/deploy/provision-service",
    lockRoot: lockRoot + "-agent",
    productProfileFile,
    stateRoot,
  };
  await installationDirectory(controlRoot, 0o700);
  const controlFile = path.join(controlRoot, "control.json");
  await installationFile(controlFile, JSON.stringify(control) + "\n");
  const config = await loadProvisionAgentControl(controlFile);
  if (config.bootstrap.tenant !== bootstrap.tenant)
    throw new ProvisionError("invalid_agent_installation");
  const units = renderProvisionAgentUnits(bundleRoot, controlFile);
  await installationDirectory(unitRoot);
  for (const [name, text] of Object.entries(units))
    await installationFile(path.join(unitRoot, name), text, 0o644);
  await installationFile(
    controlRoot + "/installation.json",
    JSON.stringify({
      format: 1,
      tenant: bootstrap.tenant,
      bundleRoot,
      controlFile,
      unitRoot,
      units,
    }) + "\n",
  );
  return {
    tenant: bootstrap.tenant,
    phase: "agent_prepared",
    activation: "pending",
  };
}
export async function activatePreparedProvisionAgent(
  controlRoot = "/etc/jgw/agent",
) {
  if (process.getuid() !== 0) throw new ProvisionError("root_required");
  if (controlRoot !== "/etc/jgw/agent")
    throw new ProvisionError("invalid_agent_installation");
  const { loadProvisionAgentControl } = await import("./provision-agent.mjs");
  const receipt = await readControlJson(
    controlRoot + "/installation.json",
    16384,
  );
  const units = renderProvisionAgentUnits(
    receipt.bundleRoot,
    receipt.controlFile,
  );
  if (
    Object.keys(receipt).sort().join() !==
      ["format", "tenant", "bundleRoot", "controlFile", "unitRoot", "units"]
        .sort()
        .join() ||
    receipt.format !== 1 ||
    receipt.controlFile !== AGENT_CONTROL ||
    receipt.unitRoot !== "/etc/systemd/system" ||
    JSON.stringify(units) !== JSON.stringify(receipt.units)
  )
    throw new ProvisionError("invalid_agent_installation");
  for (const [name, text] of Object.entries(units))
    if (
      (await readControlFile(path.join(receipt.unitRoot, name), {
        privateFile: false,
      })) !== text
    )
      throw new ProvisionError("installation_file_conflict");
  await loadProvisionAgentControl(receipt.controlFile);
  const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
  await execute("/usr/bin/systemctl", ["daemon-reload"], { env });
  await execute(
    "/usr/bin/systemctl",
    ["enable", "--now", "jgw-provision-agent.timer"],
    { env },
  );
  await execute(
    "/usr/bin/systemctl",
    ["is-active", "--quiet", "jgw-provision-agent.timer"],
    { env },
  );
  return { tenant: receipt.tenant, phase: "agent_active" };
}
