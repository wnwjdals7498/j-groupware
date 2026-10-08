import { assertCustomerTenantId, SERVICE_CATALOG } from "@j-auth/contracts";
import { Pool } from "pg";
import { execute } from "../gateway/gateway.mjs";
import { externalPath } from "../gateway/gateway.mjs";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ProvisionError } from "./provision-error.mjs";
export { ProvisionError } from "./provision-error.mjs";
const DATABASES = Object.freeze({
  "j-groupware": "jgw_groupware",
  "j-approval": "jgw_approval",
  "j-messenger": "jgw_messenger",
  "j-customer-auth-db": "jgw_customer_auth",
  "j-talk": "jgw_talk",
  "j-mail": "jgw_mail",
  "j-web": "jgw_web",
});
const services = new Set(
  SERVICE_CATALOG.filter((value) => value.tenantService).map(
    (value) => value.serviceId,
  ),
);
export function serviceDatabase(service) {
  if (!services.has(service) || !DATABASES[service])
    throw new ProvisionError("invalid_service");
  return DATABASES[service];
}
const ident = (value) => '"' + value + '"';
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
export class PostgresServiceDatabase {
  constructor({
    admin,
    tenant,
    connection,
    dumpBinary = "/usr/bin/pg_dump",
    dumpEnv = {},
  }) {
    assertCustomerTenantId(tenant);
    if (!admin?.connect || typeof connection !== "function")
      throw new ProvisionError("invalid_configuration");
    externalPath(dumpBinary);
    if (
      Object.keys(dumpEnv).some(
        (key) =>
          ![
            "PGHOST",
            "PGPORT",
            "PGUSER",
            "PGPASSFILE",
            "PGSSLMODE",
            "PGSSLROOTCERT",
          ].includes(key),
      )
    )
      throw new ProvisionError("invalid_dump_environment");
    this.admin = admin;
    this.tenant = tenant;
    this.connection = connection;
    this.dumpBinary = dumpBinary;
    this.dumpEnv = dumpEnv;
  }
  marker(service) {
    serviceDatabase(service);
    return "jgw-managed:" + this.tenant + ":" + service;
  }
  async privileged(client) {
    const result = await client.query(
      "SELECT current_database() AS db,rolsuper FROM pg_roles WHERE rolname=current_user",
    );
    if (result.rows[0]?.db !== "postgres" || result.rows[0]?.rolsuper !== true)
      throw new ProvisionError("dedicated_admin_required");
  }
  async prepareBase() {
    const client = await this.admin.connect();
    try {
      await this.privileged(client);
      await client.query("BEGIN");
      await client.query(
        "REVOKE CONNECT,TEMPORARY ON DATABASE postgres FROM PUBLIC",
      );
      await client.query(
        "REVOKE CONNECT,TEMPORARY ON DATABASE template1 FROM PUBLIC",
      );
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      throw new ProvisionError("base_database_failed");
    } finally {
      client.release();
    }
  }
  async locked(service, operation) {
    const name = serviceDatabase(service);
    const client = await this.admin.connect();
    let locked = false,
      discard = false;
    try {
      await this.privileged(client);
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        "jgw-provision:" + name,
      ]);
      locked = true;
      return await operation(client, name);
    } catch (error) {
      if (error instanceof ProvisionError) throw error;
      throw new ProvisionError("service_database_failed");
    } finally {
      if (locked)
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            ["jgw-provision:" + name],
          );
        } catch {
          discard = true;
        }
      client.release(discard);
    }
  }
  async owned(client, name, service) {
    const role = (
      await client.query(
        "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin,shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
        [name],
      )
    ).rows[0];
    const database = (
      await client.query(
        "SELECT datname,pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
        [name],
      )
    ).rows[0];
    if (
      role &&
      (role.marker !== this.marker(service) ||
        role.rolsuper ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls)
    )
      throw new ProvisionError("unmanaged_role");
    if (
      database &&
      (database.owner !== name || database.marker !== this.marker(service))
    )
      throw new ProvisionError("unmanaged_database");
    return { role, database };
  }
  async ensure(service, password) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(password))
      throw new ProvisionError("invalid_database_secret");
    await this.locked(service, async (client, name) => {
      const { role, database } = await this.owned(client, name, service);
      const publicConnect = (
        await client.query(
          "SELECT EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname='postgres' AND a.grantee=0 AND a.privilege_type='CONNECT') AS allowed",
        )
      ).rows[0].allowed;
      if (publicConnect) throw new ProvisionError("base_database_not_prepared");
      if (database && role && !role.rolcanlogin)
        throw new ProvisionError("disabled_database_requires_review");
      if (!role) {
        await client.query("BEGIN");
        try {
          await client.query(
            `CREATE ROLE ${ident(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`,
          );
          await client.query(
            `COMMENT ON ROLE ${ident(name)} IS ${literal(this.marker(service))}`,
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      }
      if (!database) {
        await client.query(
          `CREATE DATABASE ${ident(name)} OWNER ${ident(name)} ALLOW_CONNECTIONS false`,
        );
        await client.query("BEGIN");
        try {
          await client.query(
            `COMMENT ON DATABASE ${ident(name)} IS ${literal(this.marker(service))}`,
          );
          await client.query(
            `REVOKE ALL ON DATABASE ${ident(name)} FROM PUBLIC`,
          );
          await client.query(
            `ALTER DATABASE ${ident(name)} ALLOW_CONNECTIONS true`,
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      }
      await client.query(`REVOKE ALL ON DATABASE ${ident(name)} FROM PUBLIC`);
    });
    const name = serviceDatabase(service),
      pool = new Pool({
        ...this.connection(name, password),
        database: name,
        user: name,
        password,
        max: 1,
      });
    pool.on("error", () => {});
    try {
      const result = await pool.query(
        "SELECT current_user,current_database() AS db",
      );
      if (result.rows[0]?.current_user !== name || result.rows[0]?.db !== name)
        throw new Error();
    } catch {
      throw new ProvisionError("service_database_login_failed");
    } finally {
      await pool.end();
    }
    return { database: name, user: name };
  }
  async dump(service, destination) {
    externalPath(destination);
    const directory = destination.slice(0, destination.lastIndexOf("/")),
      info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      info.mode & 0o077
    )
      throw new ProvisionError("unsafe_backup_directory");
    const temporary = destination + "." + randomUUID() + ".partial";
    try {
      try {
        await lstat(destination);
        throw new ProvisionError("backup_already_exists");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
      await this.locked(service, async (client, name) => {
        const { database } = await this.owned(client, name, service);
        if (!database) throw new ProvisionError("database_missing");
        await execute(
          this.dumpBinary,
          [
            "--format=custom",
            "--no-owner",
            "--no-acl",
            "--file=" + temporary,
            "--dbname=" + name,
          ],
          {
            env: { PATH: "/usr/bin:/bin", LANG: "C", ...this.dumpEnv },
            timeout: 180000,
          },
        );
      });
      const file = await lstat(temporary);
      if (!file.isFile() || file.isSymbolicLink() || file.size === 0)
        throw new Error();
      await rename(temporary, destination);
    } catch {
      throw new ProvisionError("database_backup_failed");
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async disable(service) {
    return this.locked(service, async (client, name) => {
      const { role, database } = await this.owned(client, name, service);
      if (!role || !database) throw new ProvisionError("database_missing");
      await client.query(`ALTER ROLE ${ident(name)} NOLOGIN`);
      await client.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()",
        [name],
      );
      return { database: name, login: false };
    });
  }
}
