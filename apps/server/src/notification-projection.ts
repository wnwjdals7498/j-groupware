import {
  assertCustomerTenantId,
  SERVICE_CATALOG,
  SERVICE_KEY_HEADER,
} from "@j-auth/contracts";
import type { TenantServicesResponse } from "@j-auth/contracts";
import type { Pool } from "pg";
import { digest } from "./security.js";
import { ApiError, unavailable } from "./errors.js";
import { memberAuthOrigin } from "./members.js";

const services = ["j-approval", "j-talk", "j-mail"] as const;
type SourceService = (typeof services)[number];
const tenantServices = new Set(
  SERVICE_CATALOG.filter((service) => service.tenantService).map(
    (service) => service.serviceId,
  ),
);
export interface NotificationKeyManifest {
  readonly tenantId: string;
  readonly revision: string;
  readonly keys: Partial<
    Record<
      SourceService,
      {
        readonly currentHash: string;
        readonly previousHash?: string;
        readonly previousExpiresAt?: string;
      }
    >
  >;
}
export type SubscriptionReader = (
  tenant: string,
  signal: AbortSignal,
) => Promise<TenantServicesResponse>;

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let reject!: (reason?: unknown) => void;
  const aborted = () => reject(unavailable());
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, fail) => {
        reject = fail;
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid projection input.");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Invalid projection input.");
}
function manifestInput(
  raw: NotificationKeyManifest,
  tenant: string,
): NotificationKeyManifest {
  const value = object(raw);
  exact(value, ["tenantId", "revision", "keys"]);
  if (
    value.tenantId !== tenant ||
    typeof value.revision !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value.revision) ||
    BigInt(value.revision) > 9223372036854775807n
  )
    throw new Error("Invalid projection input.");
  const source = object(value.keys);
  exact(source, services);
  const keys: NotificationKeyManifest["keys"] = {};
  for (const service of services) {
    if (source[service] === undefined) continue;
    const entry = object(source[service]);
    exact(entry, ["currentHash", "previousHash", "previousExpiresAt"]);
    if (
      typeof entry.currentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.currentHash)
    )
      throw new Error("Invalid projection input.");
    if (
      (entry.previousHash === undefined) !==
      (entry.previousExpiresAt === undefined)
    )
      throw new Error("Invalid projection input.");
    if (
      entry.previousHash !== undefined &&
      (typeof entry.previousHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.previousHash) ||
        entry.previousHash === entry.currentHash ||
        typeof entry.previousExpiresAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(
          entry.previousExpiresAt,
        ) ||
        new Date(entry.previousExpiresAt).toISOString() !==
          entry.previousExpiresAt)
    )
      throw new Error("Invalid projection input.");
    Object.assign(keys, {
      [service]: {
        currentHash: entry.currentHash,
        ...(entry.previousHash === undefined
          ? {}
          : {
              previousHash: entry.previousHash as string,
              previousExpiresAt: entry.previousExpiresAt as string,
            }),
      },
    });
  }
  return { tenantId: tenant, revision: value.revision, keys };
}
function subscriptionInput(
  value: unknown,
  tenant: string,
): TenantServicesResponse {
  const row = object(value);
  exact(row, ["tenantId", "services"]);
  if (
    row.tenantId !== tenant ||
    !Array.isArray(row.services) ||
    row.services.length > tenantServices.size ||
    row.services.some((service) => !tenantServices.has(service)) ||
    new Set(row.services).size !== row.services.length
  )
    throw unavailable();
  return {
    tenantId: tenant,
    services: [...row.services] as TenantServicesResponse["services"],
  };
}

/** Control-plane read-only transport. Never install its operator credentials in the BFF. */
export class AuthSubscriptionReader {
  private readonly origin: string;
  constructor(
    private readonly options: {
      origin: string;
      credentials: () => Promise<{ bearer: string; serviceKey: string }>;
      fetch?: typeof globalThis.fetch;
    },
  ) {
    this.origin = memberAuthOrigin(options.origin);
  }
  readonly read: SubscriptionReader = async (tenant, signal) => {
    assertCustomerTenantId(tenant);
    try {
      signal.throwIfAborted();
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const credentials = await bounded(this.options.credentials(), timeout);
      if (
        typeof credentials.bearer !== "string" ||
        !credentials.bearer ||
        credentials.bearer.length > 16384 ||
        /[\r\n]/.test(credentials.bearer) ||
        !/^[A-Za-z0-9_-]{20,128}$/.test(credentials.serviceKey)
      )
        throw unavailable();
      const response = await bounded(
        (this.options.fetch ?? globalThis.fetch)(
          `${this.origin}/auth/tenants/${tenant}/services`,
          {
            method: "GET",
            redirect: "error",
            signal: timeout,
            headers: {
              Authorization: "Bearer " + credentials.bearer,
              [SERVICE_KEY_HEADER]: credentials.serviceKey,
            },
          },
        ),
        timeout,
      );
      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.startsWith("application/json")
      ) {
        await response.body?.cancel();
        throw unavailable();
      }
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await bounded(reader.read(), timeout);
          if (done) break;
          size += value.byteLength;
          if (size > 16384) throw unavailable();
          chunks.push(value);
        }
        return subscriptionInput(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          tenant,
        );
      } catch {
        await reader.cancel().catch(() => undefined);
        throw unavailable();
      } finally {
        reader.releaseLock();
      }
    } catch {
      throw unavailable();
    }
  };
}

/** Installer-owned key generation plus serialized authoritative subscription observations. */
export class NotificationProjector {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
    private readonly read: SubscriptionReader,
    private readonly leaseSeconds = 60,
  ) {
    assertCustomerTenantId(tenant);
    if (
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > 60
    )
      throw new Error("Invalid projection lease.");
  }
  async reconcile(
    raw: NotificationKeyManifest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const manifest = manifestInput(raw, this.tenant),
      hash = digest(JSON.stringify(manifest));
    signal.throwIfAborted();
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='7s'",
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('jgw-notification-projection'),hashtext($1))",
        [this.tenant],
      );
      const old = (
        await client.query<{
          manifest_revision: string;
          manifest_digest: string;
        }>(
          "SELECT manifest_revision,manifest_digest FROM notification_projection_state WHERE tenant_id=$1 FOR UPDATE",
          [this.tenant],
        )
      ).rows[0];
      if (
        old &&
        (BigInt(old.manifest_revision) > BigInt(manifest.revision) ||
          (old.manifest_revision === manifest.revision &&
            old.manifest_digest !== hash))
      )
        throw new ApiError(
          409,
          "conflict",
          "Notification key generation is stale or changed.",
        );
      // Reserve ownership before reading; failed polls cannot fall back to static keys on restart.
      await client.query(
        "INSERT INTO notification_projection_state(tenant_id,manifest_revision,manifest_digest) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET manifest_revision=EXCLUDED.manifest_revision,manifest_digest=EXCLUDED.manifest_digest",
        [this.tenant, manifest.revision, hash],
      );
      let subscriptions: TenantServicesResponse;
      try {
        const abort = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        subscriptions = subscriptionInput(
          await bounded(this.read(this.tenant, abort), abort),
          this.tenant,
        );
        abort.throwIfAborted();
      } catch {
        await client.query(
          "UPDATE notification_services SET active=false,projection_expires_at=clock_timestamp() WHERE tenant_id=$1",
          [this.tenant],
        );
        await client.query("COMMIT");
        committed = true;
        throw unavailable();
      }
      for (const service of services) {
        const keys = manifest.keys[service],
          hashes = keys
            ? [
                keys.currentHash,
                ...(keys.previousHash ? [keys.previousHash] : []),
              ]
            : [];
        await client.query(
          "INSERT INTO notification_services(tenant_id,service,key_hashes,active,projection_expires_at,previous_key_expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+$5::integer*interval '1 second',$6) ON CONFLICT(tenant_id,service) DO UPDATE SET key_hashes=EXCLUDED.key_hashes,active=EXCLUDED.active,projection_expires_at=EXCLUDED.projection_expires_at,previous_key_expires_at=EXCLUDED.previous_key_expires_at",
          [
            this.tenant,
            service,
            hashes,
            Boolean(keys && subscriptions.services.includes(service)),
            this.leaseSeconds,
            keys?.previousExpiresAt ?? null,
          ],
        );
      }
      await client.query(
        "UPDATE notification_projection_state SET source_checked_at=clock_timestamp() WHERE tenant_id=$1",
        [this.tenant],
      );
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Disabled until an installer/control-plane owner explicitly starts it. */
export class NotificationProjectionWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  private active: Promise<void> = Promise.resolve();
  constructor(
    private readonly projector: NotificationProjector,
    private readonly manifest: () => NotificationKeyManifest,
    private readonly intervalMs = 10000,
    private readonly failed: () => void = () => undefined,
  ) {
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < 1000 ||
      intervalMs > 30000
    )
      throw new Error("Invalid projection interval.");
  }
  async start(): Promise<void> {
    if (this.running) return this.active;
    this.running = true;
    return this.tick();
  }
  private tick(): Promise<void> {
    this.abort = new AbortController();
    this.active = (async () => {
      try {
        await this.projector.reconcile(this.manifest(), this.abort!.signal);
      } catch {
        if (this.running) {
          try {
            this.failed();
          } catch {
            /* Observer never controls retry. */
          }
        }
      } finally {
        if (this.running) {
          this.timer = setTimeout(() => {
            void this.tick();
          }, this.intervalMs);
          this.timer.unref();
        }
      }
    })();
    return this.active;
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    await this.active;
  }
}
