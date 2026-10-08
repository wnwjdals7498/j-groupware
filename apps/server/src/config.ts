import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolConfig } from "pg";
import { assertCustomerTenantId } from "@j-auth/contracts";

export interface ServerConfig {
  readonly tenant: string;
  readonly origin: string;
  readonly keycloakOrigin: string;
  readonly clientSecret: string;
  readonly port: number;
  readonly tlsCertificate: string;
  readonly tlsKey: string;
  readonly database: PoolConfig;
}
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value || value.startsWith("__PLACEHOLDER_"))
    throw new Error(`Set ${name} in external env.`);
  return value;
};
const port = (raw: string): number => {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > 65535 || value === 3001)
    throw new Error("Invalid or reserved port.");
  return value;
};
function externalFile(value: string): string {
  const relative = path.relative(repository, value);
  if (
    !path.isAbsolute(value) ||
    (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  )
    throw new Error("TLS files must be outside checkout.");
  return value;
}
function origin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port === "3001"
  )
    throw new Error("Require an HTTPS origin.");
  return url;
}
export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  if (
    (env.JGW_DB_NAME && env.JGW_DB_NAME !== "jgw_groupware") ||
    (env.JGW_DB_USER && env.JGW_DB_USER !== "jgw_groupware")
  )
    throw new Error(
      "Use the dedicated non-superuser jgw_groupware database and role.",
    );
  return {
    host: env.JGW_DB_HOST ?? "127.0.0.1",
    port: port(env.JGW_DB_PORT ?? "54232"),
    database: "jgw_groupware",
    user: "jgw_groupware",
    password: required(env, "JGW_DB_PASSWORD"),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    application_name: "j-groupware",
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const tenant = required(env, "JGW_TENANT");
  assertCustomerTenantId(tenant);
  const publicOrigin = origin(required(env, "JGW_PUBLIC_ORIGIN"));
  if (publicOrigin.hostname !== `gw.${tenant}.jgw.test`)
    throw new Error("Public origin must match registered tenant.");
  const keycloakOrigin = origin(required(env, "KC_PUBLIC_URL"));
  return {
    tenant,
    origin: publicOrigin.origin,
    keycloakOrigin: keycloakOrigin.origin,
    clientSecret: required(env, "JGW_CLIENT_SECRET"),
    port: port(env.JGW_PORT ?? "54233"),
    tlsCertificate: externalFile(required(env, "JGW_TLS_CERTIFICATE")),
    tlsKey: externalFile(required(env, "JGW_TLS_KEY")),
    database: loadDatabaseConfig(env),
  };
}
