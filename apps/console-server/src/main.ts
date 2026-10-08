import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { createConsoleApp } from "./app.js";
import { loadConsoleConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
async function main() {
  const config = loadConsoleConfig(),
    pool = new Pool(config.database);
  pool.on("error", () =>
    process.stderr.write("Console database unavailable.\n"),
  );
  let close = () => pool.end();
  try {
    await migrate(pool);
    const [cert, key] = await Promise.all([
      readFile(config.tlsCertificate),
      readFile(config.tlsKey),
    ]);
    const app = createConsoleApp({
      pool,
      config,
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
    app.addHook("onClose", () => pool.end());
    close = () => app.close();
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        if (!closing) {
          closing = true;
          void close().catch(() => {
            process.exitCode = 1;
          });
        }
      });
    await app.listen({ host: "127.0.0.1", port: config.port });
  } catch {
    await close().catch(() => undefined);
    throw new Error("Console startup failed.");
  }
}
main().catch(() => {
  process.stderr.write(
    "Console startup failed. Sensitive configuration was not logged.\n",
  );
  process.exitCode = 1;
});
