import { assertCustomerTenantId } from "@j-auth/contracts";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { externalPath } from "../gateway/gateway.mjs";
import { DirectoryLock } from "./reconciler.mjs";
import { privateDirectory } from "./private-files.mjs";
import { ProvisionError } from "./service-database.mjs";

const services = ["j-approval", "j-talk", "j-mail"];
const validate = (value, tenant) => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "keys,revision,tenantId" ||
    value.tenantId !== tenant ||
    typeof value.revision !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value.revision) ||
    BigInt(value.revision) > 9223372036854775807n ||
    !value.keys ||
    typeof value.keys !== "object" ||
    Array.isArray(value.keys)
  )
    throw new ProvisionError("invalid_notification_manifest");
  for (const [service, entry] of Object.entries(value.keys))
    if (
      !services.includes(service) ||
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).join(",") !== "currentHash" ||
      typeof entry.currentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.currentHash)
    )
      throw new ProvisionError("invalid_notification_manifest");
  return value;
};
// Installer-owned hashes only. Key changes require a separate explicit rotation
// operation; retrying an install never silently replaces an existing key.
export class NotificationManifest {
  constructor({ root, tenant, projector }) {
    externalPath(root);
    assertCustomerTenantId(tenant);
    if (!projector?.reconcile)
      throw new ProvisionError("notification_projection_unbound");
    Object.assign(this, {
      root,
      tenant,
      projector,
      lock: new DirectoryLock(root),
    });
    this.file = path.join(root, "notification-keys.json");
  }
  async read() {
    await privateDirectory(this.root);
    try {
      const info = await lstat(this.file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        info.mode & 0o077 ||
        info.size > 8192
      )
        throw new ProvisionError("unsafe_notification_manifest");
      return validate(
        JSON.parse(await readFile(this.file, "utf8")),
        this.tenant,
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async write(value) {
    validate(value, this.tenant);
    const temporary = this.file + "." + randomUUID() + ".partial";
    try {
      await writeFile(temporary, JSON.stringify(value) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async update(service, key, signal) {
    if (service !== undefined && !services.includes(service))
      throw new ProvisionError("invalid_service");
    if (
      key !== undefined &&
      (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key))
    )
      throw new ProvisionError("invalid_environment_secrets");
    signal?.throwIfAborted();
    await privateDirectory(this.root);
    const release = await this.lock.acquire();
    if (!release) throw new ProvisionError("busy");
    try {
      let manifest = await this.read(),
        changed = false;
      if (!manifest) {
        manifest = { tenantId: this.tenant, revision: "1", keys: {} };
        changed = true;
      }
      const hash =
        key === undefined
          ? undefined
          : createHash("sha256").update(key).digest("hex");
      if (service !== undefined) {
        const previous = manifest.keys[service]?.currentHash;
        if (previous && hash && previous !== hash)
          throw new ProvisionError("notification_key_conflict");
        if (previous !== hash) {
          if (!changed)
            manifest.revision = (BigInt(manifest.revision) + 1n).toString();
          if (hash) manifest.keys[service] = { currentHash: hash };
          else delete manifest.keys[service];
          changed = true;
        }
      }
      if (changed) await this.write(manifest);
      // Durable intent precedes actual subscription projection. On upstream
      // failure the same revision/hash is retried, never invented as success.
      try {
        await this.projector.reconcile(structuredClone(manifest), signal);
      } catch {
        throw new ProvisionError("notification_projection_failed");
      }
      return { tenant: this.tenant, revision: manifest.revision };
    } finally {
      await release();
    }
  }
  async register(service, key, signal) {
    if (
      !services.includes(service) ||
      typeof key !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key)
    )
      throw new ProvisionError("invalid_environment_secrets");
    return this.update(service, key, signal);
  }
  async remove(service, signal) {
    if (!services.includes(service))
      throw new ProvisionError("invalid_service");
    return this.update(service, undefined, signal);
  }
  refresh(signal) {
    return this.update(undefined, undefined, signal);
  }
}
