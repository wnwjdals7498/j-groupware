import { request } from "node:https";
import { lstat, readFile } from "node:fs/promises";
import { ProvisionError } from "./service-database.mjs";
import { PRODUCT_SERVICES } from "./product-environment.mjs";

export class ProductReadiness {
  constructor({ environment, timeout = 3000 }) {
    if (
      !environment?.profile ||
      !Number.isInteger(timeout) ||
      timeout < 50 ||
      timeout > 10000
    )
      throw new ProvisionError("invalid_configuration");
    Object.assign(this, { environment, timeout });
  }
  async probe(service, signal) {
    const p = this.environment.profile(service);
    if (signal?.aborted) return false;
    const info = await lstat(p.ca);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 131072 ||
      info.mode & 0o022
    )
      throw new ProvisionError("unsafe_readiness_ca");
    const ca = await readFile(p.ca);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ready) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(ready);
      };
      const req = request(
        {
          hostname: "127.0.0.1",
          port: p.port,
          path: "/health/ready",
          method: "GET",
          ca,
          agent: false,
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
          ...(p.serverName
            ? { servername: p.serverName, headers: { Host: p.publicHost } }
            : {}),
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !response.headers["content-type"]?.startsWith("application/json")
          ) {
            response.destroy();
            finish(false);
            return;
          }
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 4096) {
              response.destroy();
              finish(false);
            } else chunks.push(chunk);
          });
          response.on("error", () => finish(false));
          response.on("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString());
              finish(
                service === "j-messenger"
                  ? value?.data?.ready === true
                  : value?.status === "ok",
              );
            } catch {
              finish(false);
            }
          });
        },
      );
      const abort = () => {
        req.destroy();
        finish(false);
      };
      const timer = setTimeout(abort, this.timeout);
      signal?.addEventListener("abort", abort, { once: true });
      req.on("error", () => finish(false));
      req.end();
      if (signal?.aborted) abort();
    });
  }
}

// Durable installation state is necessary but insufficient: active services
// enter the completed inventory only after an actual bounded HTTPS probe.
export class ServiceInventory {
  constructor({ tenant, state, readiness }) {
    if (!state?.read || !readiness?.probe || state.tenant !== tenant)
      throw new ProvisionError("invalid_configuration");
    Object.assign(this, { tenant, state, readiness });
  }
  async read(signal) {
    const installed = [],
      incomplete = [];
    for (const service of [...PRODUCT_SERVICES, "j-customer-auth-db"]) {
      signal?.throwIfAborted();
      const state = await this.state.read(service);
      if (!state || state.status === "removed") continue;
      if (
        state.status === "active" &&
        (await this.readiness.probe(service, signal))
      )
        installed.push(service);
      else incomplete.push(service);
    }
    return { tenant: this.tenant, installed, incomplete };
  }
}
