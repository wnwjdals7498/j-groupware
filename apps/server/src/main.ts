import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./app.js";
import { NotificationStore } from "./db/notifications.js";
import { createNotificationReceiver } from "./notification-receiver.js";

async function main() {
  const config = loadConfig();
  const pool = new Pool(config.database);
  let cleanup: () => Promise<void> = async () => undefined;
  try {
    await migrate(pool);
    const [cert, key] = await Promise.all([
      readFile(config.tlsCertificate),
      readFile(config.tlsKey),
    ]);
    const app = createApp({
      pool,
      config,
      requireWebAssets: true,
      serviceEndpoints: config.serviceEndpoints,
      memberAuth: { origin: config.authOrigin, serviceKey: config.serviceKey },
      https: { cert, key, minVersion: "TLSv1.2" },
      logger: {
        level: "info",
        serializers: {
          req: () => ({}),
          res: () => ({}),
          err: () => ({ type: "Error", message: "Request failed.", stack: "" }),
        },
      },
    });
    app.addHook("onClose", async () => {
      await pool.end();
    });
    cleanup = () => app.close();
    if (config.notificationReceiver) {
      if (config.notificationReceiver.port === config.port)
        throw new Error(
          "Internal notifications require a separate loopback port.",
        );
      const store = new NotificationStore(pool, config.tenant);
      if (config.notificationReceiver.mode === "static")
        await store.configure(config.notificationReceiver.keyHashes);
      else await store.requireProjection();
      const receiver = createNotificationReceiver(store);
      app.addHook("preClose", () => receiver.close());
      await receiver.listen({
        host: "127.0.0.1",
        port: config.notificationReceiver.port,
      });
    }
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        if (!closing) {
          closing = true;
          void app.close().catch(() => {
            process.exitCode = 1;
          });
        }
      });
    await app.listen({ host: "127.0.0.1", port: config.port });
  } catch {
    await cleanup().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw new Error(
      "BFF startup failed. Check external configuration and dependencies.",
    );
  }
}
main().catch(() => {
  process.stderr.write(
    "BFF startup failed. No sensitive configuration was logged.\n",
  );
  process.exitCode = 1;
});
