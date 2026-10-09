import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Browser, integrationRuntime, type Runtime } from "./runtime.js";
import { NotificationStore } from "../../apps/server/src/db/notifications.js";
import { createNotificationReceiver } from "../../apps/server/src/notification-receiver.js";
import { digest } from "../../apps/server/src/security.js";
import { customerBrowser } from "./customer-browser.js";
import type {
  NotificationInput,
  NotificationPage,
  NotificationKeyHashes,
} from "@j-groupware/permissions/notifications";
import type { ApprovalDocument } from "@j-approval/contracts";
import { createApp as createApprovalApp } from "../../../j-approval/apps/server/dist/app.js";
import { NotificationSender } from "../../../j-approval/apps/server/dist/notification-sender.js";

describe("actual notification receipt + approval outbox delivery + SSE and recovery", () => {
  let approvalEnv: NodeJS.ProcessEnv;
  const workerChildren: ReturnType<typeof spawn>[] = [];
  const workerLogs: string[] = [];
  let rt: Runtime, approvalPool: Pool, admin: Browser, foreign: Browser;
  const approvalApps: ReturnType<typeof createApprovalApp>[] = [],
    stores: NotificationStore[] = [],
    receivers: ReturnType<typeof createNotificationReceiver>[] = [],
    senders: NotificationSender[] = [];
  const keys: Array<Record<"j-approval" | "j-mail" | "j-talk", string>> = [];
  const actors: {
    id: string;
    username: string;
    password: string;
    b: Browser;
  }[] = [];
  const streams: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    cancel: () => Promise<void>;
  }[] = [];
  const keyConfig = (index = 0): NotificationKeyHashes =>
    Object.fromEntries(
      Object.entries(keys[index]!).map(([service, key]) => [
        service,
        [digest(key)],
      ]),
    );
  beforeAll(async () => {
    const env = parseEnv(
      await readFile(
        process.env.JAP_TEST_ENV ??
          "/workspace/.suite-runtime/j-approval/integration.env",
        "utf8",
      ),
    );
    approvalEnv = env;
    if (
      env.JAP_TEST_RUNTIME !== "isolated-cloud" ||
      env.JAP_DB_NAME !== "jgw_approval" ||
      env.JAP_DB_USER !== "jgw_approval"
    )
      throw new Error("Dedicated isolated approval runtime required.");
    rt = await integrationRuntime({
      serviceCa: await readFile(env.JAP_TLS_CERTIFICATE!, "utf8"),
      serviceEndpointsForTenant: (_t, i) => ({
        "j-approval": `https://127.0.0.1:${54242 + i}`,
      }),
    });
    approvalPool = new Pool({
      host: env.JAP_DB_HOST,
      port: Number(env.JAP_DB_PORT),
      database: env.JAP_DB_NAME,
      user: env.JAP_DB_USER,
      password: env.JAP_DB_PASSWORD,
      max: 5,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    if (
      (await approvalPool.query("SELECT 1 FROM approval_documents LIMIT 1"))
        .rowCount
    )
      throw new Error("Unknown approval documents preserved.");
    const tls = {
      cert: await readFile(env.JAP_TLS_CERTIFICATE!),
      key: await readFile(env.JAP_TLS_KEY!),
    };
    for (const [index, f] of rt.fixtures.entries()) {
      for (const service of ["j-approval", "j-talk", "j-mail"])
        expect((await rt.subscribe(index, service)).status).toBe(200);
      const app = createApprovalApp({
        pool: approvalPool,
        tenant: f.tenant,
        keycloakOrigin: f.config.keycloakOrigin,
        fetch: rt.fetchLoopback,
        https: tls,
      });
      approvalApps.push(app);
      await app.listen({ host: "127.0.0.1", port: 54242 + index });
      keys.push({
        "j-approval": randomBytes(32).toString("base64url"),
        "j-mail": randomBytes(32).toString("base64url"),
        "j-talk": randomBytes(32).toString("base64url"),
      });
      for (const key of Object.values(keys[index]!)) rt.secretValues.add(key);
      const store = new NotificationStore(rt.pool, f.tenant);
      stores.push(store);
      await store.configure(keyConfig(index));
      const receiver = createNotificationReceiver(store);
      receivers.push(receiver);
      await receiver.listen({ host: "127.0.0.1", port: 54246 + index });
      senders.push(
        new NotificationSender(
          approvalPool,
          f.tenant,
          `http://127.0.0.1:${54246 + index}`,
          keys[index]!["j-approval"],
          rt.fetchLoopback,
        ),
      );
    }
    admin = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    await admin.login(rt.fixtures[0]!.password);
    foreign = new Browser(rt.fetch, rt.fixtures[1]!.origin);
    await foreign.login(rt.fixtures[1]!.password);
    for (let i = 0; i < 4; i++) {
      const username = `notification-${i}`,
        password = randomBytes(24).toString("base64url");
      rt.secretValues.add(password);
      const response = await admin.change("/api/members", {
        username,
        password,
        roles: i === 3 ? [] : ["approval:use"],
      });
      expect(response.status).toBe(201);
      const id = ((await response.json()) as { id: string }).id,
        b = new Browser(rt.fetch, rt.fixtures[0]!.origin);
      await b.login(password, username);
      actors.push({ id, username, password, b });
    }
  });
  afterAll(async () => {
    for (const child of workerChildren) await stopWorker(child);
    for (const stream of streams) await stream.cancel().catch(() => undefined);
    for (const sender of senders) await sender.stop();
    for (const receiver of receivers) await receiver.close();
    for (const app of approvalApps) await app.close();
    if (approvalPool) {
      const client = await approvalPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "LOCK TABLE approval_documents,approval_stages,approval_history,notification_outbox IN ACCESS EXCLUSIVE MODE",
        );
        const allowed = new Set(rt?.fixtures.map((f) => f.tenant) ?? []);
        const rows = await client.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM approval_documents",
        );
        if (rows.rows.some((row) => !allowed.has(row.tenant_id)))
          throw new Error("Unknown approval data preserved.");
        await client.query(
          "TRUNCATE approval_documents,approval_stages,approval_history,notification_outbox",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
        await approvalPool.end();
      }
    }
    if (rt) await rt.close();
  });
  const post = (payload: unknown, key = keys[0]!["j-approval"], index = 0) =>
    rt.fetchLoopback(
      `http://127.0.0.1:${54246 + index}/internal/notifications`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-JGW-Internal-Key": key,
        },
        body: JSON.stringify(payload),
      },
    );
  const input = (members = [actors[0]!.id]): NotificationInput => ({
    tenant: rt.fixtures[0]!.tenant,
    service: "j-approval",
    type: "approval.turn",
    members,
    title: "결재 알림",
    body: "차례입니다.",
    link: `/approval/documents/${randomUUID()}`,
    dedupKey: randomUUID(),
  });
  const page = async (b = admin) => {
    const response = await b.request("/api/notifications");
    expect(response.status).toBe(200);
    return (await response.json()) as NotificationPage;
  };
  const make = async () => {
    const response = await admin.change("/api/approval/documents", {
      title: "E2E approval",
      body: "secret document body",
      memberIds: [actors[0]!.id, actors[1]!.id],
    });
    expect(response.status).toBe(201);
    return (await response.json()) as ApprovalDocument;
  };
  const drain = async (index = 0) => {
    for (let i = 0; i < 100; i++) if (!(await senders[index]!.tick())) return;
    throw new Error("Delivery did not quiesce.");
  };
  const event = async (id: string) =>
    (
      await approvalPool.query(
        "SELECT * FROM notification_outbox WHERE document_id=$1 ORDER BY created_at,id",
        [id],
      )
    ).rows[0];
  const deliveryCount = async (doc: string) =>
    Number(
      (
        await rt.pool.query(
          "SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND link=$2",
          [rt.fixtures[0]!.tenant, `/approval/documents/${doc}`],
        )
      ).rows[0].n,
    );
  const wait = async (check: () => Promise<boolean>, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Actual state was not observed within the deadline.");
  };
  const stopWorker = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  };
  const startWorker = async (port = 54248, url = "http://127.0.0.1:54246") => {
    const root = fileURLToPath(
      new URL("../../../j-approval/", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        root + "tests/integration/resolve-test-hosts.mjs",
        root + "apps/server/dist/main.js",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ...approvalEnv,
          JAP_TENANT: rt.fixtures[0]!.tenant,
          JAP_PORT: String(port),
          JAP_NOTIFICATION_URL: url,
          JAP_NOTIFICATION_KEY: keys[0]!["j-approval"],
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    workerChildren.push(child);
    child.stdout?.on("data", (value: Buffer) =>
      workerLogs.push(value.toString()),
    );
    child.stderr?.on("data", (value: Buffer) =>
      workerLogs.push(value.toString()),
    );
    await wait(async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Compiled sender stopped before readiness.");
      try {
        return (
          await rt.fetchLoopback(
            `https://approval.jgw.test:${port}/health/ready`,
            { signal: AbortSignal.timeout(300) },
          )
        ).ok;
      } catch {
        return false;
      }
    });
    return child;
  };
  const open = async (b: Browser) => {
    const response = await b.request("/api/notifications/stream");
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let buffer = "";
    const stream = {
      reader,
      cancel: async () => {
        await reader.cancel();
      },
    };
    streams.push(stream);
    return {
      next: async (predicate: (page: NotificationPage) => boolean) => {
        const deadline = Date.now() + 5000;
        for (;;) {
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) break;
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const match = frame.match(/^event: notifications\ndata: (.+)$/);
            if (match) {
              const value = JSON.parse(match[1]!) as NotificationPage;
              if (predicate(value)) return value;
            }
          }
          if (Date.now() > deadline)
            throw new Error(
              "Expected actual SSE notification was not received.",
            );
          const chunk = await reader.read();
          if (chunk.done)
            throw new Error("Stream closed before expected notification.");
          buffer += new TextDecoder().decode(chunk.value);
        }
      },
      reader,
      cancel: stream.cancel,
    };
  };

  it("binds receipt to a separate actual loopback port and registered service/tenant key", async () => {
    expect(
      (await admin.change("/internal/notifications", input())).status,
    ).toBe(404);
    expect((await post(input(), "wrong-key-wrong-key-wrong-key")).status).toBe(
      401,
    );
    expect((await post(input(), keys[0]!["j-mail"])).status).toBe(401);
    expect((await post(input(), keys[1]!["j-approval"])).status).toBe(401);
    expect(
      (
        await post(
          { ...input(), tenant: rt.fixtures[1]!.tenant },
          keys[1]!["j-approval"],
        )
      ).status,
    ).toBe(400);
    const browser = await rt.fetchLoopback(
      "http://127.0.0.1:54246/internal/notifications",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-JGW-Internal-Key": keys[0]!["j-approval"],
          Origin: admin.origin,
        },
        body: JSON.stringify(input()),
      },
    );
    expect(browser.status).toBe(403);
  });
  it("delivers an actual submitted outbox event to recipient list/unread and live SSE only", async () => {
    const stream = await open(actors[0]!.b);
    await stream.next(() => true);
    const doc = await make();
    await drain();
    expect((await event(doc.id)).delivered_at).toBeInstanceOf(Date);
    expect(await deliveryCount(doc.id)).toBe(1);
    const received = await stream.next((value) =>
      value.items.some((item) => item.link === `/approval/documents/${doc.id}`),
    );
    expect(received.unread).toBeGreaterThan(0);
    expect(
      (await page(actors[0]!.b)).items.some(
        (item) => item.link === `/approval/documents/${doc.id}`,
      ),
    ).toBe(true);
    for (const b of [admin, actors[1]!.b, actors[2]!.b, actors[3]!.b, foreign])
      expect(
        (await page(b)).items.some(
          (item) => item.link === `/approval/documents/${doc.id}`,
        ),
      ).toBe(false);
    await stream.cancel();
  });
  it("delivers next-stage turn and terminal done to the intended real approval actors", async () => {
    const doc = await make();
    await drain();
    const first = await actors[0]!.b.change(
      `/api/approval/documents/${doc.id}/decisions`,
      { revision: 0, action: "approve" },
    );
    expect(first.status).toBe(200);
    await drain();
    expect(
      (await page(actors[1]!.b)).items.some(
        (item) => item.type === "approval.turn" && item.link.endsWith(doc.id),
      ),
    ).toBe(true);
    const last = await actors[1]!.b.change(
      `/api/approval/documents/${doc.id}/decisions`,
      { revision: 1, action: "approve" },
    );
    expect(last.status).toBe(200);
    await drain();
    expect(
      (await page()).items.find(
        (item) => item.type === "approval.done" && item.link.endsWith(doc.id),
      )?.body,
    ).toBe("문서가 승인되었습니다.");
    expect(await deliveryCount(doc.id)).toBe(3);
  });
  it("delivers actual rejection to the author without copying the private reason/body", async () => {
    const doc = await make();
    await drain();
    expect(
      (
        await actors[0]!.b.change(
          `/api/approval/documents/${doc.id}/decisions`,
          {
            revision: 0,
            action: "reject",
            reason: "private rejection details",
          },
        )
      ).status,
    ).toBe(200);
    await drain();
    const received = (await page()).items.find((item) =>
      item.link.endsWith(doc.id),
    );
    expect(received?.type).toBe("approval.done");
    expect(received?.body).toBe("문서가 반려되었습니다.");
    expect(JSON.stringify(received)).not.toContain("private rejection details");
    expect(JSON.stringify(received)).not.toContain("secret document body");
  });
  it("deduplicates concurrent actual receipts and rejects a changed payload under the same event key", async () => {
    const payload = input(),
      responses = await Promise.all([post(payload), post(payload)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const receipts = (await Promise.all(responses.map((r) => r.json()))) as {
      id: string;
      duplicate: boolean;
    }[];
    expect(receipts[0]!.id).toBe(receipts[1]!.id);
    expect(receipts.map((x) => x.duplicate).sort()).toEqual([false, true]);
    expect((await post({ ...payload, body: "changed" })).status).toBe(409);
    expect((await post({ ...payload, dedupKey: randomUUID() })).status).toBe(
      200,
    );
    const other = {
      ...payload,
      service: "j-talk",
      type: "talk.assigned",
      link: `/talk/rooms/${randomUUID()}`,
    };
    expect((await post(other, keys[0]!["j-talk"])).status).toBe(200);
  });
  it("validates registered types, one target, UTF-8 body size and safe local links", async () => {
    const payload = input();
    for (const changed of [
      { type: "unknown" },
      { service: "j-mail" },
      { role: "approval:use" },
      { members: [] },
      { members: [actors[0]!.id, actors[0]!.id] },
      { link: "https://outside.test/path" },
      { link: "//outside.test" },
      { link: "/approval/documents/../admin" },
      { link: payload.link + "?token=x" },
      { body: "가".repeat(342) },
      { body: "\u0000" },
      { extra: "ignored" },
    ])
      expect((await post({ ...payload, ...changed })).status).toBe(400);
    expect((await post({ ...payload, body: "가".repeat(341) })).status).toBe(
      200,
    );
  });
  it("filters member ids, usernames and role targets with current roles and member-specific read state", async () => {
    const role = { ...input(), members: undefined, role: "approval:use" };
    const roleResponse = await post(role);
    expect(roleResponse.status).toBe(200);
    const id = ((await roleResponse.json()) as { id: string }).id;
    for (const b of [admin, actors[0]!.b, actors[1]!.b, actors[2]!.b])
      expect((await page(b)).items.some((item) => item.id === id)).toBe(true);
    for (const b of [actors[3]!.b, foreign]) {
      expect((await page(b)).items.some((item) => item.id === id)).toBe(false);
      expect(
        (await b.change(`/api/notifications/${id}/read`, undefined)).status,
      ).toBe(404);
    }
    const before = (await page(actors[0]!.b)).unread,
      response = await actors[0]!.b.change(
        `/api/notifications/${id}/read`,
        undefined,
      );
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(
      await (
        await actors[0]!.b.change(`/api/notifications/${id}/read`, undefined)
      ).json(),
    ).toEqual(receipt);
    expect((await page(actors[0]!.b)).unread).toBe(before - 1);
    expect(
      (await page(actors[1]!.b)).items.find((item) => item.id === id)?.readAt,
    ).toBeNull();
    const named = {
      ...input(),
      members: undefined,
      usernames: [actors[1]!.username],
    };
    const result = await post(named);
    expect(result.status).toBe(200);
    const namedId = ((await result.json()) as { id: string }).id;
    expect(
      (await page(actors[1]!.b)).items.some((item) => item.id === namedId),
    ).toBe(true);
    expect(
      (await page(actors[0]!.b)).items.some((item) => item.id === namedId),
    ).toBe(false);
  });
  it("paginates actual receipts without omission and binds cursors to the current tenant/member", async () => {
    const username = "notification-page",
      password = randomBytes(24).toString("base64url");
    rt.secretValues.add(password);
    const created = await admin.change("/api/members", {
      username,
      password,
      roles: ["approval:use"],
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id,
      b = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    await b.login(password, username);
    const existing = (await page(b)).items.map((item) => item.id),
      received: string[] = [];
    for (let i = 0; i < 51; i++) {
      const response = await post(input([id]));
      expect(response.status).toBe(200);
      received.push(((await response.json()) as { id: string }).id);
    }
    const first = await page(b);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    expect(first.unread).toBe(existing.length + received.length);
    const response = await b.request(
      `/api/notifications?cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(response.status).toBe(200);
    const second = (await response.json()) as NotificationPage;
    expect(second.nextCursor).toBeNull();
    expect(second.unread).toBe(first.unread);
    const all = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...existing, ...received].sort());
    for (const other of [admin, foreign])
      expect(
        (
          await other.request(
            `/api/notifications?cursor=${encodeURIComponent(first.nextCursor!)}`,
          )
        ).status,
      ).toBe(400);
    expect((await b.request("/api/notifications?cursor=broken")).status).toBe(
      400,
    );
  });
  it("persists receiver failure and retries after the real configured backoff", async () => {
    await drain();
    const doc = await make();
    await receivers[0]!.close();
    expect(await senders[0]!.tick()).toBe(true);
    const failed = await event(doc.id);
    expect(failed.delivered_at).toBeNull();
    expect(failed.last_error).toBe("delivery_failed");
    expect(failed.attempts).toBe(1);
    expect(await deliveryCount(doc.id)).toBe(0);
    expect(await senders[0]!.tick()).toBe(false);
    receivers[0] = createNotificationReceiver(stores[0]!);
    await receivers[0].listen({ host: "127.0.0.1", port: 54246 });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(await senders[0]!.tick()).toBe(true);
    expect((await event(doc.id)).delivered_at).toBeInstanceOf(Date);
    expect(await deliveryCount(doc.id)).toBe(1);
  });
  it("recovers from actual receipt followed by an acknowledgement DB failure without a second notification", async () => {
    await drain();
    const doc = await make();
    await approvalPool.query(
      "CREATE FUNCTION test_fail_delivery_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.delivered_at IS NOT NULL THEN RAISE EXCEPTION 'isolated ack failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_delivery_ack BEFORE UPDATE ON notification_outbox FOR EACH ROW EXECUTE FUNCTION test_fail_delivery_ack()",
    );
    try {
      expect(await senders[0]!.tick()).toBe(true);
      expect(await deliveryCount(doc.id)).toBe(1);
      expect((await event(doc.id)).delivered_at).toBeNull();
    } finally {
      await approvalPool.query(
        "DROP TRIGGER test_delivery_ack ON notification_outbox; DROP FUNCTION test_fail_delivery_ack()",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(await senders[0]!.tick()).toBe(true);
    expect((await event(doc.id)).attempts).toBe(2);
    expect((await event(doc.id)).delivered_at).toBeInstanceOf(Date);
    expect(await deliveryCount(doc.id)).toBe(1);
  });
  it("leases across two sender instances and sends a given pending event once", async () => {
    await drain();
    const doc = await make(),
      other = new NotificationSender(
        approvalPool,
        rt.fixtures[0]!.tenant,
        "http://127.0.0.1:54246",
        keys[0]!["j-approval"],
        rt.fetchLoopback,
      );
    try {
      expect(
        (await Promise.all([senders[0]!.tick(), other.tick()])).sort(),
      ).toEqual([false, true]);
      expect((await event(doc.id)).attempts).toBe(1);
      expect(await deliveryCount(doc.id)).toBe(1);
    } finally {
      await other.stop();
    }
  });

  it("recovers a real killed sender's committed lease and ambiguous receipt after actual expiry", async () => {
    await drain();
    await receivers[0]!.close();
    let reached!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const receiver = createNotificationReceiver(stores[0]!);
    receiver.addHook("preHandler", async () => {
      reached();
      await gate;
    });
    receivers[0] = receiver;
    await receiver.listen({ host: "127.0.0.1", port: 54246 });
    const doc = await make(),
      child = await startWorker();
    try {
      await arrived;
      const claimed = await event(doc.id);
      expect(claimed.lease_token).toBeTruthy();
      expect(claimed.delivered_at).toBeNull();
      expect(claimed.attempts).toBe(1);
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
      release();
      await wait(async () => (await deliveryCount(doc.id)) === 1);
      expect(await senders[0]!.tick()).toBe(false);
      await wait(
        async () =>
          (
            await approvalPool.query(
              "SELECT locked_until<=clock_timestamp() AS expired FROM notification_outbox WHERE tenant_id=$1 AND id=$2",
              [rt.fixtures[0]!.tenant, claimed.id],
            )
          ).rows[0].expired === true,
        25000,
      );
      expect(await senders[0]!.tick()).toBe(true);
      expect((await event(doc.id)).attempts).toBe(2);
      expect((await event(doc.id)).delivered_at).toBeInstanceOf(Date);
      expect(await deliveryCount(doc.id)).toBe(1);
    } finally {
      release();
      await stopWorker(child);
    }
  });
  it("supports key overlap/removal and configured inactive service refusal without leaking stored alerts", async () => {
    const old = keys[0]!["j-approval"],
      next = randomBytes(32).toString("base64url");
    rt.secretValues.add(next);
    await stores[0]!.configure({
      ...keyConfig(),
      "j-approval": [digest(old), digest(next)],
    });
    const payload = input();
    expect((await post(payload, old)).status).toBe(200);
    expect((await post(payload, next)).status).toBe(200);
    await stores[0]!.configure({
      ...keyConfig(),
      "j-approval": [digest(next)],
    });
    expect((await post(input(), old)).status).toBe(401);
    expect((await post(input(), next)).status).toBe(200);
    await rt.pool.query(
      "UPDATE notification_services SET active=false WHERE tenant_id=$1 AND service='j-approval'",
      [rt.fixtures[0]!.tenant],
    );
    expect((await post(input(), next)).status).toBe(403);
    expect(
      (await page(actors[0]!.b)).items.filter(
        (item) => item.service === "j-approval",
      ),
    ).toEqual([]);
    await stores[0]!.configure(keyConfig());
  });
  it("closes an actual role-revoked SSE session and denies alerts to a fresh no-role member", async () => {
    const target = actors[2]!,
      stream = await open(target.b);
    await stream.next(() => true);
    const ended = (async () => {
      while (!(await stream.reader.read()).done) {
        /* Drain allowed snapshots until actual session end. */
      }
    })();
    expect(
      (
        await admin.change(
          `/api/members/${target.id}/roles/approval:use`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    await ended;
    const fresh = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    await fresh.login(target.password, target.username);
    expect((await page(fresh)).items).toEqual([]);
    expect((await page(fresh)).unread).toBe(0);
  });
  it("purges actual 30-day expired notifications with cascading read state and preserves recent rows", async () => {
    const response = await post(input([actors[0]!.id])),
      id = ((await response.json()) as { id: string }).id;
    expect(
      (await actors[0]!.b.change(`/api/notifications/${id}/read`, undefined))
        .status,
    ).toBe(200);
    await rt.pool.query(
      "UPDATE notifications SET created_at=clock_timestamp()-interval '31 days' WHERE tenant_id=$1 AND id=$2",
      [rt.fixtures[0]!.tenant, id],
    );
    expect(
      (await page(actors[0]!.b)).items.some((item) => item.id === id),
    ).toBe(false);
    expect(await stores[0]!.purge()).toBe(1);
    expect(
      (
        await rt.pool.query(
          "SELECT 1 FROM notification_reads WHERE notification_id=$1",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    expect((await page(actors[0]!.b)).items.length).toBeGreaterThan(0);
  });

  it("shows a real SSE notification, marks it read and follows only the allowed customer route", async () => {
    const ui = await customerBrowser(rt, admin);
    try {
      const unreadBefore = (await page(admin)).unread;
      await ui.page.goto(ui.origin + "/board");
      await ui.page
        .getByRole("link", { name: `알림 (${unreadBefore})`, exact: true })
        .waitFor();
      const payload = {
        ...input([(await admin.me()).subject]),
        title: "브라우저 수신 알림",
      };
      const response = await post(payload);
      expect(response.status).toBe(200);
      const received = (await response.json()) as { id: string };
      await ui.page
        .getByRole("link", { name: `알림 (${unreadBefore + 1})`, exact: true })
        .click();
      await ui.page
        .getByRole("button", { name: "열기 브라우저 수신 알림", exact: true })
        .click();
      await ui.page
        .getByRole("heading", { name: "결재", exact: true })
        .waitFor();
      expect(new URL(ui.page.url()).pathname).toBe(payload.link);
      await ui.page
        .getByRole("link", { name: `알림 (${unreadBefore})`, exact: true })
        .waitFor();
      expect(
        (
          await rt.pool.query(
            "SELECT count(*)::int AS n FROM notification_reads WHERE tenant_id=$1 AND notification_id=$2 AND member_id=$3",
            [rt.fixtures[0]!.tenant, received.id, (await admin.me()).subject],
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(ui.pageErrors).toEqual([]);
    } finally {
      await ui.close();
    }
  });
  it("runs compiled receiver and automatic sender through startup, actual receipt, and clean shutdown", async () => {
    await drain();
    const doc = await make();
    const savedPort = process.env.JGW_INTERNAL_NOTIFICATIONS_PORT,
      savedKeys = process.env.JGW_NOTIFICATION_SERVICE_KEY_HASHES;
    process.env.JGW_INTERNAL_NOTIFICATIONS_PORT = "54249";
    process.env.JGW_NOTIFICATION_SERVICE_KEY_HASHES =
      JSON.stringify(keyConfig());
    const bff = await rt.startCompiled();
    let worker: ReturnType<typeof spawn> | undefined;
    try {
      worker = await startWorker(54248, "http://127.0.0.1:54249");
      await wait(async () => Boolean((await event(doc.id)).delivered_at));
      expect(await deliveryCount(doc.id)).toBe(1);
      const b = new Browser(rt.fetchLoopback, rt.fixtures[0]!.origin);
      await b.login(actors[0]!.password, actors[0]!.username);
      expect(
        (await page(b)).items.some((item) => item.link.endsWith(doc.id)),
      ).toBe(true);
      await stopWorker(worker);
      expect(worker.exitCode).toBe(0);
      await rt.stop(bff);
      expect(bff.exitCode).toBe(0);
      for (const secret of rt.secretValues)
        expect(workerLogs.join("") + rt.logs.join("")).not.toContain(secret);
    } finally {
      if (worker) await stopWorker(worker);
      await rt.stop(bff);
      if (savedPort === undefined)
        delete process.env.JGW_INTERNAL_NOTIFICATIONS_PORT;
      else process.env.JGW_INTERNAL_NOTIFICATIONS_PORT = savedPort;
      if (savedKeys === undefined)
        delete process.env.JGW_NOTIFICATION_SERVICE_KEY_HASHES;
      else process.env.JGW_NOTIFICATION_SERVICE_KEY_HASHES = savedKeys;
    }
  });
});
