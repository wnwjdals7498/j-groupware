import {
  lstat,
  mkdir,
  readdir,
  chmod,
  chown,
  open,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { externalPath, execute } from "../gateway/gateway.mjs";
import { readControlJson } from "./control-files.mjs";
import { privateDirectory } from "./private-files.mjs";
import { ProvisionError } from "./provision-error.mjs";

const CHILDREN = {
  "j-messenger": ["files", "tmp", "web-dist", "backups"],
  "j-mail": ["data"],
};
const STORED = { "j-messenger": ["files"], "j-mail": ["data"] };
const fail = (code = "unsafe_product_storage") => {
  throw new ProvisionError(code);
};
const same = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const inside = (a, b) => b === a || b.startsWith(a + "/");
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");
export async function protectedStoragePath(
  target,
  directory = true,
  traversable = false,
) {
  for (let current = target; current !== "/"; current = path.dirname(current)) {
    const info = await lstat(current);
    if (
      info.uid !== 0 ||
      info.isSymbolicLink() ||
      info.mode & 0o022 ||
      (current === target && !directory
        ? !info.isFile()
        : !info.isDirectory()) ||
      (traversable && !(info.mode & 0o001))
    )
      fail();
  }
}
export async function storageAccount(service) {
  if (!Object.hasOwn(CHILDREN, service)) fail("invalid_service");
  const name = "jgw-" + service.slice(2);
  let row;
  try {
    row = (
      await execute("/usr/bin/getent", ["passwd", name], {
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
      })
    )
      .trim()
      .split(":");
  } catch {
    fail("service_account_required");
  }
  if (
    row.length !== 7 ||
    row[0] !== name ||
    !/^[1-9][0-9]*$/.test(row[2]) ||
    !/^[1-9][0-9]*$/.test(row[3]) ||
    row[5] !== "/var/lib/" + name ||
    row[6] !== "/usr/sbin/nologin"
  )
    fail("unmanaged_service_account");
  return { uid: Number(row[2]), gid: Number(row[3]) };
}
async function regular(file, uid, maximum, destination) {
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== uid ||
    before.mode & 0o022 ||
    before.size > maximum
  )
    fail("unsafe_storage_file");
  const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target,
    bytes = 0;
  const hash = createHash("sha256");
  try {
    if (!same(before, await source.stat())) fail("storage_changed");
    if (destination) target = await open(destination, "wx", 0o600);
    const buffer = Buffer.alloc(128 * 1024);
    for (;;) {
      const result = await source.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > maximum) fail("storage_backup_limit");
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      if (target) {
        let offset = 0;
        while (offset < chunk.length)
          offset += (
            await target.write(chunk, offset, chunk.length - offset, null)
          ).bytesWritten;
      }
    }
    if (
      bytes !== before.size ||
      !same(before, await source.stat()) ||
      !same(before, await lstat(file))
    )
      fail("storage_changed");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await target?.close();
    await source.close();
  }
}
function relative(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("invalid_storage_manifest");
  return value;
}

// Root-only filesystem ownership and stopped-volume snapshots. The lifecycle
// owns the service stop and pg_dump; this adapter never queries product tables.
export class ProductStorage {
  constructor({ tenant, stateRoot, backupRoot, profiles, stopped, mailpit }) {
    assertCustomerTenantId(tenant);
    externalPath(stateRoot);
    externalPath(backupRoot);
    if (
      !profiles ||
      Array.isArray(profiles) ||
      typeof profiles !== "object" ||
      typeof stopped !== "function"
    )
      fail("storage_adapter_unbound");
    this.profiles = {};
    const roots = [stateRoot, backupRoot];
    for (const [service, profile] of Object.entries(profiles)) {
      if (
        !Object.hasOwn(CHILDREN, service) ||
        !keys(profile, ["root", "maxBytes", "maxEntries"]) ||
        !Number.isSafeInteger(profile.maxBytes) ||
        profile.maxBytes < 1 ||
        !Number.isSafeInteger(profile.maxEntries) ||
        profile.maxEntries < 1 ||
        profile.maxEntries > 100000
      )
        fail("invalid_storage_profile");
      const root = externalPath(profile.root);
      if (roots.some((other) => inside(root, other) || inside(other, root)))
        fail("overlapping_storage_roots");
      roots.push(root);
      this.profiles[service] = Object.freeze({ ...profile, root });
    }
    if (inside(stateRoot, backupRoot) || inside(backupRoot, stateRoot))
      fail("overlapping_storage_roots");
    if (this.profiles["j-mail"] && (!mailpit?.inspect || !mailpit?.stop))
      fail("mailpit_adapter_unbound");
    Object.assign(this, { tenant, stateRoot, backupRoot, stopped, mailpit });
  }
  profile(service) {
    if (!Object.hasOwn(this.profiles, service)) fail("storage_adapter_unbound");
    return this.profiles[service];
  }
  root() {
    if (process.platform !== "linux" || process.getuid() !== 0)
      fail("root_required");
  }
  file(service) {
    this.profile(service);
    return this.stateRoot + "/" + service + ".storage.json";
  }
  async record(service) {
    try {
      const value = await readControlJson(this.file(service), 8192),
        profile = this.profile(service);
      if (
        !keys(value, [
          "format",
          "tenant",
          "service",
          "root",
          "uid",
          "gid",
          "phase",
          "backup",
        ]) ||
        value.format !== 1 ||
        value.tenant !== this.tenant ||
        value.service !== service ||
        value.root !== profile.root ||
        !Number.isSafeInteger(value.uid) ||
        value.uid < 1 ||
        !Number.isSafeInteger(value.gid) ||
        value.gid < 1 ||
        !["preparing", "prepared", "retained"].includes(value.phase) ||
        (value.backup !== null && typeof value.backup !== "string")
      )
        fail("unmanaged_product_storage");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async write(service, value) {
    await privateDirectory(this.stateRoot);
    const temporary = this.file(service) + "." + randomUUID() + ".partial";
    try {
      await writeFile(temporary, JSON.stringify(value) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.file(service));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async inspect(service) {
    this.root();
    const profile = this.profile(service),
      value = await this.record(service);
    await protectedStoragePath(path.dirname(profile.root), true, true);
    let info;
    try {
      info = await lstat(profile.root);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!value) {
      if (info) fail("unmanaged_product_storage");
      return null;
    }
    const actor = await storageAccount(service);
    if (actor.uid !== value.uid || actor.gid !== value.gid)
      fail("storage_account_drift");
    if (!info && value.phase === "preparing") return value;
    if (
      !info?.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      !(value.phase === "retained" ? [0o700] : [0o700, 0o711]).includes(
        info.mode & 0o777,
      )
    )
      fail();
    for (const child of await readdir(profile.root)) {
      if (!CHILDREN[service].includes(child)) fail("unmanaged_product_storage");
      const part = await lstat(profile.root + "/" + child);
      if (
        !part.isDirectory() ||
        part.isSymbolicLink() ||
        part.uid !== value.uid ||
        part.gid !== value.gid ||
        part.mode & 0o077
      )
        fail();
    }
    if (
      value.phase !== "preparing" &&
      (await readdir(profile.root)).length !== CHILDREN[service].length
    )
      fail();
    return value;
  }
  async preflight(service) {
    const value = await this.inspect(service);
    if (
      service === "j-mail" &&
      (await this.mailpit.inspect()) !== null &&
      !value
    )
      fail("unmanaged_product_storage");
    return value;
  }
  async prepare(service) {
    const previous = await this.preflight(service),
      profile = this.profile(service);
    if (previous?.phase === "retained" || previous?.backup)
      fail("retained_storage_requires_review");
    if (previous?.phase === "prepared") {
      await chmod(profile.root, 0o711);
      return { service, storage: "prepared", changed: false };
    }
    const actor = await storageAccount(service),
      value = previous ?? {
        format: 1,
        tenant: this.tenant,
        service,
        root: profile.root,
        ...actor,
        phase: "preparing",
        backup: null,
      };
    if (!previous) await this.write(service, value);
    try {
      await mkdir(profile.root, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    for (const child of CHILDREN[service]) {
      const target = profile.root + "/" + child;
      try {
        await mkdir(target, { mode: 0o700 });
        await chown(target, actor.uid, actor.gid);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    await this.inspect(service);
    await chmod(profile.root, 0o711);
    value.phase = "prepared";
    await this.write(service, value);
    return { service, storage: "prepared", changed: true };
  }
  async quiescent(service) {
    if ((await this.stopped(service)) !== true) fail("storage_writer_active");
    if (service === "j-mail") {
      const observed = await this.mailpit.inspect();
      if (observed !== null && typeof observed?.running !== "boolean")
        fail("mailpit_adapter_unbound");
      if (observed?.running) fail("mailpit_writer_active");
    }
  }
  async walk(service, value, sourceRoot, destinationRoot) {
    const profile = this.profile(service),
      files = [],
      directories = [],
      budget = { bytes: 0, entries: 0 };
    const visit = async (name) => {
      relative(name);
      if (++budget.entries > profile.maxEntries) fail("storage_backup_limit");
      const source = sourceRoot + "/" + name,
        before = await lstat(source);
      if (
        before.isSymbolicLink() ||
        before.uid !== value.uid ||
        before.mode & 0o022
      )
        fail("unsafe_storage_file");
      if (before.isDirectory()) {
        directories.push(name);
        if (destinationRoot)
          await mkdir(destinationRoot + "/" + name, { mode: 0o700 });
        for (const child of (await readdir(source)).sort())
          await visit(name + "/" + child);
        if (!same(before, await lstat(source))) fail("storage_changed");
      } else {
        const result = await regular(
          source,
          value.uid,
          profile.maxBytes - budget.bytes,
          destinationRoot ? destinationRoot + "/" + name : undefined,
        );
        budget.bytes += result.bytes;
        files.push({ path: name, ...result });
      }
    };
    for (const name of STORED[service]) await visit(name);
    return { files, directories, bytes: budget.bytes };
  }
  async verify(service, destination, databaseBackup) {
    this.root();
    const profile = this.profile(service);
    if (
      path.dirname(destination) !== this.backupRoot ||
      !new RegExp("^" + service + "-[a-f0-9-]{36}$").test(
        path.basename(destination),
      )
    )
      fail("invalid_storage_manifest");
    await privateDirectory(this.backupRoot);
    await protectedStoragePath(destination);
    if ((await lstat(destination)).mode & 0o077) fail("unsafe_storage_backup");
    const manifest = await readControlJson(
      destination + "/manifest.json",
      16 * 1024 * 1024,
    );
    if (
      !keys(manifest, [
        "format",
        "tenant",
        "service",
        "root",
        "database",
        "files",
        "directories",
      ]) ||
      manifest.format !== 1 ||
      manifest.tenant !== this.tenant ||
      manifest.service !== service ||
      manifest.root !== profile.root ||
      !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.directories) ||
      manifest.files.length + manifest.directories.length > profile.maxEntries
    )
      fail("invalid_storage_manifest");
    if (databaseBackup) {
      if (
        !keys(manifest.database, ["source", "bytes", "sha256"]) ||
        manifest.database.source !== databaseBackup
      )
        fail("storage_backup_conflict");
      await protectedStoragePath(databaseBackup, false);
      if ((await lstat(databaseBackup)).mode & 0o077)
        fail("unsafe_storage_backup");
      const original = await regular(databaseBackup, 0, profile.maxBytes),
        saved = await regular(
          destination + "/database.dump",
          0,
          profile.maxBytes,
        );
      if (
        JSON.stringify(original) !== JSON.stringify(saved) ||
        original.bytes !== manifest.database.bytes ||
        original.sha256 !== manifest.database.sha256
      )
        fail("storage_backup_corrupt");
    } else if (manifest.database !== null) fail("storage_backup_conflict");
    const names = new Set(),
      expected = new Set([
        "manifest.json",
        "files",
        ...(databaseBackup ? ["database.dump"] : []),
      ]);
    let bytes = manifest.database?.bytes ?? 0;
    for (const name of manifest.directories) {
      relative(name);
      if (
        names.has(name) ||
        !STORED[service].some((root) => inside(root, name))
      )
        fail("invalid_storage_manifest");
      names.add(name);
      const dir = destination + "/files/" + name;
      await protectedStoragePath(dir);
      if ((await lstat(dir)).mode & 0o077) fail("unsafe_storage_backup");
      expected.add("files/" + name);
    }
    for (const item of manifest.files) {
      if (!keys(item, ["path", "bytes", "sha256"]))
        fail("invalid_storage_manifest");
      relative(item.path);
      if (
        names.has(item.path) ||
        !STORED[service].some((root) => inside(root, item.path))
      )
        fail("invalid_storage_manifest");
      names.add(item.path);
      const result = await regular(
        destination + "/files/" + item.path,
        0,
        profile.maxBytes - bytes,
      );
      if (result.bytes !== item.bytes || result.sha256 !== item.sha256)
        fail("storage_backup_corrupt");
      if ((await lstat(destination + "/files/" + item.path)).mode & 0o077)
        fail("unsafe_storage_backup");
      bytes += result.bytes;
      expected.add("files/" + item.path);
    }
    const observed = new Set();
    const enumerate = async (root, prefix = "") => {
      for (const child of await readdir(root)) {
        const name = prefix + child,
          info = await lstat(root + "/" + child);
        if (info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o077)
          fail("unsafe_storage_backup");
        observed.add(name);
        if (info.isDirectory()) await enumerate(root + "/" + child, name + "/");
        else if (!info.isFile() || info.nlink !== 1)
          fail("unsafe_storage_backup");
      }
    };
    await enumerate(destination);
    if (
      observed.size !== expected.size ||
      [...observed].some((name) => !expected.has(name))
    )
      fail("storage_backup_corrupt");
    return {
      service,
      storageBackup: destination,
      bytes,
      files: manifest.files.length,
    };
  }
  async verifyRetained(service, { databaseBackup, storageBackup } = {}) {
    this.root();
    const value = await this.record(service),
      profile = this.profile(service);
    if (!value) {
      try {
        await lstat(profile.root);
        fail("unmanaged_product_storage");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (storageBackup) fail("storage_backup_conflict");
      await this.quiescent(service);
      return { service, data: "absent" };
    }
    if (
      value.phase !== "retained" ||
      !value.backup ||
      value.backup !== storageBackup
    )
      fail("storage_backup_conflict");
    await protectedStoragePath(profile.root, true);
    if (((await lstat(profile.root)).mode & 0o777) !== 0o700)
      fail("unsafe_storage_root");
    for (const child of await readdir(profile.root)) {
      if (!CHILDREN[service].includes(child)) fail("unmanaged_product_storage");
      const info = await lstat(profile.root + "/" + child);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== value.uid ||
        info.gid !== value.gid ||
        info.mode & 0o077
      )
        fail("unsafe_storage_file");
    }
    if ((await readdir(profile.root)).length !== CHILDREN[service].length)
      fail("unmanaged_product_storage");
    await this.quiescent(service);
    const result = await this.verify(service, value.backup, databaseBackup),
      manifest = await readControlJson(
        value.backup + "/manifest.json",
        16 * 1024 * 1024,
      ),
      original = await this.walk(service, value, profile.root);
    if (
      JSON.stringify(original.files) !== JSON.stringify(manifest.files) ||
      JSON.stringify(original.directories) !==
        JSON.stringify(manifest.directories)
    )
      fail("storage_changed");
    await this.quiescent(service);
    return result;
  }
  async run(service, { databaseBackup } = {}) {
    let value = await this.preflight(service);
    if (!value) return { service, data: "absent" };
    if (value.phase === "preparing") fail("storage_not_prepared");
    if (service === "j-mail") await this.mailpit.stop();
    await this.quiescent(service);
    if (!value.backup) {
      await privateDirectory(this.backupRoot);
      const destination = this.backupRoot + "/" + service + "-" + randomUUID();
      await mkdir(destination, { mode: 0o700 });
      const reservation = await lstat(destination);
      try {
        let database = null;
        if (databaseBackup) {
          externalPath(databaseBackup);
          await protectedStoragePath(databaseBackup, false);
          const stats = await lstat(databaseBackup);
          if (stats.mode & 0o077) fail("unsafe_storage_backup");
          database = {
            source: databaseBackup,
            ...(await regular(
              databaseBackup,
              0,
              this.profile(service).maxBytes,
              destination + "/database.dump",
            )),
          };
        }
        await mkdir(destination + "/files", { mode: 0o700 });
        const snapshot = await this.walk(
          service,
          value,
          value.root,
          destination + "/files",
        );
        if (
          snapshot.bytes + (database?.bytes ?? 0) >
          this.profile(service).maxBytes
        )
          fail("storage_backup_limit");
        await this.quiescent(service);
        const current = await this.walk(service, value, value.root);
        if (JSON.stringify(current) !== JSON.stringify(snapshot))
          fail("storage_changed");
        const manifest = {
          format: 1,
          tenant: this.tenant,
          service,
          root: value.root,
          database,
          files: snapshot.files,
          directories: snapshot.directories,
        };
        const serialized = JSON.stringify(manifest) + "\n";
        if (Buffer.byteLength(serialized) > 16 * 1024 * 1024)
          fail("storage_backup_limit");
        await writeFile(destination + "/manifest.json", serialized, {
          flag: "wx",
          mode: 0o600,
        });
        await this.verify(service, destination, databaseBackup);
        value.backup = destination;
        await this.write(service, value);
      } catch (error) {
        const current = await lstat(destination);
        const recorded = await this.record(service).catch(() => null);
        if (
          recorded?.backup !== destination &&
          current.uid === 0 &&
          current.ino === reservation.ino &&
          current.dev === reservation.dev
        )
          await rm(destination, { recursive: true, force: true });
        throw error;
      }
    }
    const result = await this.verify(service, value.backup, databaseBackup);
    await this.quiescent(service);
    await chmod(value.root, 0o700);
    value = { ...value, phase: "retained" };
    await this.write(service, value);
    return { ...result, data: "retained" };
  }
}
