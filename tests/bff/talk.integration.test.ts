import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { decodeJwt } from "jose";
import { Browser, integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
describe("actual BFF talk member relay", () => {
  let rt: Runtime,
    pool: Pool,
    owner: Browser,
    reader: Browser,
    denied: Browser,
    foreign: Browser;
  const ids = [randomUUID(), randomUUID()],
    children: ReturnType<typeof spawn>[] = [],
    logs: string[] = [];
  beforeAll(async () => {
    const env = parseEnv(
      await readFile(
        "/workspace/.suite-runtime/j-talk/integration.env",
        "utf8",
      ),
    );
    if (
      env.JT_TEST_RUNTIME !== "isolated-cloud" ||
      (env.JT_DB_NAME && env.JT_DB_NAME !== "jgw_talk") ||
      (env.JT_DB_USER && env.JT_DB_USER !== "jgw_talk")
    )
      throw new Error("Actual isolated talk DB required. No skip.");
    rt = await integrationRuntime({
      serviceCa: await readFile(env.JT_TLS_CERTIFICATE!, "utf8"),
      serviceEndpointsForTenant: (_t, i) => ({
        "j-talk": `https://127.0.0.1:${55058 + i}`,
      }),
    });
    pool = new Pool({
      host: env.JT_DB_HOST,
      port: Number(env.JT_DB_PORT),
      database: "jgw_talk",
      user: "jgw_talk",
      password: env.JT_DB_PASSWORD,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    pool.on("error", () => {});
    expect(
      (
        await pool.query(
          "SELECT current_user,current_database() AS db,rolsuper FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0],
    ).toEqual({ current_user: "jgw_talk", db: "jgw_talk", rolsuper: false });
    for (const [i, f] of rt.fixtures.entries()) {
      expect((await rt.subscribe(i, "j-talk")).status).toBe(200);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "/workspace/j-groupware/tests/bff/resolve-messenger-test-hosts.mjs",
          "apps/server/dist/main.js",
        ],
        {
          cwd: "/workspace/j-talk",
          env: {
            ...process.env,
            ...env,
            JT_TENANT: f.tenant,
            JT_PORT: String(55058 + i),
          },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      child.stdout?.on("data", (b) => logs.push(String(b)));
      child.stderr?.on("data", (b) => logs.push(String(b)));
      let ready = false;
      for (let j = 0; j < 80; j++) {
        if (child.exitCode !== null)
          throw new Error("Talk child stopped before readiness.");
        try {
          if (
            (
              await rt.fetchLoopback(
                `https://127.0.0.1:${55058 + i}/health/ready`,
                { signal: AbortSignal.timeout(300) },
              )
            ).ok
          ) {
            ready = true;
            break;
          }
        } catch {
          /* bounded readiness */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ready) throw new Error("Actual talk service not ready.");
      const visitor = randomUUID();
      await pool.query(
        "INSERT INTO visitors(tenant_id,id,guest_id) VALUES ($1,$2,$3)",
        [f.tenant, visitor, "signed-storage-fixture"],
      );
      await pool.query(
        "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
        [f.tenant, ids[i], visitor],
      );
    }
    owner = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    foreign = new Browser(rt.fetch, rt.fixtures[1]!.origin);
    await owner.login(rt.fixtures[0]!.password);
    await foreign.login(rt.fixtures[1]!.password);
    for (const [role, name] of [
      ["talk:read", "relay-reader"],
      ["", "relay-denied"],
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
  });
  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        timer.unref();
        await done;
        clearTimeout(timer);
      }
    }
    if (pool && rt) {
      for (const f of rt.fixtures) {
        for (const table of [
          "event_outbox",
          "messages",
          "rooms",
          "visitors",
          "allowed_origins",
          "widget_keys",
        ])
          await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
            f.tenant,
          ]);
      }
      await pool.end();
    }
    await rt?.close();
  });
  it("uses opaque BFF session and actual single j-talk exchange for read/tenant masks", async () => {
    const r = await reader.request(`/api/talk/rooms/${ids[0]}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      id: ids[0],
      status: "waiting",
      guestId: "signed-storage-fixture",
    });
    expect((await foreign.request(`/api/talk/rooms/${ids[0]}`)).status).toBe(
      404,
    );
    expect((await denied.request(`/api/talk/rooms/${ids[0]}`)).status).toBe(
      403,
    );
    expect(
      (
        await new Browser(rt.fetch, rt.fixtures[0]!.origin).request(
          `/api/talk/rooms/${ids[0]}`,
        )
      ).status,
    ).toBe(401);
    const rows = await rt.pool.query(
      "SELECT access_token FROM service_tokens WHERE tenant_id=$1 AND service_id='j-talk'",
      [rt.fixtures[0]!.tenant],
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      rt.secretValues.add(row.access_token);
      expect(decodeJwt(row.access_token).aud).toBe("j-talk");
    }
  });
  it("guards writes with talk:write and CSRF before actual service mutation", async () => {
    const url = `/api/talk/rooms/${ids[0]}/assign-self`;
    expect((await reader.change(url, {})).status).toBe(403);
    expect(
      (
        await owner.request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const assigned = await owner.change(url, {});
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({
      status: "in_progress",
      assignedMemberId: (await owner.me()).subject,
    });
    expect((await owner.change(url, { memberId: randomUUID() })).status).toBe(
      400,
    );
  });
  it("relays actual atomic message/dedup/page and keeps delivery pending", async () => {
    const url = `/api/talk/rooms/${ids[0]}/messages`,
      body = { requestId: randomUUID(), text: "actual BFF plain-text reply" };
    const first = await owner.change(url, body);
    expect(first.status).toBe(200);
    const result = (await first.json()) as { id: string; delivery: string };
    expect(result.delivery).toBe("pending");
    expect(await (await owner.change(url, body)).json()).toEqual(result);
    const messages = await reader.request(url + "?limit=1");
    expect(messages.status).toBe(200);
    expect(await messages.json()).toMatchObject({
      items: [{ id: result.id, text: body.text }],
      next: null,
    });
    expect((await foreign.request(url)).status).toBe(404);
    expect(
      (
        await owner.change(url, {
          requestId: randomUUID(),
          text: "가".repeat(1366),
        })
      ).status,
    ).toBe(400);
  });
  it("relays settings/origins and one-time key without permitting arbitrary target or tenant", async () => {
    const origin = "https://relay-site.example.test";
    expect(
      (await owner.change("/api/talk/settings/origins", { origin })).status,
    ).toBe(201);
    expect(
      await (await owner.request("/api/talk/settings/origins?limit=1")).json(),
    ).toEqual({ items: [origin], next: null });
    expect((await reader.request("/api/talk/settings/origins")).status).toBe(
      403,
    );
    const key = (await (
      await owner.change("/api/talk/settings/widget-key", {})
    ).json()) as { key: string };
    expect(key.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    rt.secretValues.add(key.key);
    const status = await owner.request("/api/talk/settings/widget-key");
    expect(await status.text()).not.toContain(key.key);
    for (const url of [
      "/api/talk/rooms?tenant=other",
      "/api/talk/rooms?url=https://external.example",
      "/api/talk/rooms?limit=101",
    ])
      expect((await owner.request(url)).status).toBe(400);
    expect(
      (await owner.change("/api/talk/settings/origins", { origin }, "DELETE"))
        .status,
    ).toBe(204);
  });
  it("relays close and preserves downstream conflicts, then fails closed on real service outage", async () => {
    expect(
      (await owner.change(`/api/talk/rooms/${ids[0]}/close`, {})).status,
    ).toBe(200);
    expect(
      (
        await owner.change(`/api/talk/rooms/${ids[0]}/messages`, {
          requestId: randomUUID(),
          text: "closed",
        })
      ).status,
    ).toBe(409);
    const child = children[0]!,
      done = once(child, "exit");
    child.kill("SIGTERM");
    await done;
    expect((await owner.request(`/api/talk/rooms/${ids[0]}`)).status).toBe(503);
    for (const secret of rt.secretValues)
      expect(logs.join("\n")).not.toContain(secret);
  });
});
