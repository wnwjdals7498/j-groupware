import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Pool } from "pg";
import { Browser, integrationRuntime, type Runtime } from "./runtime.js";
import { NotificationStore } from "../../apps/server/src/db/notifications.js";
import { createNotificationReceiver } from "../../apps/server/src/notification-receiver.js";
import { digest } from "../../apps/server/src/security.js";
import type { NotificationPage } from "@j-groupware/permissions/notifications";
import { createApp as createTalkApp } from "../../../j-talk/apps/server/dist/app.js";
import { migrate } from "../../../j-talk/apps/server/dist/db/migrate.js";
import { NotificationSender } from "../../../j-talk/apps/server/dist/notification-sender.js";

describe("actual Talk occurrences to G22 with atomicity, role visibility and durable retry", () => {
  let rt: Runtime,
    pool: Pool,
    owner: Browser,
    reader: Browser,
    denied: Browser,
    otherWriter: Browser,
    env: NodeJS.ProcessEnv,
    receiver: ReturnType<typeof createNotificationReceiver>,
    store: NotificationStore,
    port: number,
    sender: NotificationSender;
  const apps: ReturnType<typeof createTalkApp>[] = [],
    key = randomBytes(32).toString("base64url"),
    children: ReturnType<typeof spawn>[] = [],
    logs: string[] = [];
  const tenant = () => rt.fixtures[0]!.tenant;
  const event = async (id: string) =>
    (
      await pool.query(
        "SELECT * FROM event_outbox WHERE tenant_id=$1 AND id=$2",
        [tenant(), id],
      )
    ).rows[0];
  const count = async (id: string) =>
    (
      await rt.pool.query(
        "SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND dedup_key=$2",
        [tenant(), id],
      )
    ).rows[0].n as number;
  const page = async (b: Browser) => {
    const r = await b.request("/api/notifications");
    expect(r.status).toBe(200);
    return (await r.json()) as NotificationPage;
  };
  const wait = async (check: () => Promise<boolean>, timeout = 5000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Actual occurrence/lease observation timed out.");
  };
  const make = async () => {
    const visitor = randomUUID(),
      room = randomUUID();
    await pool.query("INSERT INTO visitors(tenant_id,id) VALUES ($1,$2)", [
      tenant(),
      visitor,
    ]);
    // Actual production trigger, not a visitor issuer or public room producer.
    await pool.query(
      "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
      [tenant(), room, visitor],
    );
    const row = (
      await pool.query(
        "SELECT id FROM event_outbox WHERE tenant_id=$1 AND room_id=$2 AND type='talk.new'",
        [tenant(), room],
      )
    ).rows[0];
    expect(row).toBeTruthy();
    return { room, occurrence: row.id as string, dedup: room + ":" + row.id };
  };
  const drain = async () => {
    for (let i = 0; i < 100; i++) if (!(await sender.tick())) return;
    throw new Error("Outbox did not drain.");
  };
  beforeAll(async () => {
    env = parseEnv(
      await readFile(
        "/workspace/.suite-runtime/j-talk/integration.env",
        "utf8",
      ),
    );
    if (env.JT_TEST_RUNTIME !== "isolated-cloud")
      throw new Error("Actual isolated Talk required; no skip.");
    rt = await integrationRuntime({
      serviceCa: await readFile(env.JT_TLS_CERTIFICATE!, "utf8"),
      serviceEndpointsForTenant: (_t, i) => ({
        "j-talk": `https://127.0.0.1:${55078 + i}`,
      }),
    });
    rt.secretValues.add(key);
    pool = new Pool({
      host: env.JT_DB_HOST,
      port: Number(env.JT_DB_PORT),
      database: "jgw_talk",
      user: "jgw_talk",
      password: env.JT_DB_PASSWORD,
      max: 5,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    pool.on("error", () => {});
    await migrate(pool);
    for (const [i, f] of rt.fixtures.entries()) {
      expect((await rt.subscribe(i, "j-talk")).status).toBe(200);
      const app = createTalkApp({
        pool,
        tenant: f.tenant,
        keycloakOrigin: f.config.keycloakOrigin,
        fetch: rt.fetchLoopback,
        https: {
          cert: await readFile(env.JT_TLS_CERTIFICATE!),
          key: await readFile(env.JT_TLS_KEY!),
        },
      });
      apps.push(app);
      await app.listen({ host: "127.0.0.1", port: 55078 + i });
    }
    store = new NotificationStore(rt.pool, tenant());
    await store.configure({ "j-talk": [digest(key)] });
    receiver = createNotificationReceiver(store);
    await receiver.listen({ host: "127.0.0.1", port: 0 });
    const address = receiver.server.address();
    if (!address || typeof address === "string")
      throw new Error("Receiver bind failed.");
    port = address.port;
    sender = new NotificationSender(
      pool,
      tenant(),
      `http://127.0.0.1:${port}`,
      key,
      rt.fetchLoopback,
    );
    owner = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    await owner.login(rt.fixtures[0]!.password);
    for (const [role, name] of [
      ["talk:read", "talk-notify-reader"],
      ["", "talk-notify-denied"],
    ]) {
      const password = randomBytes(24).toString("base64url");
      rt.secretValues.add(password);
      expect(
        (
          await owner.change("/api/members", {
            username: name,
            password,
            roles: role ? [role] : [],
          })
        ).status,
      ).toBe(201);
      const b = new Browser(rt.fetch, rt.fixtures[0]!.origin);
      await b.login(password, name);
      if (role) reader = b;
      else denied = b;
    }
    const password = randomBytes(24).toString("base64url");
    rt.secretValues.add(password);
    expect(
      (
        await owner.change("/api/members", {
          username: "talk-other-writer",
          password,
          roles: ["talk:write"],
        })
      ).status,
    ).toBe(201);
    otherWriter = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    await otherWriter.login(password, "talk-other-writer");
  });
  afterAll(async () => {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) {
        const ended = once(c, "exit");
        c.kill("SIGKILL");
        await ended;
      }
    await sender?.stop();
    await receiver?.close();
    for (const app of apps) await app.close();
    if (pool && rt) {
      for (const f of rt.fixtures)
        for (const table of ["event_outbox", "messages", "rooms", "visitors"])
          await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
            f.tenant,
          ]);
      await pool.end();
    }
    await rt?.close();
  });
  it("records a stable new-room occurrence in the room transaction and delivers only to current talk readers", async () => {
    const stream = await reader.request("/api/notifications/stream", {
      signal: AbortSignal.timeout(5000),
    });
    expect(stream.status).toBe(200);
    const streamReader = stream.body!.getReader();
    const created = await make();
    try {
      expect(await sender.tick()).toBe(true);
      let text = "";
      for (;;) {
        const chunk = await streamReader.read();
        if (chunk.done)
          throw new Error("SSE ended before the actual Talk notification.");
        text += new TextDecoder().decode(chunk.value);
        if (text.includes(created.room)) break;
      }
      expect(text).toContain("talk.new");
    } finally {
      await streamReader.cancel();
    }
    expect((await event(created.occurrence)).delivered_at).toBeInstanceOf(Date);
    expect(await count(created.dedup)).toBe(1);
    expect(
      (await page(reader)).items.some(
        (x) => x.type === "talk.new" && x.link.endsWith(created.room),
      ),
    ).toBe(true);
    expect(
      (await page(denied)).items.some((x) => x.link.endsWith(created.room)),
    ).toBe(false);
    const c = await pool.connect(),
      rolled = randomUUID();
    try {
      await c.query("BEGIN");
      const v = randomUUID();
      await c.query("INSERT INTO visitors(tenant_id,id) VALUES ($1,$2)", [
        tenant(),
        v,
      ]);
      await c.query(
        "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
        [tenant(), rolled, v],
      );
      expect(
        (
          await c.query(
            "SELECT 1 FROM event_outbox WHERE tenant_id=$1 AND room_id=$2",
            [tenant(), rolled],
          )
        ).rowCount,
      ).toBe(1);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(
      (
        await pool.query(
          "SELECT 1 FROM event_outbox WHERE tenant_id=$1 AND room_id=$2",
          [tenant(), rolled],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("records each accepted assignment separately with its original recipient, rollback-safe and role/CSRF guarded", async () => {
    const created = await make();
    await drain();
    const path = `/api/talk/rooms/${created.room}/assign-self`;
    expect((await reader.change(path, {})).status).toBe(403);
    expect(
      (
        await owner.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await owner.change(path, {})).status).toBe(200);
    expect((await otherWriter.change(path, {})).status).toBe(200);
    const rows = (
      await pool.query(
        "SELECT * FROM event_outbox WHERE tenant_id=$1 AND room_id=$2 AND type='talk.assigned'",
        [tenant(), created.room],
      )
    ).rows;
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((x) => x.id)).size).toBe(2);
    expect(new Set(rows.map((x) => x.recipient_member_id))).toEqual(
      new Set([(await owner.me()).subject, (await otherWriter.me()).subject]),
    );
    await drain();
    for (const row of rows)
      expect(await count(created.room + ":" + row.id)).toBe(1);
    expect(
      (await page(reader)).items.some(
        (x) => x.type === "talk.assigned" && x.link.endsWith(created.room),
      ),
    ).toBe(false);
    expect(
      (await page(owner)).items.filter(
        (x) => x.type === "talk.assigned" && x.link.endsWith(created.room),
      ).length,
    ).toBe(1);
    expect(
      (await page(otherWriter)).items.filter(
        (x) => x.type === "talk.assigned" && x.link.endsWith(created.room),
      ).length,
    ).toBe(1);
    await pool.query(
      "CREATE FUNCTION talk_test_refuse_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='talk.assigned' THEN RAISE EXCEPTION 'isolated occurrence refusal'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER talk_test_refuse_occurrence BEFORE INSERT ON event_outbox FOR EACH ROW EXECUTE FUNCTION talk_test_refuse_occurrence()",
    );
    try {
      const pending = await make();
      await drain();
      expect(
        (await owner.change(`/api/talk/rooms/${pending.room}/assign-self`, {}))
          .status,
      ).toBe(503);
      expect(
        (
          await pool.query(
            "SELECT status,assigned_member_id FROM rooms WHERE tenant_id=$1 AND id=$2",
            [tenant(), pending.room],
          )
        ).rows[0],
      ).toEqual({ status: "waiting", assigned_member_id: null });
    } finally {
      await pool.query(
        "DROP TRIGGER talk_test_refuse_occurrence ON event_outbox",
      );
      await pool.query("DROP FUNCTION talk_test_refuse_occurrence()");
    }
  });
  it("keeps pending events through an actual receiver outage and retries the same occurrence", async () => {
    await drain();
    const created = await make();
    await receiver.close();
    expect(await sender.tick()).toBe(true);
    expect((await event(created.occurrence)).last_error).toBe(
      "delivery_failed",
    );
    expect((await event(created.occurrence)).delivered_at).toBeNull();
    receiver = createNotificationReceiver(store);
    await receiver.listen({ host: "127.0.0.1", port });
    await pool.query(
      "UPDATE event_outbox SET available_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [tenant(), created.occurrence],
    );
    await drain();
    expect(await count(created.dedup)).toBe(1);
    expect((await event(created.occurrence)).attempts).toBe(2);
  });
  it("recovers ambiguous receipt/ack failure with one stored G22 notification", async () => {
    await drain();
    const created = await make();
    await pool.query(
      "CREATE FUNCTION talk_test_refuse_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.delivered_at IS NOT NULL THEN RAISE EXCEPTION 'isolated ack refusal'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER talk_test_refuse_ack BEFORE UPDATE ON event_outbox FOR EACH ROW EXECUTE FUNCTION talk_test_refuse_ack()",
    );
    try {
      expect(await sender.tick()).toBe(true);
      expect(await count(created.dedup)).toBe(1);
      expect((await event(created.occurrence)).delivered_at).toBeNull();
    } finally {
      await pool.query("DROP TRIGGER talk_test_refuse_ack ON event_outbox");
      await pool.query("DROP FUNCTION talk_test_refuse_ack()");
    }
    await pool.query(
      "UPDATE event_outbox SET available_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [tenant(), created.occurrence],
    );
    await drain();
    expect(await count(created.dedup)).toBe(1);
    expect((await event(created.occurrence)).delivered_at).toBeInstanceOf(Date);
  });
  it("leases across real sender instances and excludes message events and other tenants", async () => {
    await drain();
    const created = await make(),
      other = new NotificationSender(
        pool,
        tenant(),
        `http://127.0.0.1:${port}`,
        key,
        rt.fetchLoopback,
      );
    try {
      expect((await Promise.all([sender.tick(), other.tick()])).sort()).toEqual(
        [false, true],
      );
      expect(await count(created.dedup)).toBe(1);
      expect((await event(created.occurrence)).attempts).toBe(1);
    } finally {
      await other.stop();
    }
    const f = rt.fixtures[1]!.tenant,
      v = randomUUID(),
      room = randomUUID();
    await pool.query("INSERT INTO visitors(tenant_id,id) VALUES ($1,$2)", [
      f,
      v,
    ]);
    await pool.query(
      "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
      [f, room, v],
    );
    expect(await sender.tick()).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT delivered_at,attempts FROM event_outbox WHERE tenant_id=$1 AND room_id=$2",
          [f, room],
        )
      ).rows[0],
    ).toEqual({ delivered_at: null, attempts: 0 });
  });
  it("recovers a compiled sender killed after committing a real lease, with actual expiry and duplicate receipt", async () => {
    await drain();
    await receiver.close();
    let arrived!: () => void, release!: () => void;
    const arrival = new Promise<void>((r) => {
        arrived = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    receiver = createNotificationReceiver(store);
    receiver.addHook("preHandler", async () => {
      arrived();
      await gate;
    });
    await receiver.listen({ host: "127.0.0.1", port });
    const created = await make(),
      child = spawn(process.execPath, ["apps/server/dist/main.js"], {
        cwd: "/workspace/j-talk",
        env: {
          ...process.env,
          ...env,
          JT_TENANT: tenant(),
          JT_PORT: "55082",
          JT_NOTIFICATION_URL: `http://127.0.0.1:${port}`,
          JT_NOTIFICATION_KEY: key,
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    children.push(child);
    child.stdout?.on("data", (b) => logs.push(String(b)));
    child.stderr?.on("data", (b) => logs.push(String(b)));
    try {
      await Promise.race([
        arrival,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Compiled sender did not deliver.")),
            5000,
          ),
        ),
      ]);
      const claimed = await event(created.occurrence);
      expect(claimed.lease_token).toBeTruthy();
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
      release();
      await wait(async () => (await count(created.dedup)) === 1);
      expect(await sender.tick()).toBe(false);
      await wait(
        async () =>
          (
            await pool.query(
              "SELECT locked_until<=clock_timestamp() AS expired FROM event_outbox WHERE tenant_id=$1 AND id=$2",
              [tenant(), created.occurrence],
            )
          ).rows[0].expired === true,
        25000,
      );
      await drain();
      expect(await count(created.dedup)).toBe(1);
      expect((await event(created.occurrence)).attempts).toBe(2);
      for (const secret of rt.secretValues)
        expect(logs.join("") + rt.logs.join("")).not.toContain(secret);
    } finally {
      release();
      if (child.exitCode === null && child.signalCode === null) {
        const end = once(child, "exit");
        child.kill("SIGKILL");
        await end;
      }
    }
  });
});
