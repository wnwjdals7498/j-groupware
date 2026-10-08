import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolConfig } from "pg";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { SERVICE_CATALOG } from "@j-auth/contracts";
import type { TenantServiceId } from "@j-auth/contracts";
import { serviceOrigin } from "./services.js";
import type { ServiceEndpoints } from "./services.js";
import { memberAuthOrigin } from "./members.js";
import type { NotificationKeyHashes } from "@j-groupware/permissions/notifications";

export interface ServerConfig {
  readonly tenant: string;
  readonly origin: string;
  readonly keycloakOrigin: string;
  readonly clientSecret: string;
  readonly port: number;
  readonly tlsCertificate: string;
  readonly tlsKey: string;
  readonly database: PoolConfig;
  readonly serviceEndpoints: ServiceEndpoints;
  readonly authOrigin: string;
  readonly serviceKey: string;
  readonly notificationReceiver?: { port: number } & (
    | { mode: "static"; keyHashes: NotificationKeyHashes }
    | { mode: "projection" }
  );
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
  const registryMode = env.JGW_NOTIFICATION_REGISTRY_MODE ?? "static";
  if (
    !["static", "projection"].includes(registryMode) ||
    (registryMode === "projection" &&
      (!env.JGW_INTERNAL_NOTIFICATIONS_PORT ||
        env.JGW_NOTIFICATION_SERVICE_KEY_HASHES !== undefined))
  )
    throw new Error(
      "Projection mode requires a private listener and forbids static key configuration.",
    );
  const tenant = required(env, "JGW_TENANT");
  assertCustomerTenantId(tenant);
  const publicOrigin = origin(required(env, "JGW_PUBLIC_ORIGIN"));
  if (publicOrigin.hostname !== `gw.${tenant}.jgw.test`)
    throw new Error("Public origin must match registered tenant.");
  const keycloakOrigin = origin(required(env, "KC_PUBLIC_URL"));
  const serviceEndpoints: ServiceEndpoints = {};
  for (const service of SERVICE_CATALOG.filter(
    (entry) => entry.tenantService && entry.serviceId !== "j-groupware",
  )) {
    const value =
      env[
        "JGW_SERVICE_" +
          service.serviceId.slice(2).replaceAll("-", "_").toUpperCase() +
          "_URL"
      ];
    if (value)
      serviceEndpoints[service.serviceId as TenantServiceId] =
        serviceOrigin(value);
  }
  return {
    tenant,
    origin: publicOrigin.origin,
    keycloakOrigin: keycloakOrigin.origin,
    clientSecret: required(env, "JGW_CLIENT_SECRET"),
    port: port(env.JGW_PORT ?? "54233"),
    tlsCertificate: externalFile(required(env, "JGW_TLS_CERTIFICATE")),
    tlsKey: externalFile(required(env, "JGW_TLS_KEY")),
    database: loadDatabaseConfig(env),
    serviceEndpoints,
    authOrigin: memberAuthOrigin(required(env, "JAUTH_PUBLIC_URL")),
    serviceKey: required(env, "JGW_SERVICE_KEY"),
    ...(env.JGW_INTERNAL_NOTIFICATIONS_PORT
      ? {
          notificationReceiver: {
            port: port(env.JGW_INTERNAL_NOTIFICATIONS_PORT),
            ...(registryMode === "projection"
              ? { mode: "projection" as const }
              : {
                  mode: "static" as const,
                  keyHashes: JSON.parse(
                    required(env, "JGW_NOTIFICATION_SERVICE_KEY_HASHES"),
                  ) as NotificationKeyHashes,
                }),
          },
        }
      : {}),
  };
}
