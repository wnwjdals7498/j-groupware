import type { Pool } from "pg";
import type { NotificationManifest } from "./notification-manifest.mjs";
export function createNotificationRuntime(options: {
  tenant: string;
  pool: Pool;
  authOrigin: string;
  credentialsFile: string;
  manifestRoot: string;
  fetch?: typeof globalThis.fetch;
}): {
  manifest: NotificationManifest;
  runOnce(signal?: AbortSignal): Promise<{ tenant: string; revision: string }>;
};
export function loadNotificationControl(
  file: string,
): Promise<{
  tenant: string;
  authOrigin: string;
  credentialsFile: string;
  databaseFile: string;
  manifestRoot: string;
  caFile: string;
  ca: string;
  connection: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
}>;
