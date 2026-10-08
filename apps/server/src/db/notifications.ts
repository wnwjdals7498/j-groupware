import type { Pool, PoolClient } from "pg";
import { timingSafeEqual } from "node:crypto";
import { NOTIFICATION_TYPES } from "@j-groupware/permissions/notifications";
import type {
  NotificationInput,
  NotificationType,
  NotificationKeyHashes,
  NotificationItem,
  NotificationPage,
} from "@j-groupware/permissions/notifications";
import type { SessionRow } from "./sessions.js";
import { ApiError, unauthenticated } from "../errors.js";
import { digest } from "../security.js";
const invalid = () =>
  new ApiError(400, "invalid_input", "Invalid notification.");
const text = (value: unknown, min: number, max: number) => {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw invalid();
  return value;
};
export function notificationInput(
  raw: unknown,
  tenant: string,
): NotificationInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "tenant",
          "service",
          "type",
          "members",
          "usernames",
          "role",
          "title",
          "body",
          "link",
          "dedupKey",
        ].includes(key),
    ) ||
    value.tenant !== tenant
  )
    throw invalid();
  const type = text(value.type, 1, 64);
  if (!Object.hasOwn(NOTIFICATION_TYPES, type)) throw invalid();
  const entry = NOTIFICATION_TYPES[type as NotificationType];
  if (value.service !== entry.service) throw invalid();
  const title = text(value.title, 1, 200).trim(),
    dedupKey = text(value.dedupKey, 1, 256),
    link = text(value.link, 1, 512);
  if (
    !title ||
    !entry.link.test(link) ||
    typeof value.body !== "string" ||
    Buffer.byteLength(value.body, "utf8") > 1024 ||
    /[\u0000\u007f]/u.test(value.body)
  )
    throw invalid();
  if (
    ["members", "usernames", "role"].filter((key) => value[key] !== undefined)
      .length !== 1
  )
    throw invalid();
  const target: Pick<NotificationInput, "members" | "usernames" | "role"> = {};
  if (value.role !== undefined) {
    if (value.role !== entry.role) throw invalid();
    Object.assign(target, { role: entry.role });
  } else {
    const field = value.members === undefined ? "usernames" : "members",
      items = value[field];
    if (!Array.isArray(items) || items.length < 1 || items.length > 100)
      throw invalid();
    const clean = items.map((item) => text(item, 1, 128).trim());
    if (clean.some((item) => !item) || new Set(clean).size !== clean.length)
      throw invalid();
    Object.assign(target, { [field]: clean.sort() });
  }
  return {
    tenant,
    service: entry.service,
    type: type as NotificationType,
    title,
    body: value.body,
    link,
    dedupKey,
    ...target,
  };
}
interface Row {
  id: string;
  service: NotificationInput["service"];
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  created_at: Date;
  read_at: Date | null;
  cursor_time: string;
}
const item = (row: Row): NotificationItem => ({
  id: row.id,
  service: row.service,
  type: row.type,
  icon: NOTIFICATION_TYPES[row.type].icon,
  label: NOTIFICATION_TYPES[row.type].label,
  title: row.title,
  body: row.body,
  link: row.link,
  createdAt: row.created_at.toISOString(),
  readAt: row.read_at?.toISOString() ?? null,
});
const visible = `n.tenant_id=$1 AND s.active AND (s.projection_expires_at IS NULL OR s.projection_expires_at>clock_timestamp()) AND n.required_role=ANY($4::text[]) AND n.created_at>clock_timestamp()-interval '30 days' AND ((n.target->'members') ? $2 OR (n.target->'usernames') ? $3 OR n.target->>'role'=ANY($4::text[]))`;
export class NotificationStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
  ) {}
  private async tx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async configure(keys: NotificationKeyHashes): Promise<void> {
    for (const [service, hashes] of Object.entries(keys))
      if (
        !["j-approval", "j-talk", "j-mail"].includes(service) ||
        !Array.isArray(hashes) ||
        hashes.length > 2 ||
        hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
      )
        throw new Error("Invalid private notification key configuration.");
    await this.tx(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('jgw-notification-projection'),hashtext($1))",
        [this.tenant],
      );
      if (
        (
          await client.query(
            "SELECT 1 FROM notification_projection_state WHERE tenant_id=$1",
            [this.tenant],
          )
        ).rowCount
      )
        throw new Error(
          "Notification registry is owned by the projection worker.",
        );
      for (const service of ["j-approval", "j-talk", "j-mail"] as const) {
        const hashes = keys[service] ?? [];
        await client.query(
          "INSERT INTO notification_services(tenant_id,service,key_hashes,active) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,service) DO UPDATE SET key_hashes=EXCLUDED.key_hashes,active=EXCLUDED.active",
          [this.tenant, service, hashes, hashes.length > 0],
        );
      }
    });
  }
  async requireProjection(): Promise<void> {
    const result = await this.pool.query<{ ready: boolean }>(
      "SELECT count(*)=3 AND EXISTS(SELECT 1 FROM notification_projection_state WHERE tenant_id=$1) AS ready FROM notification_services WHERE tenant_id=$1 AND projection_expires_at IS NOT NULL",
      [this.tenant],
    );
    if (!result.rows[0]?.ready)
      throw new Error(
        "Notification projection must be initialized by its control-plane owner.",
      );
  }
  receive(
    raw: unknown,
    key: string | undefined,
  ): Promise<{ id: string; duplicate: boolean }> {
    const input = notificationInput(raw, this.tenant);
    if (
      !key ||
      key.length < 20 ||
      key.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(key)
    )
      throw unauthenticated();
    return this.tx(async (client) => {
      const source = (
        await client.query<{ key_hashes: string[]; active: boolean }>(
          "SELECT CASE WHEN projection_expires_at IS NOT NULL AND previous_key_expires_at<=clock_timestamp() THEN key_hashes[1:1] ELSE key_hashes END AS key_hashes,active AND (projection_expires_at IS NULL OR projection_expires_at>clock_timestamp()) AS active FROM notification_services WHERE tenant_id=$1 AND service=$2 FOR SHARE",
          [this.tenant, input.service],
        )
      ).rows[0];
      const hash = Buffer.from(digest(key), "hex");
      if (
        !source ||
        !source.key_hashes.some((value) =>
          timingSafeEqual(hash, Buffer.from(value, "hex")),
        )
      )
        throw unauthenticated();
      if (!source.active)
        throw new ApiError(403, "forbidden", "Service is inactive.");
      const target = {
        ...(input.members ? { members: input.members } : {}),
        ...(input.usernames ? { usernames: input.usernames } : {}),
        ...(input.role ? { role: input.role } : {}),
      };
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO notifications(tenant_id,service,type,required_role,target,title,body,link,dedup_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,service,dedup_key) DO NOTHING RETURNING id",
        [
          this.tenant,
          input.service,
          input.type,
          NOTIFICATION_TYPES[input.type].role,
          target,
          input.title,
          input.body,
          input.link,
          input.dedupKey,
        ],
      );
      if (inserted.rows[0])
        return { id: inserted.rows[0].id, duplicate: false };
      const existing = (
        await client.query<{ id: string; equal: boolean }>(
          "SELECT id,type=$4 AND target=$5::jsonb AND title=$6 AND body=$7 AND link=$8 AS equal FROM notifications WHERE tenant_id=$1 AND service=$2 AND dedup_key=$3",
          [
            this.tenant,
            input.service,
            input.dedupKey,
            input.type,
            target,
            input.title,
            input.body,
            input.link,
          ],
        )
      ).rows[0]!;
      if (!existing.equal)
        throw new ApiError(
          409,
          "conflict",
          "Event key already contains another notification.",
        );
      return { id: existing.id, duplicate: true };
    });
  }
  async list(
    identity: Pick<SessionRow, "subject" | "username" | "roles">,
    cursor?: string,
  ): Promise<NotificationPage> {
    const scope = JSON.stringify([this.tenant, identity.subject]);
    let time: string | null = null,
      id: string | null = null;
    if (cursor) {
      try {
        const value: unknown = JSON.parse(
          Buffer.from(cursor, "base64url").toString(),
        );
        if (
          !Array.isArray(value) ||
          value.length !== 3 ||
          value[0] !== scope ||
          typeof value[1] !== "string" ||
          !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00$/.test(
            value[1],
          ) ||
          typeof value[2] !== "string" ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value[2])
        )
          throw invalid();
        const date = new Date(value[1].replace(" ", "T") + ":00");
        if (
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 19) !==
            value[1].slice(0, 19).replace(" ", "T")
        )
          throw invalid();
        [time, id] = [value[1], value[2]];
      } catch {
        throw invalid();
      }
    }
    const args = [
      this.tenant,
      identity.subject,
      identity.username,
      identity.roles,
    ];
    const rows = await this.pool.query<Row>(
      `SELECT n.*,n.created_at::text AS cursor_time,r.read_at FROM notifications n JOIN notification_services s USING(tenant_id,service) LEFT JOIN notification_reads r ON r.tenant_id=n.tenant_id AND r.notification_id=n.id AND r.member_id=$2 WHERE ${visible} AND ($5::timestamptz IS NULL OR (n.created_at,n.id)<($5::timestamptz,$6::uuid)) ORDER BY n.created_at DESC,n.id DESC LIMIT 51`,
      [...args, time, id],
    );
    const count = await this.pool.query<{ unread: number }>(
      `SELECT count(*)::int AS unread FROM notifications n JOIN notification_services s USING(tenant_id,service) WHERE ${visible} AND NOT EXISTS(SELECT 1 FROM notification_reads r WHERE r.tenant_id=n.tenant_id AND r.notification_id=n.id AND r.member_id=$2)`,
      args,
    );
    const items = rows.rows.slice(0, 50),
      last = items.at(-1);
    return {
      items: items.map(item),
      nextCursor:
        rows.rows.length > 50 && last
          ? Buffer.from(
              JSON.stringify([scope, last.cursor_time, last.id]),
            ).toString("base64url")
          : null,
      unread: count.rows[0]!.unread,
    };
  }
  async forSession(hash: string): Promise<NotificationPage> {
    const identity = (
      await this.pool.query<SessionRow>(
        "SELECT * FROM sessions WHERE tenant_id=$1 AND session_hash=$2 AND last_seen_at>clock_timestamp()-interval '30 minutes' AND created_at>clock_timestamp()-interval '8 hours'",
        [this.tenant, hash],
      )
    ).rows[0];
    if (!identity) throw unauthenticated();
    return this.list(identity);
  }
  read(
    identity: Pick<SessionRow, "subject" | "username" | "roles">,
    id: string,
  ): Promise<{ readAt: string }> {
    return this.tx(async (client) => {
      const accessible = await client.query(
        `SELECT n.id FROM notifications n JOIN notification_services s USING(tenant_id,service) WHERE ${visible} AND n.id=$5 FOR SHARE OF n`,
        [this.tenant, identity.subject, identity.username, identity.roles, id],
      );
      if (!accessible.rowCount)
        throw new ApiError(404, "not_found", "Notification not found.");
      await client.query(
        "INSERT INTO notification_reads(tenant_id,notification_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [this.tenant, id, identity.subject],
      );
      const row = (
        await client.query<{ read_at: Date }>(
          "SELECT read_at FROM notification_reads WHERE tenant_id=$1 AND notification_id=$2 AND member_id=$3",
          [this.tenant, id, identity.subject],
        )
      ).rows[0]!;
      return { readAt: row.read_at.toISOString() };
    });
  }
  async purge(): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM notifications WHERE tenant_id=$1 AND id IN (SELECT id FROM notifications WHERE tenant_id=$1 AND created_at<=clock_timestamp()-interval '30 days' LIMIT 1000)",
      [this.tenant],
    );
    return result.rowCount ?? 0;
  }
}
