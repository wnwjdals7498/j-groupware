import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolConfig } from "pg";
const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  if (!value || value.startsWith("__PLACEHOLDER_"))
    throw new Error("External console configuration required.");
  return value;
};
const port = (value: string) => {
  const n = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || n > 65535 || n === 3001)
    throw new Error("Invalid console port.");
  return n;
};
const external = (value: string) => {
  if (
    !path.isAbsolute(value) ||
    !path.relative(checkout, value).startsWith(".." + path.sep)
  )
    throw new Error("Console secrets must remain outside checkout.");
  return value;
};
export function loadConsoleDatabase(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  if (
    (env.JGC_DB_NAME && env.JGC_DB_NAME !== "jgw_console") ||
    (env.JGC_DB_USER && env.JGC_DB_USER !== "jgw_console")
  )
    throw new Error("Dedicated console database required.");
  return {
    host: env.JGC_DB_HOST ?? "127.0.0.1",
    port: port(env.JGC_DB_PORT ?? "55052"),
    database: "jgw_console",
    user: "jgw_console",
    password: required(env, "JGC_DB_PASSWORD"),
    max: 10,
    statement_timeout: 5000,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    application_name: "j-console",
  };
}
export function loadConsoleConfig(env: NodeJS.ProcessEnv = process.env) {
  const origin = new URL(required(env, "JGC_PUBLIC_ORIGIN")),
    keycloak = new URL(required(env, "KC_PUBLIC_URL"));
  for (const url of [origin, keycloak])
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.port === "3001"
    )
      throw new Error("Registered HTTPS console origin required.");
  if (
    origin.hostname !== "console.jgw.test" ||
    !keycloak.hostname.endsWith(".jgw.test")
  )
    throw new Error("Unexpected console hostname.");
  const listen = port(env.JGC_PORT ?? "55053");
  if (Number(origin.port || 443) !== listen)
    throw new Error("Console origin and listener must match.");
  return {
    tenant: "operator",
    origin: origin.origin,
    keycloakOrigin: keycloak.origin,
    clientSecret: required(env, "JGC_CLIENT_SECRET"),
    port: listen,
    database: loadConsoleDatabase(env),
    tlsCertificate: external(required(env, "JGC_TLS_CERTIFICATE")),
    tlsKey: external(required(env, "JGC_TLS_KEY")),
  };
}
