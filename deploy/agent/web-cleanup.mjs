import { spawn } from "node:child_process";
import {
  lstat,
  realpath,
  readdir,
  open,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ProvisionError } from "./provision-error.mjs";

const binary = "/usr/local/sbin/jweb-helper";
// The installer runs as root after stop/dump/NOLOGIN. This capability exposes
// only the helper's backed-up remove-all operation, never purge or arbitrary OS commands.
export class WebServiceCleanup {
  constructor(retention) {
    if (
      retention !== undefined &&
      (!retention ||
        Object.keys(retention).sort().join() !==
          ["tenant", "stateRoot", "stopped", "maxBytes", "maxEntries"]
            .sort()
            .join() ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(retention.tenant) ||
        typeof retention.stopped !== "function" ||
        typeof retention.stateRoot !== "string" ||
        !retention.stateRoot.startsWith("/") ||
        path.resolve(retention.stateRoot) !== retention.stateRoot ||
        !Number.isSafeInteger(retention.maxBytes) ||
        retention.maxBytes < 1 ||
        retention.maxBytes > 20 * 1024 ** 3 ||
        !Number.isSafeInteger(retention.maxEntries) ||
        retention.maxEntries < 1 ||
        retention.maxEntries > 100000)
    )
      throw new ProvisionError("invalid_web_retention");
    this.retention = retention;
  }
  async helper(action) {
    if (process.getuid() !== 0) throw new ProvisionError("root_required");
    for (let file = binary; file !== "/"; file = path.dirname(file)) {
      const info = await lstat(file);
      if (
        info.uid !== 0 ||
        info.mode & 0o022 ||
        info.isSymbolicLink() ||
        (await realpath(file)) !== file ||
        (file === binary
          ? !info.isFile() || !(info.mode & 0o111) || info.size > 262144
          : !info.isDirectory())
      )
        throw new ProvisionError("unsafe_web_helper");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [action], {
        detached: true,
        shell: false,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const maximum = this.retention ? 1024 * 1024 : 8192;
      const chunks = [];
      let size = 0,
        timedOut = false,
        stopFailed = false;
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") stopFailed = true;
          }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, 60000);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > maximum) kill();
        else chunks.push(chunk);
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new ProvisionError("web_cleanup_failed"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        kill();
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (
            code !== 0 ||
            timedOut ||
            stopFailed ||
            size > maximum ||
            value?.ok !== true ||
            !Number.isInteger(value.removed) ||
            value.removed < 0
          )
            throw new Error();
          resolve(value);
        } catch {
          reject(new ProvisionError("web_cleanup_failed"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end("{}");
    });
  }

  async quiescent() {
    if (!this.retention || process.getuid() !== 0)
      throw new ProvisionError(
        this.retention
          ? "root_required"
          : "retained_cleanup_verification_unbound",
      );
    if ((await this.retention.stopped("j-web")) !== true)
      throw new ProvisionError("web_writer_active");
  }
  async retainedIds() {
    const result = await this.helper("retained-state");
    const uuid = "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}";
    if (
      result.tenant !== this.retention.tenant ||
      !Array.isArray(result.backups) ||
      result.backups.some(
        (id) =>
          typeof id !== "string" ||
          !new RegExp("^" + uuid + "-" + uuid + "$").test(id),
      ) ||
      result.backups.length !== new Set(result.backups).size ||
      result.backups.length > this.retention.maxEntries
    )
      throw new ProvisionError("invalid_web_retention");
    return result.backups.sort();
  }
  async trusted(target, file = false) {
    for (let value = target; value !== "/"; value = path.dirname(value)) {
      const info = await lstat(value);
      if (
        info.uid !== 0 ||
        info.mode & 0o022 ||
        info.isSymbolicLink() ||
        (await realpath(value)) !== value ||
        (value === target && file
          ? !info.isFile() || info.nlink !== 1
          : !info.isDirectory())
      )
        throw new ProvisionError("unsafe_web_retention");
    }
  }
  async snapshot(databaseBackup) {
    const ids = await this.retainedIds(),
      entries = [],
      budget = { bytes: 0, entries: 0 };
    const same = (a, b) =>
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs;
    const visit = async (target, relative) => {
      const before = await lstat(target);
      if (
        ++budget.entries > this.retention.maxEntries ||
        before.isSymbolicLink() ||
        before.mode & 0o022 ||
        (!before.isDirectory() && (!before.isFile() || before.nlink !== 1))
      )
        throw new ProvisionError("unsafe_web_retention");
      const record = {
        path: relative,
        uid: before.uid,
        gid: before.gid,
        mode: before.mode & 0o777,
        directory: before.isDirectory(),
      };
      if (before.isDirectory()) {
        entries.push(record);
        for (const child of (await readdir(target)).sort()) {
          if (/[\\\x00-\x1f\x7f]/.test(child))
            throw new ProvisionError("unsafe_web_retention");
          await visit(target + "/" + child, relative + "/" + child);
        }
      } else {
        const file = await open(
            target,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          ),
          hash = createHash("sha256");
        let bytes = 0;
        try {
          if (!same(before, await file.stat()))
            throw new ProvisionError("web_storage_changed");
          const buffer = Buffer.alloc(128 * 1024);
          for (;;) {
            const result = await file.read(buffer, 0, buffer.length, null);
            if (!result.bytesRead) break;
            bytes += result.bytesRead;
            budget.bytes += result.bytesRead;
            if (budget.bytes > this.retention.maxBytes)
              throw new ProvisionError("web_backup_limit");
            hash.update(buffer.subarray(0, result.bytesRead));
          }
          if (bytes !== before.size || !same(before, await file.stat()))
            throw new ProvisionError("web_storage_changed");
          entries.push({ ...record, bytes, sha256: hash.digest("hex") });
        } finally {
          await file.close();
        }
      }
      if (!same(before, await lstat(target)))
        throw new ProvisionError("web_storage_changed");
    };
    for (const id of ids) {
      const root = "/srv/jweb/backups/" + id;
      await this.trusted(root);
      if ((await lstat(root)).mode & 0o077)
        throw new ProvisionError("unsafe_web_retention");
      await visit(root, id);
    }
    if (databaseBackup) {
      if (
        typeof databaseBackup !== "string" ||
        path.resolve(databaseBackup) !== databaseBackup
      )
        throw new ProvisionError("invalid_web_retention");
      await this.trusted(databaseBackup, true);
      if ((await lstat(databaseBackup)).mode & 0o077)
        throw new ProvisionError("unsafe_web_retention");
      await visit(databaseBackup, "database.dump");
    }
    return {
      format: 1,
      tenant: this.retention.tenant,
      ids,
      databaseBackup: databaseBackup ?? null,
      entries,
    };
  }
  async run(service, { databaseBackup } = {}) {
    if (service !== "j-web")
      throw new ProvisionError("cleanup_adapter_unbound");
    if (this.retention) await this.quiescent();
    const result = await this.helper("remove-all");
    if (!this.retention) return { service, removed: result.removed };
    await this.quiescent();
    const first = await this.snapshot(databaseBackup),
      text = JSON.stringify(first) + "\n";
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw new ProvisionError("web_backup_limit");
    await mkdir(this.retention.stateRoot, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.trusted(this.retention.stateRoot);
    if ((await lstat(this.retention.stateRoot)).mode & 0o077)
      throw new ProvisionError("unsafe_web_retention");
    const receipt = this.retention.stateRoot + "/web-retained.json";
    if (JSON.stringify(await this.snapshot(databaseBackup)) + "\n" !== text)
      throw new ProvisionError("web_storage_changed");
    await this.quiescent();
    try {
      await writeFile(receipt, text, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await this.verifyRetained(service, {
        databaseBackup,
        storageBackup: receipt,
      });
    }
    return {
      service,
      removed: result.removed,
      storageBackup: receipt,
      data: "retained",
    };
  }
  async verifyRetained(service, { databaseBackup, storageBackup } = {}) {
    if (service !== "j-web")
      throw new ProvisionError("cleanup_adapter_unbound");
    await this.quiescent();
    const receipt = this.retention.stateRoot + "/web-retained.json";
    if (storageBackup !== receipt)
      throw new ProvisionError("web_retention_conflict");
    await this.trusted(receipt, true);
    const file = await open(receipt, constants.O_RDONLY | constants.O_NOFOLLOW);
    let recorded;
    try {
      const info = await file.stat();
      if (info.mode & 0o077 || info.size > 16 * 1024 * 1024)
        throw new ProvisionError("unsafe_web_retention");
      recorded = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    if (recorded !== JSON.stringify(await this.snapshot(databaseBackup)) + "\n")
      throw new ProvisionError("web_retention_conflict");
    await this.quiescent();
    return { service, storageBackup: receipt, data: "retained" };
  }
}
