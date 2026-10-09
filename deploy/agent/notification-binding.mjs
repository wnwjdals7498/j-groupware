import { parseEnv } from "node:util";
import { Pool } from "pg";
import { FileSubscriptionCredentials } from "./subscription-credentials.mjs";
import { readControlFile } from "./control-files.mjs";
import { ProvisionError } from "./provision-error.mjs";
import { externalPath } from "../gateway/gateway.mjs";

const owned = new WeakSet();
const fail = (code) => {
  throw new ProvisionError(code);
};
export const isNotificationInstallerBinding = (value) => owned.has(value);
// Explicit prepared-input adapter. It neither issues/refreshes operator credentials
// nor selects an operating owner/topology, and the fixed native CLI stays unbound.
export async function loadNotificationInstallerBinding({
  controlFile,
  tenant,
  databasePort,
  baseEnvironmentFile,
  authOrigin,
  fetch,
}) {
  externalPath(controlFile);
  externalPath(baseEnvironmentFile);
  const { Agent, fetch: undiciFetch } = await import("undici");
  const { AuthSubscriptionReader } =
    await import("../../apps/server/dist/notification-projection.js");
  const { loadNotificationControl, createNotificationRuntime } =
    await import("./notification-worker.mjs");
  const config = await loadNotificationControl(controlFile);
  if (
    config.tenant !== tenant ||
    config.connection.port !== databasePort ||
    config.authOrigin !== authOrigin
  )
    fail("notification_binding_mismatch");
  for (const file of [
    controlFile,
    baseEnvironmentFile,
    config.caFile,
    config.credentialsFile,
    config.databaseFile,
  ])
    if (
      file === config.manifestRoot ||
      file.startsWith(config.manifestRoot + "/")
    )
      fail("overlapping_notification_control");
  const anchor = async () => {
    const text = await readControlFile(baseEnvironmentFile),
      value = parseEnv(text);
    if (
      value.JGW_TENANT !== tenant ||
      value.JGW_DB_HOST !== "127.0.0.1" ||
      value.JGW_DB_PORT !== String(databasePort) ||
      value.JGW_DB_NAME !== "jgw_groupware" ||
      value.JGW_DB_USER !== "jgw_groupware" ||
      value.JGW_DB_PASSWORD !== config.connection.password ||
      value.JAUTH_PUBLIC_URL !== authOrigin
    )
      fail("notification_binding_mismatch");
  };
  await anchor();
  const pool = new Pool(config.connection),
    agent = new Agent({
      connect: {
        ca: config.ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
    });
  pool.on("error", () => {});
  const transport =
    fetch ??
    ((input, init) =>
      undiciFetch(String(input), { ...init, dispatcher: agent }));
  const runtime = createNotificationRuntime({
    tenant,
    pool,
    authOrigin,
    credentialsFile: config.credentialsFile,
    manifestRoot: config.manifestRoot,
    fetch: transport,
  });
  const credentials = new FileSubscriptionCredentials(config.credentialsFile),
    reader = new AuthSubscriptionReader({
      origin: authOrigin,
      credentials: credentials.read,
      fetch: transport,
    });
  const binding = Object.freeze({
    tenant,
    root: config.manifestRoot,
    databasePort,
    baseEnvironmentFile,
    inputFiles: Object.freeze([
      controlFile,
      config.caFile,
      config.credentialsFile,
      config.databaseFile,
    ]),
    manifest: runtime.manifest,
    async preflight(
      service,
      kind = "install",
      signal = AbortSignal.timeout(7000),
    ) {
      if (
        !["j-approval", "j-talk", "j-mail"].includes(service) ||
        !["install", "remove"].includes(kind)
      )
        fail("invalid_service");
      await anchor();
      const subscribed = await reader.read(tenant, signal);
      if (kind === "install" && !subscribed.services.includes(service))
        fail("notification_service_inactive");
      // No manifest/state/PG projection writes occur until the lifecycle explicitly registers a key.
    },
    async close() {
      try {
        await pool.end();
      } finally {
        await agent.close();
      }
    },
  });
  owned.add(binding);
  return binding;
}
