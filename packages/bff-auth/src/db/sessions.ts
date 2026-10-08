import type { Pool, PoolClient } from "pg";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { digest, randomToken } from "../security.js";
import { ApiError, unauthenticated } from "../errors.js";
import type { OidcClient, LoginIdentity } from "../oidc.js";

export interface SessionRow {
  session_hash: string;
  tenant_id: string;
  subject: string;
  username: string;
  sid: string;
  nonce: string;
  roles: string[];
  csrf_token: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
  now: Date;
}
export class SessionStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
    private readonly oidc: OidcClient,
    private readonly onEnd: (hashes: readonly string[]) => void = () => {},
  ) {}

  async startLogin(previous?: string) {
    const flow = randomToken(),
      state = randomToken(),
      nonce = randomToken(),
      verifier = randomToken();
    // Replace this browser's pending flow, and prune expired state. No nonce/verifier leaves the server.
    await this.pool.query(
      "DELETE FROM login_flows WHERE expires_at <= now() OR (tenant_id = $1 AND flow_hash = $2)",
      [this.tenant, previous ? digest(previous) : null],
    );
    await this.pool.query(
      "INSERT INTO login_flows(flow_hash,tenant_id,state_hash,nonce,verifier) VALUES($1,$2,$3,$4,$5)",
      [digest(flow), this.tenant, digest(state), nonce, verifier],
    );
    return { flow, url: this.oidc.authorize(state, nonce, verifier) };
  }
  async consumeLogin(flow: string | undefined, state: string) {
    if (!flow || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw unauthenticated();
    const result = await this.pool.query<{
      nonce: string;
      verifier: string;
      started_at: Date;
    }>(
      "DELETE FROM login_flows WHERE tenant_id=$1 AND flow_hash=$2 AND state_hash=$3 AND expires_at>now() RETURNING nonce,verifier,started_at",
      [this.tenant, digest(flow), digest(state)],
    );
    if (!result.rows[0]) throw unauthenticated();
    return result.rows[0];
  }
  async create(
    tokens: { access_token: string; refresh_token: string },
    identity: LoginIdentity,
    nonce: string,
    loginStarted: Date,
    previous?: string,
  ): Promise<string> {
    const session = randomToken(),
      hash = digest(session);
    const client = await this.pool.connect();
    const ended: string[] = [];
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('jgw-member:' || $1 || ':' || $2,0))",
        [this.tenant, identity.subject],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('jgw-sid:' || $1 || ':' || $2,0))",
        [this.tenant, identity.sid],
      );
      if (previous) {
        const removed = await client.query<{ session_hash: string }>(
          "DELETE FROM sessions WHERE tenant_id=$1 AND session_hash=$2 RETURNING session_hash",
          [this.tenant, digest(previous)],
        );
        ended.push(...removed.rows.map((row) => row.session_hash));
      }
      const created = await client.query(
        `INSERT INTO sessions(session_hash,tenant_id,subject,username,roles,sid,nonce,csrf_token,access_token,refresh_token,access_expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        WHERE NOT EXISTS(SELECT 1 FROM logout_events WHERE tenant_id=$2 AND sid=$6 AND expires_at>now())
        AND NOT EXISTS(SELECT 1 FROM member_session_ends WHERE tenant_id=$2 AND subject=$3 AND ended_at >= $12 AND expires_at>now())`,
        [
          hash,
          this.tenant,
          identity.subject,
          identity.username,
          identity.roles,
          identity.sid,
          nonce,
          randomToken(),
          tokens.access_token,
          tokens.refresh_token,
          identity.expires,
          loginStarted,
        ],
      );
      if (!created.rowCount) throw unauthenticated();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    this.onEnd(ended);
    return session;
  }
  authenticate(session: string | undefined): Promise<SessionRow> {
    return this.useSession(session, async (row) => row);
  }
  async useSession<T>(
    session: string | undefined,
    run: (row: SessionRow, client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!session) throw unauthenticated();
    const client = await this.pool.connect();
    let invalid = false,
      ended = false;
    let row: SessionRow | undefined;
    let result: T | undefined;
    try {
      await client.query("BEGIN");
      row = (
        await client.query<SessionRow>(
          "SELECT *,clock_timestamp() AS now FROM sessions WHERE tenant_id=$1 AND session_hash=$2 FOR UPDATE",
          [this.tenant, digest(session)],
        )
      ).rows[0];
      if (!row) invalid = true;
      else {
        const time = row.now.getTime();
        if (
          time - row.created_at.getTime() >= SESSION_POLICY.maxSeconds * 1000 ||
          time - row.last_seen_at.getTime() >= SESSION_POLICY.idleSeconds * 1000
        )
          invalid = true;
        else if (
          row.access_expires_at.getTime() - time <=
          SESSION_POLICY.refreshThresholdSeconds * 1000
        ) {
          try {
            const fresh = await this.oidc.refresh(
              row.refresh_token,
              row.nonce,
              { subject: row.subject, sid: row.sid },
            );
            row = {
              ...row,
              access_token: fresh.tokens.access_token,
              refresh_token: fresh.tokens.refresh_token,
              roles: [...fresh.identity.roles],
              username: fresh.identity.username,
              access_expires_at: fresh.identity.expires,
            };
          } catch (error) {
            if (error instanceof ApiError && error.status === 401)
              invalid = true;
            else throw error;
          }
        }
        if (invalid) {
          await client.query(
            "DELETE FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
            [this.tenant, row.session_hash],
          );
          ended = true;
        } else {
          await client.query(
            "UPDATE sessions SET access_token=$3,refresh_token=$4,roles=$5,username=$6,access_expires_at=$7,last_seen_at=clock_timestamp() WHERE tenant_id=$1 AND session_hash=$2",
            [
              this.tenant,
              row.session_hash,
              row.access_token,
              row.refresh_token,
              row.roles,
              row.username,
              row.access_expires_at,
            ],
          );
          // A valid rotated refresh token must survive downstream failure/cancellation.
          // Only the caller's cache changes roll back; the refreshed session stays committed.
          await client.query("SAVEPOINT session_ready");
          try {
            signal?.throwIfAborted();
            result = await run(row, client);
            signal?.throwIfAborted();
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT session_ready");
            await client.query("COMMIT");
            throw error;
          }
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (ended && row) this.onEnd([row.session_hash]);
    if (invalid || !row) throw unauthenticated();
    return result as T;
  }
  async end(session: string): Promise<void> {
    const removed = await this.pool.query<{ session_hash: string }>(
      "DELETE FROM sessions WHERE tenant_id=$1 AND session_hash=$2 RETURNING session_hash",
      [this.tenant, digest(session)],
    );
    this.onEnd(removed.rows.map((row) => row.session_hash));
  }
  async endMember(subject: string): Promise<void> {
    const client = await this.pool.connect();
    let ended: string[] = [];
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('jgw-member:' || $1 || ':' || $2,0))",
        [this.tenant, subject],
      );
      await client.query(
        "DELETE FROM member_session_ends WHERE expires_at<=now()",
      );
      await client.query(
        `INSERT INTO member_session_ends(tenant_id,subject,ended_at,expires_at) VALUES($1,$2,clock_timestamp(),clock_timestamp()+interval '8 hours')
        ON CONFLICT(tenant_id,subject) DO UPDATE SET ended_at=EXCLUDED.ended_at,expires_at=EXCLUDED.expires_at`,
        [this.tenant, subject],
      );
      const result = await client.query<{ session_hash: string }>(
        "DELETE FROM sessions WHERE tenant_id=$1 AND subject=$2 RETURNING session_hash",
        [this.tenant, subject],
      );
      ended = result.rows.map((row) => row.session_hash);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    this.onEnd(ended);
  }
  async backchannel(token: string): Promise<void> {
    if (token.length > 16384)
      throw new ApiError(400, "invalid_input", "Invalid logout token.");
    const claims = await this.oidc.validateLogout(token);
    const client = await this.pool.connect();
    let ended: string[] = [];
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM logout_events WHERE expires_at<=now()");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('jgw-sid:' || $1 || ':' || $2,0))",
        [this.tenant, claims.sid],
      );
      const stored = await client.query(
        `INSERT INTO logout_events(tenant_id,jti,sid,subject,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '8 hours') ON CONFLICT DO NOTHING`,
        [this.tenant, claims.jti, claims.sid, claims.sub ?? null],
      );
      if (stored.rowCount) {
        const removed = await client.query<{ session_hash: string }>(
          "DELETE FROM sessions WHERE tenant_id=$1 AND sid=$2 AND ($3::text IS NULL OR subject=$3) RETURNING session_hash",
          [this.tenant, claims.sid, claims.sub ?? null],
        );
        ended = removed.rows.map((row) => row.session_hash);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    this.onEnd(ended);
  }
}
