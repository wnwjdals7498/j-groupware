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
import { execute, externalPath } from "../gateway/gateway.mjs";
import { ProvisionError, serviceDatabase } from "./service-database.mjs";
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
  return `[Unit]\nDescription=J Groupware ${service}\nAfter=network.target postgresql.service\n\n[Service]\nType=simple\nUser=${user(service)}\nGroup=${user(service)}\nWorkingDirectory=${bundleRoot}/${service}\nEnvironmentFile=${environmentRoot}/${service}.env\nExecStart=/usr/bin/node ${bundleRoot}/${service}/apps/server/dist/main.js\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\nPrivateTmp=true\nNoNewPrivileges=${service === "j-web" ? "false" : "true"}\n\n[Install]\nWantedBy=multi-user.target\n`;
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
    const metadataFile = path.join(root, "jgw-bundle.json");
    await protectedPath(metadataFile, "file");
    if ((await lstat(metadataFile)).size > 8192)
      throw new ProvisionError("unsafe_bundle");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
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
  async install(service) {
    await this.preflight(service);
    await this.preparedEnvironment(service);
    const name = user(service);
    let existing;
    try {
      existing = (await run("/usr/bin/getent", ["passwd", name]))
        .trim()
        .split(":");
    } catch {}
    if (existing) {
      if (
        existing[0] !== name ||
        existing[5] !== "/var/lib/" + name ||
        existing[6] !== "/usr/sbin/nologin"
      )
        throw new ProvisionError("unmanaged_service_account");
    } else
      await run("/usr/sbin/useradd", [
        "--system",
        "--user-group",
        "--no-create-home",
        "--home-dir",
        "/var/lib/" + name,
        "--shell",
        "/usr/sbin/nologin",
        "--",
        name,
      ]);
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
    await run("/usr/bin/systemctl", ["enable", "--now", this.unit(service)]);
  }
  async ready(service) {
    await run("/usr/bin/systemctl", [
      "is-active",
      "--quiet",
      this.unit(service),
    ]);
    if ((await this.probe(service)) !== true)
      throw new ProvisionError("service_not_ready");
  }
  async stop(service) {
    if (process.getuid() !== 0) throw new ProvisionError("root_required");
    await run("/usr/bin/systemctl", ["disable", "--now", this.unit(service)]);
  }
}
