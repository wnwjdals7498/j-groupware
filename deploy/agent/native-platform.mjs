import {
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parseUnitObservation } from "./unit-observation.mjs";
import { NativeServiceAccounts } from "./native-accounts.mjs";
import { execute, externalPath } from "../gateway/gateway.mjs";
import { ProvisionError, serviceDatabase } from "./service-database.mjs";
import {
  NativeTlsCredentials,
  credentialNames,
  serviceCredentialVariables,
} from "./tls-credentials.mjs";
const user = (service) =>
  service === "j-web" ? "jweb" : "jgw-" + service.slice(2);
// Privileged fixed binaries must not inherit user-controlled loaders or hooks.
const run = (command, args) =>
  execute(command, args, {
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
  });
async function protectedPath(target, kind) {
  for (let value = target; value !== "/"; value = path.dirname(value)) {
    const info = await lstat(value);
    if (
      info.uid !== 0 ||
      info.mode & 0o022 ||
      info.isSymbolicLink() ||
      (value === target
        ? kind === "file"
          ? !info.isFile()
          : !info.isDirectory()
        : !info.isDirectory()) ||
      (await realpath(value)) !== value
    )
      throw new ProvisionError("unsafe_bundle");
  }
}
export function renderServiceUnit(service, bundleRoot, environmentRoot) {
  serviceDatabase(service);
  externalPath(bundleRoot);
  externalPath(environmentRoot);
  return `[Unit]\nDescription=J Groupware ${service}\nAfter=network.target jgw-postgres.service${service === "j-mail" ? " jgw-mail-egress.service" : ""}\n${service === "j-mail" ? "Requires=jgw-mail-egress.service\n" : ""}\n[Service]\nType=simple\nUser=${user(service)}\nGroup=${user(service)}\nWorkingDirectory=${bundleRoot}/${service}\nEnvironmentFile=${environmentRoot}/${service}.env\n${serviceCredentialVariables(
    service,
  )
    .map(
      (_variable, index) =>
        `LoadCredential=${credentialNames[index]}:${environmentRoot}/${service}.credentials/${credentialNames[index]}\n`,
    )
    .join(
      "",
    )}ExecStart=/usr/bin/env -u NODE_EXTRA_CA_CERTS -- /usr/bin/node ${bundleRoot}/j-groupware/deploy/agent/launch-service.mjs ${service} ${bundleRoot}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\nPrivateTmp=true\nNoNewPrivileges=${service === "j-web" ? "false" : "true"}\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export class NativeSystemdPlatform {
  constructor({
    bundleRoot = "/opt/jgw/bundles",
    environmentRoot = "/etc/jgw/services",
    unitRoot = "/etc/systemd/system",
    ready,
  }) {
    for (const root of [bundleRoot, environmentRoot, unitRoot])
      externalPath(root);
    if (typeof ready !== "function")
      throw new ProvisionError("readiness_probe_required");
    Object.assign(this, {
      bundleRoot,
      environmentRoot,
      unitRoot,
      probe: ready,
    });
    this.accounts = new NativeServiceAccounts({
      root: environmentRoot,
      stopped: (service) => this.stopped(service),
    });
  }
  unit(service) {
    serviceDatabase(service);
    return "jgw-" + service.slice(2) + ".service";
  }
  async preflight(service) {
    serviceDatabase(service);
    if (process.getuid() !== 0) throw new ProvisionError("root_required");
    const root = path.join(this.bundleRoot, service),
      entry = path.join(root, "apps/server/dist/main.js");
    await protectedPath(entry, "file");
    await protectedPath(
      path.join(this.bundleRoot, "j-groupware/deploy/agent/launch-service.mjs"),
      "file",
    );
    await protectedPath(
      path.join(
        this.bundleRoot,
        "j-groupware/deploy/agent/tls-credentials.mjs",
      ),
      "file",
    );
    const metadataFile = path.join(root, "jgw-bundle.json");
    await protectedPath(metadataFile, "file");
    if ((await lstat(metadataFile)).size > 8192)
      throw new ProvisionError("unsafe_bundle");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    const installMarker = path.join(root, ".jgw-install.json"),
      lockFile = path.join(root, "package-lock.json");
    await protectedPath(installMarker, "file");
    await protectedPath(lockFile, "file");
    if (
      (await lstat(installMarker)).size > 8192 ||
      (await lstat(lockFile)).size > 4 * 1024 * 1024
    )
      throw new ProvisionError("unsafe_bundle");
    const installed = JSON.parse(await readFile(installMarker, "utf8"));
    if (
      installed.service !== service ||
      installed.phase !== "ready" ||
      !/^[a-f0-9]{64}$/.test(installed.archiveSha256) ||
      installed.packageLockSha256 !== metadata.packageLockSha256 ||
      installed.packageLockSha256 !==
        createHash("sha256")
          .update(await readFile(lockFile))
          .digest("hex")
    )
      throw new ProvisionError("bundle_not_ready");
    if (
      metadata.service !== service ||
      metadata.profile !== "suite-internal" ||
      metadata.entrypoint !== "apps/server/dist/main.js" ||
      metadata.entrypointSha256 !==
        createHash("sha256")
          .update(await readFile(entry))
          .digest("hex")
    )
      throw new ProvisionError("bundle_not_ready");
    await protectedPath(this.unitRoot, "directory");
  }
  async preparedEnvironment(service) {
    const environment = path.join(this.environmentRoot, service + ".env");
    await protectedPath(environment, "file");
    if ((await lstat(environment)).mode & 0o077)
      throw new ProvisionError("unsafe_environment_file");
  }
  async preparedUnit(service) {
    const file = path.join(this.unitRoot, this.unit(service));
    await protectedPath(file, "file");
    if (
      (await lstat(file)).size > 8192 ||
      (await readFile(file, "utf8")) !==
        renderServiceUnit(service, this.bundleRoot, this.environmentRoot)
    )
      throw new ProvisionError("unit_conflict");
  }
  async install(service) {
    await this.preflight(service);
    await this.preparedEnvironment(service);
    await new NativeTlsCredentials({
      environmentRoot: this.environmentRoot,
    }).prepare(service);
    await this.accounts.ensure(service);
    const root = await lstat(this.unitRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== 0 ||
      root.mode & 0o022
    )
      throw new ProvisionError("unsafe_unit_root");
    const file = path.join(this.unitRoot, this.unit(service)),
      content = renderServiceUnit(
        service,
        this.bundleRoot,
        this.environmentRoot,
      );
    try {
      const info = await lstat(file);
      if (
        info.uid !== 0 ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.mode & 0o022
      )
        throw new ProvisionError("unsafe_unit");
      const previous = await readFile(file, "utf8");
      if (previous !== content) throw new ProvisionError("unit_conflict");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const temporary = file + "." + randomUUID() + ".partial";
      try {
        await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await run("/usr/bin/systemctl", ["daemon-reload"]);
  }
  async start(service) {
    await this.preflight(service);
    await this.preparedEnvironment(service);
    await new NativeTlsCredentials({
      environmentRoot: this.environmentRoot,
    }).require(service);
    await this.preparedUnit(service);
    await run("/usr/bin/systemctl", ["enable", "--now", this.unit(service)]);
  }
  async ready(service) {
    await this.preparedUnit(service);
    await run("/usr/bin/systemctl", [
      "is-active",
      "--quiet",
      this.unit(service),
    ]);
    if ((await this.probe(service)) !== true)
      throw new ProvisionError("service_not_ready");
  }
  async stop(service, { allowMissing = false } = {}) {
    if (process.getuid() !== 0) throw new ProvisionError("root_required");
    await protectedPath(this.unitRoot, "directory");
    let present = true;
    try {
      await this.preparedUnit(service);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      present = false;
    }
    const observation = parseUnitObservation(
      await run("/usr/bin/systemctl", [
        "show",
        this.unit(service),
        "--all",
        "--no-pager",
        "--property=LoadState,FragmentPath,ActiveState",
      ]),
    );
    if (!present) {
      if (
        allowMissing &&
        observation.LoadState === "not-found" &&
        observation.FragmentPath === "" &&
        observation.ActiveState === "inactive"
      )
        return { unit: "absent" };
      throw new ProvisionError("unit_conflict");
    }
    if (
      observation.LoadState !== "loaded" ||
      observation.FragmentPath !== path.join(this.unitRoot, this.unit(service))
    )
      throw new ProvisionError("unit_conflict");
    await run("/usr/bin/systemctl", ["disable", "--now", this.unit(service)]);
    if (!(await NativeSystemdPlatform.prototype.stopped.call(this, service)))
      throw new ProvisionError("unit_not_stopped");
    return { unit: "stopped" };
  }
  async stopped(service) {
    if (process.getuid() !== 0) throw new ProvisionError("root_required");
    await protectedPath(this.unitRoot, "directory");
    let present = true;
    try {
      await this.preparedUnit(service);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      present = false;
    }
    const observation = parseUnitObservation(
      await run("/usr/bin/systemctl", [
        "show",
        this.unit(service),
        "--all",
        "--no-pager",
        "--property=LoadState,FragmentPath,ActiveState",
      ]),
    );
    if (!present) {
      if (
        observation.LoadState === "not-found" &&
        observation.FragmentPath === "" &&
        observation.ActiveState === "inactive"
      )
        return true;
      throw new ProvisionError("unit_conflict");
    }
    if (
      observation.LoadState !== "loaded" ||
      observation.FragmentPath !== path.join(this.unitRoot, this.unit(service))
    )
      throw new ProvisionError("unit_conflict");
    return ["inactive", "failed"].includes(observation.ActiveState);
  }
  removeAccount(service) {
    return this.accounts.remove(service);
  }
}
export { parseUnitObservation } from "./unit-observation.mjs";
