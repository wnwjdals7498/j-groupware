import type { Pool, PoolClient, Notification } from "pg";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { ApiError, unavailable, unauthenticated } from "./errors.js";

interface Connection {
  readonly hash: string;
  readonly role: string | undefined;
  readonly close: () => void;
  active: boolean;
}
// One listener per BFF instance, shared by all its WSS/SSE connections. No browser credentials in NOTIFY.
export class RealtimeSessions {
  private client: PoolClient | undefined;
  private starting: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private auditing = false;
  private stopped = false;
  private readonly connections = new Set<Connection>();
  listenerPid: number | null = null;
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
  ) {}
  async ready(): Promise<void> {
    if (this.stopped) throw unavailable();
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async start(): Promise<void> {
    const client = await this.pool.connect();
    const lost = () => {
      if (this.client === client) {
        this.client = undefined;
        this.listenerPid = null;
        client.release(true);
        this.closeAll();
      }
    };
    client.on("error", lost);
    client.on("end", lost);
    client.on("notification", (notification: Notification) => {
      if (notification.channel !== "jgw_session_ends") return;
      try {
        const value = JSON.parse(notification.payload ?? "") as {
          tenant?: unknown;
          hash?: unknown;
        };
        if (
          value.tenant === this.tenant &&
          typeof value.hash === "string" &&
          /^[a-f0-9]{64}$/.test(value.hash)
        )
          this.end([value.hash]);
      } catch {
        /* Ignore malformed events. Periodic DB validation remains authoritative. */
      }
    });
    try {
      await client.query("LISTEN jgw_session_ends");
      const result = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      if (this.stopped) throw unavailable();
      this.client = client;
      this.listenerPid = result.rows[0]!.pid;
      if (!this.timer) {
        this.timer = setInterval(() => {
          void this.audit();
        }, 1000);
        this.timer.unref();
      }
    } catch {
      client.release(true);
      throw unavailable();
    }
  }
  private close(connection: Connection): void {
    if (!connection.active) return;
    connection.active = false;
    this.connections.delete(connection);
    connection.close();
  }
  private closeAll(): void {
    for (const connection of this.connections) this.close(connection);
  }
  end(hashes: readonly string[]): void {
    const ended = new Set(hashes);
    for (const connection of this.connections)
      if (ended.has(connection.hash)) this.close(connection);
  }
  private async valid(
    hashes: readonly string[],
  ): Promise<Map<string, readonly string[]>> {
    const result = await this.pool.query<{
      session_hash: string;
      roles: string[];
    }>(
      "SELECT session_hash,roles FROM sessions WHERE tenant_id=$1 AND session_hash=ANY($2::text[]) AND created_at>clock_timestamp()-$3::int*interval '1 second' AND last_seen_at>clock_timestamp()-$4::int*interval '1 second'",
      [
        this.tenant,
        hashes,
        SESSION_POLICY.maxSeconds,
        SESSION_POLICY.idleSeconds,
      ],
    );
    return new Map(result.rows.map((row) => [row.session_hash, row.roles]));
  }
  async track(
    hash: string,
    role: string | undefined,
    close: () => void,
  ): Promise<() => void> {
    await this.ready();
    if (
      this.connections.size >= 1000 ||
      [...this.connections].filter((connection) => connection.hash === hash)
        .length >= 8
    )
      throw new ApiError(
        429,
        "too_many_connections",
        "Too many realtime connections.",
      );
    const connection: Connection = { hash, role, close, active: true };
    // Subscribe first, then re-check DB: deletion during handshake cannot be lost between the two operations.
    this.connections.add(connection);
    try {
      const roles = (await this.valid([hash])).get(hash);
      if (!this.client || !connection.active) throw unavailable();
      if (!roles) throw unauthenticated();
      if (role && !roles.includes(role))
        throw new ApiError(403, "forbidden", "Permission denied.");
    } catch (error) {
      this.close(connection);
      throw error;
    }
    return () => {
      connection.active = false;
      this.connections.delete(connection);
    };
  }
  private async audit(): Promise<void> {
    if (this.auditing || !this.connections.size || this.stopped) return;
    this.auditing = true;
    try {
      const valid = await this.valid([
        ...new Set([...this.connections].map((connection) => connection.hash)),
      ]);
      for (const connection of this.connections) {
        const roles = valid.get(connection.hash);
        if (!roles || (connection.role && !roles.includes(connection.role)))
          this.close(connection);
      }
    } catch {
      this.closeAll();
    } finally {
      this.auditing = false;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.closeAll();
    await this.starting?.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    this.listenerPid = null;
    if (client) {
      client.removeAllListeners("notification");
      try {
        await client.query("UNLISTEN *");
        client.release();
      } catch {
        client.release(true);
      }
    }
  }
}
