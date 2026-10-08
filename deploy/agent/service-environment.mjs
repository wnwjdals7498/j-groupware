import { lstat, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProvisionError, serviceDatabase } from "./service-database.mjs";
import { externalPath } from "../gateway/gateway.mjs";
import { privateDirectory } from "./private-files.mjs";
// Product-specific env names are supplied by a trusted bundle adapter, never HTTP.
export class ServiceEnvironment {
  constructor({ root, backups, render, read }) {
    externalPath(root);
    externalPath(backups);
    if (typeof render !== "function" || typeof read !== "function")
      throw new ProvisionError("environment_adapter_required");
    Object.assign(this, { root, backups, render, decode: read });
  }
  file(service) {
    serviceDatabase(service);
    return path.join(this.root, service + ".env");
  }
  async directory(root) {
    await privateDirectory(root);
  }
  async prepare(service, generate) {
    await this.directory(this.root);
    const file = this.file(service);
    let value;
    try {
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        info.mode & 0o077 ||
        info.size > 32768
      )
        throw new ProvisionError("unsafe_environment_file");
      value = this.decode(service, await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      value = generate();
      this.validate(value, service);
      const text = this.render(service, value);
      if (
        typeof text !== "string" ||
        Buffer.byteLength(text) > 32768 ||
        /(?:^|\n)(?:NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|PATH|HOME|SHELLOPTS|BASH_ENV)=/.test(
          text,
        )
      )
        throw new ProvisionError("unsafe_environment_content");
      await writeFile(file, text, { flag: "wx", mode: 0o600 });
    }
    this.validate(value, service);
    return value;
  }
  validate(value, service) {
    if (
      !value ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.databasePassword) ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.notificationKey) ||
      (["j-messenger", "j-customer-auth-db"].includes(service) &&
        !/^[A-Za-z0-9_-]{43}$/.test(value.cursorSigningKey))
    )
      throw new ProvisionError("invalid_environment_secrets");
  }
  async remove(service) {
    await this.directory(this.root);
    const file = this.file(service);
    try {
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        info.mode & 0o077
      )
        throw new ProvisionError("unsafe_environment_file");
      await rm(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  async backupPath(service) {
    serviceDatabase(service);
    await this.directory(this.backups);
    return path.join(this.backups, service + "-" + randomUUID() + ".dump");
  }
}
