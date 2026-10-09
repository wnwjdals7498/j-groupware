import { readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { externalPath } from "../gateway/gateway.mjs";
import { DirectoryLock } from "./reconciler.mjs";
import { ProvisionError, serviceDatabase } from "./service-database.mjs";
import { privateDirectory } from "./private-files.mjs";
export class ServiceStateFiles {
  constructor(root, tenant) {
    this.root = externalPath(root);
    assertCustomerTenantId(tenant);
    this.tenant = tenant;
  }
  async directory() {
    await privateDirectory(this.root);
  }
  file(service) {
    serviceDatabase(service);
    return path.join(this.root, service + ".json");
  }
  async read(service) {
    await this.directory();
    try {
      const file = this.file(service),
        info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        info.mode & 0o077 ||
        info.size > 4096
      )
        throw new ProvisionError("unsafe_state_file");
      const value = JSON.parse(await readFile(file, "utf8"));
      if (
        value.tenant !== this.tenant ||
        value.service !== service ||
        !["installing", "active", "removing", "removed", "failed"].includes(
          value.status,
        ) ||
        typeof value.phase !== "string"
      )
        throw new ProvisionError("invalid_state");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async write(service, state) {
    await this.directory();
    const file = this.file(service),
      temporary = file + "." + randomUUID() + ".partial";
    try {
      await writeFile(
        temporary,
        JSON.stringify({ ...state, tenant: this.tenant, service }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
// Internal installer ports. Console bootstrap/desired/status wire contracts remain separate.
export class ServiceLifecycle {
  constructor({
    tenant,
    state,
    lock,
    database,
    platform,
    gateway,
    notifications,
    cleanup,
    environment,
  }) {
    assertCustomerTenantId(tenant);
    if (
      !state?.read ||
      !state?.write ||
      !database?.ensure ||
      !database?.inspect ||
      !database?.dump ||
      !database?.disable ||
      !platform?.preflight ||
      !platform?.install ||
      !platform?.start ||
      !platform?.ready ||
      !platform?.stop ||
      !gateway?.set ||
      !environment?.prepare ||
      !environment?.remove ||
      !environment?.backupPath ||
      !cleanup?.run
    )
      throw new ProvisionError("invalid_configuration");
    Object.assign(this, {
      tenant,
      state,
      lock: lock ?? new DirectoryLock(state.root),
      database,
      platform,
      gateway,
      notifications,
      cleanup,
      environment,
    });
  }
  async run(service, kind = "install") {
    serviceDatabase(service);
    if (service === "j-groupware" || !["install", "remove"].includes(kind))
      throw new ProvisionError("invalid_action");
    const release = await this.lock.acquire();
    if (!release) throw new ProvisionError("busy");
    let state,
      phase = "preflight";
    const record = async (status) => {
      state = { ...state, status, phase };
      if (["active", "removed"].includes(status)) delete state.error;
      await this.state.write(service, state);
    };
    try {
      state = (await this.state.read(service)) ?? {
        tenant: this.tenant,
        service,
      };
      if (kind === "install") {
        if (
          ["j-messenger", "j-mail"].includes(service) &&
          (!this.cleanup.preflight || !this.cleanup.prepare)
        )
          throw new ProvisionError("storage_adapter_unbound");
        if (
          state.status === "removed" ||
          (state.status === "failed" && state.action === "remove")
        )
          throw new ProvisionError("removed_database_requires_review");
        await this.platform.preflight(service);
        await this.cleanup.preflight?.(service);
        if (
          ["j-approval", "j-talk", "j-mail"].includes(service) &&
          !this.notifications?.register
        )
          throw new ProvisionError("notification_registration_unbound");
        state.action = "install";
        phase = "environment";
        await record("installing");
        const secrets = await this.environment.prepare(service, () => ({
          databasePassword: randomBytes(32).toString("base64url"),
          notificationKey: randomBytes(32).toString("base64url"),
          ...(["j-messenger", "j-customer-auth-db"].includes(service)
            ? { cursorSigningKey: randomBytes(32).toString("base64url") }
            : {}),
        }));
        phase = "database";
        await record("installing");
        await this.database.ensure(service, secrets.databasePassword);
        phase = "unit";
        await record("installing");
        await this.platform.install(service);
        if (["j-messenger", "j-mail"].includes(service)) {
          if (!this.cleanup.prepare)
            throw new ProvisionError("storage_adapter_unbound");
          phase = "storage";
          await record("installing");
          await this.cleanup.prepare(service);
        }
        phase = "start";
        await record("installing");
        await this.platform.start(service);
        await this.platform.ready(service);
        if (["j-approval", "j-talk", "j-mail"].includes(service)) {
          phase = "notification";
          await record("installing");
          await this.notifications.register(service, secrets.notificationKey);
        }
        phase = "gateway";
        await record("installing");
        await this.gateway.set(service, true);
        phase = "active";
        await record("active");
        return { tenant: this.tenant, service, status: "active" };
      }
      if (state.status === "removed")
        return { tenant: this.tenant, service, status: "removed" };
      if (
        ["j-messenger", "j-mail"].includes(service) &&
        !this.cleanup.preflight
      )
        throw new ProvisionError("storage_adapter_unbound");
      if (
        ["j-approval", "j-talk", "j-mail"].includes(service) &&
        !this.notifications?.remove
      )
        throw new ProvisionError("notification_registration_unbound");
      state.action = "remove";
      phase = "inspect";
      await record("removing");
      const allocation = await this.database.inspect(service);
      if (
        !allocation ||
        typeof allocation.role !== "boolean" ||
        typeof allocation.database !== "boolean" ||
        (allocation.database && !allocation.role)
      )
        throw new ProvisionError("invalid_database_allocation");
      state.allocation = {
        role: allocation.role,
        database: allocation.database,
      };
      await this.cleanup.preflight?.(service);
      phase = "stop";
      await record("removing");
      await this.platform.stop(service, { allowMissing: true });
      if (allocation.database && !state.backup) {
        phase = "dump";
        await record("removing");
        const destination = await this.environment.backupPath(service);
        await this.database.dump(service, destination);
        state.backup = destination;
        await record("removing");
      }
      phase = "disable";
      await record("removing");
      await this.database.disable(service, {
        expectDatabaseAbsent: !allocation.database,
      });
      phase = "cleanup";
      await record("removing");
      const cleaned = await this.cleanup.run(service, {
        databaseBackup: state.backup,
      });
      if (cleaned?.storageBackup) {
        state.storageBackup = cleaned.storageBackup;
        await record("removing");
      }
      if (["j-approval", "j-talk", "j-mail"].includes(service)) {
        phase = "notification_remove";
        await record("removing");
        await this.notifications.remove(service);
      }
      phase = "gateway";
      await record("removing");
      await this.gateway.set(service, false);
      phase = "environment_remove";
      await record("removing");
      await this.environment.remove(service);
      phase = "removed";
      await record("removed");
      return {
        tenant: this.tenant,
        service,
        status: "removed",
        backup: state.backup,
        ...(state.storageBackup ? { storageBackup: state.storageBackup } : {}),
      };
    } catch (error) {
      const code =
        error instanceof ProvisionError ? error.code : "provision_failed";
      if (state) {
        state.error = code;
        await record("failed").catch(() => {});
      }
      throw new ProvisionError(code);
    } finally {
      await release();
    }
  }
}
