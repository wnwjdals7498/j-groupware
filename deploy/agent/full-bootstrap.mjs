import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBootstrapKit } from "./bootstrap-kit.mjs";
import { readControlJson } from "./control-files.mjs";
import {
  loadBootstrapRuntimeControl,
  createBootstrapRuntime,
} from "./bootstrap-runtime.mjs";
import {
  prepareProvisionAgent,
  activatePreparedProvisionAgent,
} from "./agent-install.mjs";
import { OsBootstrap, requireSystemdVm } from "./os-bootstrap.mjs";
import { installationDirectory } from "./install-files.mjs";
import { X509Certificate } from "node:crypto";
import { readControlFile } from "./control-files.mjs";
import { DirectoryLock } from "./reconciler.mjs";
import { ProvisionError } from "./provision-error.mjs";

export const FULL_BOOTSTRAP_CONTROL = "/etc/jgw/bootstrap/full-control.json";
// Only explicitly prepared controls. The default verifies the kit and inputs;
// --prepare stages OS/agent units without enabling them; --activate is the
// separately authorized VM operation (never used by cloud source validation).
export async function runFullBootstrap({
  kitRoot,
  operation = "verify",
  controlFile = FULL_BOOTSTRAP_CONTROL,
}) {
  if (process.getuid() !== 0) throw new ProvisionError("root_required");
  if (!["verify", "prepare", "activate"].includes(operation))
    throw new ProvisionError("invalid_bootstrap_arguments");
  const manifest = await verifyBootstrapKit(kitRoot),
    input = await readControlJson(controlFile, 8192);
  if (
    Object.keys(input).sort().join() !==
      "bootstrapControlFile,kitManifestSha256,osProfileFile" ||
    !/^[a-f0-9]{64}$/.test(input.kitManifestSha256)
  )
    throw new ProvisionError("invalid_full_bootstrap_control");
  const { createHash } = await import("node:crypto"),
    { readFile } = await import("node:fs/promises");
  if (
    createHash("sha256")
      .update(await readFile(kitRoot + "/manifest.json"))
      .digest("hex") !== input.kitManifestSha256
  )
    throw new ProvisionError("kit_control_mismatch");
  const config = await loadBootstrapRuntimeControl(input.bootstrapControlFile),
    profile = await readControlJson(input.osProfileFile, 262144),
    tenant = config.control.bootstrap.tenant;
  if (
    config.control.bootstrap.bundles.length !== 7 ||
    config.bundles.npmCli !== kitRoot + "/npm/bin/npm-cli.js"
  )
    throw new ProvisionError("kit_control_mismatch");
  if (
    profile.node.file !== kitRoot + "/bin/node" ||
    profile.node.sha256 !==
      manifest.files.find((row) => row.path === "bin/node")?.sha256
  )
    throw new ProvisionError("kit_control_mismatch");
  for (let i = 0; i < profile.packages.length; i++)
    if (
      profile.packages[i].file !== kitRoot + "/os/" + i + ".deb" ||
      profile.packages[i].sha256 !==
        manifest.files.find((row) => row.path === "os/" + i + ".deb")?.sha256
    )
      throw new ProvisionError("kit_control_mismatch");
  if (
    profile.postgres.port !== config.control.postgres.port ||
    (await readControlFile(profile.postgres.passwordFile)).trim() !==
      config.control.postgres.password ||
    new X509Certificate(
      await readControlFile(profile.caFile, { privateFile: false }),
    ).fingerprint256 !==
      new X509Certificate(
        await readControlFile(config.control.bootstrap.ca, {
          privateFile: false,
        }),
      ).fingerprint256
  )
    throw new ProvisionError("kit_control_mismatch");
  const os = new OsBootstrap({ tenant, profile });
  await os.preflight();
  for (const bundle of config.control.bootstrap.bundles) {
    if (
      manifest.files.find(
        (row) => row.path === "archives/" + bundle.service + ".tgz",
      )?.sha256 !== bundle.digest
    )
      throw new ProvisionError("kit_control_mismatch");
    bundle.archive = kitRoot + "/archives/" + bundle.service + ".tgz";
  }
  if (operation === "verify")
    return { tenant, phase: "kit_verified", activation: "pending" };
  if (
    operation === "activate" &&
    (config.control.roots.bundleRoot !== "/opt/jgw/bundles" ||
      config.control.roots.unitRoot !== "/etc/systemd/system" ||
      config.control.roots.gatewayRoot !== "/etc/nginx")
  )
    throw new ProvisionError("invalid_activation_target");
  if (operation === "activate") await requireSystemdVm();
  const lock = new DirectoryLock("/run/jgw-full-bootstrap.lock"),
    release = await lock.acquire();
  if (!release) throw new ProvisionError("bootstrap_busy");
  try {
    await os.prepare();
    if (operation === "activate") {
      await os.applyPackages();
      await os.startPostgres();
    }
    // Prepared bundles are installed by the existing pinned npm-ci path only on
    // activation, after OS/PG readiness. Preparation does not launch services.
    if (operation === "activate") {
      await installationDirectory(config.control.roots.bundleRoot);
      const runtime = createBootstrapRuntime(config);
      try {
        await runtime.run();
      } finally {
        await runtime.close();
      }
    }
    const installer = await readControlJson(
      (await readControlJson(input.bootstrapControlFile, 8192))
        .installerControlFile,
      32768,
    );
    await prepareProvisionAgent({
      bootstrapRoot: installer.bootstrapRoot,
      productProfileFile: installer.productProfileFile,
      bundleRoot: installer.roots.bundleRoot,
      stateRoot: installer.roots.stateRoot,
      lockRoot: installer.roots.lockRoot,
      unitRoot: installer.roots.unitRoot,
    });
    if (operation === "activate") return activatePreparedProvisionAgent();
    return { tenant, phase: "kit_prepared", activation: "pending" };
  } finally {
    await release();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [kitRoot, flag] = process.argv.slice(2);
  const operation =
    flag === undefined
      ? "verify"
      : flag === "--prepare"
        ? "prepare"
        : flag === "--activate"
          ? "activate"
          : "invalid";
  if (process.argv.length > 4) process.exitCode = 1;
  else
    runFullBootstrap({ kitRoot, operation })
      .then((value) => process.stdout.write(JSON.stringify(value) + "\n"))
      .catch((error) => {
        process.stderr.write(
          (error instanceof ProvisionError ? error.code : "bootstrap_failed") +
            "\n",
        );
        process.exitCode = 1;
      });
}
