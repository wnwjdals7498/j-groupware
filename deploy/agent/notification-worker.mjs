import { X509Certificate } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { Agent, fetch as undiciFetch } from "undici";
import { assertCustomerTenantId } from "@j-auth/contracts";
import {
  AuthSubscriptionReader,
  NotificationProjector,
} from "../../apps/server/dist/notification-projection.js";
import { migrate } from "../../apps/server/dist/db/migrate.js";
import { NotificationManifest } from "./notification-manifest.mjs";
import { FileSubscriptionCredentials } from "./subscription-credentials.mjs";
import { readControlJson, readControlFile } from "./control-files.mjs";
import { ProvisionError } from "./provision-error.mjs";
import { externalPath } from "../gateway/gateway.mjs";

export function createNotificationRuntime({
  tenant,
  pool,
  authOrigin,
  credentialsFile,
  manifestRoot,
  fetch,
}) {
  assertCustomerTenantId(tenant);
  if (!pool?.connect) throw new ProvisionError("invalid_configuration");
  const credentials = new FileSubscriptionCredentials(credentialsFile);
  const reader = new AuthSubscriptionReader({
    origin: authOrigin,
    credentials: credentials.read,
    ...(fetch ? { fetch } : {}),
  });
  const projector = new NotificationProjector(pool, tenant, reader.read);
  const manifest = new NotificationManifest({
    root: manifestRoot,
    tenant,
    projector,
  });
  // Construction is inert. The installer/operator must call runOnce explicitly.
  return { manifest, runOnce: (signal) => manifest.refresh(signal) };
}
export async function loadNotificationControl(file) {
  const input = await readControlJson(file, 8192);
  if (
    Object.keys(input).sort().join(",") !==
    "authOrigin,caFile,credentialsFile,databaseFile,manifestRoot,tenant"
  )
    throw new ProvisionError("invalid_notification_control");
  assertCustomerTenantId(input.tenant);
  for (const name of [
    "caFile",
    "credentialsFile",
    "databaseFile",
    "manifestRoot",
  ])
    externalPath(input[name]);
  const database = await readControlJson(input.databaseFile, 8192);
  if (
    Object.keys(database).sort().join(",") !== "password,port,tenant" ||
    database.tenant !== input.tenant ||
    !Number.isInteger(database.port) ||
    database.port < 1 ||
    database.port > 65535 ||
    database.port === 3001 ||
    typeof database.password !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(database.password)
  )
    throw new ProvisionError("invalid_notification_database");
  const ca = await readControlFile(input.caFile, { privateFile: false });
  let certificate;
  try {
    certificate = new X509Certificate(ca);
  } catch {
    throw new ProvisionError("invalid_ca");
  }
  if (
    !certificate.ca ||
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now()
  )
    throw new ProvisionError("invalid_ca");
  // Validate auth origin before creating sockets or acquiring a DB connection.
  new AuthSubscriptionReader({
    origin: input.authOrigin,
    credentials: async () => ({ bearer: "unused", serviceKey: "unused" }),
  });
  return {
    ...input,
    ca,
    connection: {
      host: "127.0.0.1",
      port: database.port,
      database: "jgw_groupware",
      user: "jgw_groupware",
      password: database.password,
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      statement_timeout: 7000,
      application_name: "jgw-notification-control",
    },
  };
}
async function main() {
  if (
    process.argv.length !== 5 ||
    process.argv[2] !== "--config" ||
    process.argv[4] !== "--once"
  )
    throw new ProvisionError("invalid_notification_arguments");
  const config = await loadNotificationControl(process.argv[3]);
  const agent = new Agent({
    connect: { ca: config.ca, rejectUnauthorized: true, minVersion: "TLSv1.2" },
  });
  const pool = new Pool(config.connection);
  pool.on("error", () => {});
  const controller = new AbortController(),
    stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  const timeout = setTimeout(stop, 15000);
  try {
    await migrate(pool);
    const runtime = createNotificationRuntime({
      tenant: config.tenant,
      pool,
      authOrigin: config.authOrigin,
      credentialsFile: config.credentialsFile,
      manifestRoot: config.manifestRoot,
      fetch: (input, init) =>
        undiciFetch(String(input), { ...init, dispatcher: agent }),
    });
    const result = await runtime.runOnce(controller.signal);
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    clearTimeout(timeout);
    for (const signal of ["SIGINT", "SIGTERM"])
      process.removeListener(signal, stop);
    await pool.end();
    await agent.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      (error instanceof ProvisionError
        ? error.code
        : "notification_refresh_failed") + "\n",
    );
    process.exitCode = 1;
  });
}
