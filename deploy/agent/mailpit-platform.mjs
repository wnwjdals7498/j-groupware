import { lstat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { MAILPIT_IMAGE, mailpitEnvironment } from "@j-mail/contracts";
import { execute, externalPath } from "../gateway/gateway.mjs";
import { privateDirectory } from "./private-files.mjs";
import { protectedStoragePath, storageAccount } from "./product-storage.mjs";
import { readControlFile } from "./control-files.mjs";
import { ProvisionError } from "./provision-error.mjs";

const fail = (code = "unmanaged_mailpit") => {
  throw new ProvisionError(code);
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const equal = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sorted = (values) => [...values].sort();
const object = (value) =>
  Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
async function free(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(new ProvisionError("mailpit_port_occupied")),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

// Owns only a fixed tenant container, fixed capture profile and one owned bind.
// Loading this class never pulls an image, starts a container or creates a file.
export class MailpitPlatform {
  constructor({
    tenant,
    dataRoot,
    environmentRoot,
    smtpPort,
    httpPort,
    binary = "/usr/bin/docker",
  }) {
    assertCustomerTenantId(tenant);
    for (const value of [dataRoot, environmentRoot, binary])
      externalPath(value);
    for (const value of [smtpPort, httpPort])
      if (
        !Number.isInteger(value) ||
        value < 1 ||
        value > 65535 ||
        value === 3001
      )
        fail("invalid_mailpit_profile");
    this.variables = mailpitEnvironment(tenant, {
      database: "/data/mailpit.db",
      smtp: "127.0.0.1:" + smtpPort,
      http: "127.0.0.1:" + httpPort,
    });
    Object.assign(this, {
      tenant,
      dataRoot,
      environmentRoot,
      smtpPort,
      httpPort,
      binary,
    });
    this.name = "jgw-mailpit-" + tenant;
    this.file = environmentRoot + "/mailpit.env";
    this.text = Object.entries(this.variables)
      .map(([key, value]) => key + "=" + value + "\n")
      .join("");
    this.labels = {
      "jgw.managed": "1",
      "jgw.tenant": tenant,
      "jgw.service": "j-mail",
      "jgw.format": "1",
    };
  }
  async command(args) {
    if (process.platform !== "linux" || process.getuid() !== 0)
      fail("root_required");
    await protectedStoragePath(this.binary, false);
    return execute(this.binary, args, { env, timeout: 45000 });
  }
  async image() {
    const rows = JSON.parse(
      await this.command(["image", "inspect", MAILPIT_IMAGE]),
    );
    const image = rows[0];
    if (
      rows.length !== 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(image?.Id) ||
      !image.RepoDigests?.includes(
        "axllent/mailpit@" + MAILPIT_IMAGE.split("@")[1],
      ) ||
      !equal(image.Config.Entrypoint, ["/mailpit"]) ||
      image.Config.Cmd != null
    )
      fail("mailpit_image_mismatch");
    return image;
  }
  async inspect() {
    // A successful empty listing alone means absent. Daemon errors remain failures.
    const id = (
      await this.command([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--quiet",
        "--filter",
        "name=^/" + this.name + "$",
      ])
    ).trim();
    if (!id) return null;
    if (!/^[a-f0-9]{64}$/.test(id)) fail();
    const rows = JSON.parse(await this.command(["container", "inspect", id]));
    const value = rows[0],
      image = await this.image(),
      actor = await storageAccount("j-mail");
    if (
      rows.length !== 1 ||
      value?.Id !== id ||
      value.Name !== "/" + this.name ||
      value.Image !== image.Id ||
      value.Config.Image !== MAILPIT_IMAGE ||
      value.Config.User !== actor.uid + ":" + actor.gid ||
      !equal(
        sorted(value.Config.Env),
        sorted([
          ...image.Config.Env,
          ...Object.entries(this.variables).map(
            ([key, text]) => key + "=" + text,
          ),
        ]),
      ) ||
      !equal(
        object(value.Config.Labels),
        object({ ...image.Config.Labels, ...this.labels }),
      ) ||
      !equal(value.Config.Entrypoint, ["/mailpit"]) ||
      value.Config.Cmd != null ||
      !equal(value.Config.Healthcheck, image.Config.Healthcheck) ||
      value.Path !== "/mailpit" ||
      !equal(value.Args, []) ||
      value.HostConfig.NetworkMode !== "host" ||
      !value.HostConfig.ReadonlyRootfs ||
      value.HostConfig.Privileged ||
      value.HostConfig.PidMode ||
      value.HostConfig.UTSMode ||
      value.HostConfig.Devices?.length ||
      value.HostConfig.VolumesFrom?.length ||
      (value.HostConfig.PortBindings &&
        Object.keys(value.HostConfig.PortBindings).length) ||
      !equal(value.HostConfig.CapDrop, ["ALL"]) ||
      value.HostConfig.CapAdd?.length ||
      !equal(value.HostConfig.SecurityOpt, ["no-new-privileges"]) ||
      value.HostConfig.LogConfig?.Type !== "none" ||
      value.HostConfig.RestartPolicy?.Name !== "no" ||
      !equal(value.HostConfig.Tmpfs, {
        "/tmp": "rw,noexec,nosuid,size=16m,mode=1777",
      }) ||
      value.Mounts?.length !== 1 ||
      value.Mounts[0].Type !== "bind" ||
      value.Mounts[0].Source !== this.dataRoot ||
      value.Mounts[0].Destination !== "/data" ||
      value.Mounts[0].RW !== true ||
      value.Mounts[0].Propagation !== "rprivate" ||
      value.State?.Paused ||
      value.State?.Restarting ||
      value.State?.Dead
    )
      fail();
    if ((await readControlFile(this.file)) !== this.text)
      fail("mailpit_environment_conflict");
    return { id, running: value.State.Running === true };
  }
  async storage() {
    await protectedStoragePath(
      this.dataRoot.slice(0, this.dataRoot.lastIndexOf("/")),
      true,
      true,
    );
    const actor = await storageAccount("j-mail"),
      info = await lstat(this.dataRoot);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== actor.uid ||
      info.gid !== actor.gid ||
      info.mode & 0o077
    )
      fail("unsafe_product_storage");
    return actor;
  }
  async start() {
    const previous = await this.inspect();
    await this.storage();
    if (previous?.running) {
      await this.ready();
      return { container: "running", changed: false };
    }
    await free(this.smtpPort);
    await free(this.httpPort);
    let id = previous?.id;
    if (!id) {
      await this.image(); // Installed pinned image only; never auto-pull.
      await privateDirectory(this.environmentRoot);
      try {
        if ((await readControlFile(this.file)) !== this.text)
          fail("mailpit_environment_conflict");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await writeFile(this.file, this.text, { flag: "wx", mode: 0o600 });
      }
      const actor = await this.storage();
      id = (
        await this.command([
          "container",
          "create",
          "--name",
          this.name,
          "--network",
          "host",
          "--user",
          actor.uid + ":" + actor.gid,
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--log-driver",
          "none",
          "--restart",
          "no",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
          "--mount",
          "type=bind,src=" + this.dataRoot + ",dst=/data",
          ...Object.entries(this.labels).flatMap(([key, value]) => [
            "--label",
            key + "=" + value,
          ]),
          "--env-file",
          this.file,
          MAILPIT_IMAGE,
        ])
      ).trim();
      const created = await this.inspect();
      if (!created || created.id !== id || created.running) fail();
    }
    await this.command(["container", "start", id]);
    const started = await this.inspect();
    if (!started || started.id !== id || !started.running)
      fail("mailpit_not_ready");
    await this.ready();
    return { container: "running", changed: true };
  }
  async ready() {
    const observed = await this.inspect();
    if (!observed?.running) fail("mailpit_not_ready");
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(
          "http://127.0.0.1:" + this.httpPort + "/readyz",
          {
            redirect: "error",
            signal: AbortSignal.timeout(500),
          },
        );
        await response.body?.cancel();
        if (response.status === 200) return true;
      } catch {}
      await delay(100);
    }
    fail("mailpit_not_ready");
  }
  async stop() {
    const observed = await this.inspect();
    if (!observed) return { container: "absent" };
    if (observed.running)
      await this.command(["container", "stop", "--time", "30", observed.id]);
    const stopped = await this.inspect();
    if (!stopped || stopped.id !== observed.id || stopped.running)
      fail("mailpit_writer_active");
    return { container: "stopped" };
  }
}
