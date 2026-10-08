import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { decodeJwt } from "jose";
import type {
  ApprovalDocument,
  DocumentPage,
  HistoryPage,
} from "@j-approval/contracts";
import { Browser, integrationRuntime, type Runtime } from "./runtime.js";
import { digest } from "../../apps/server/src/security.js";

describe("actual BFF + compiled approval + Keycloak + two tenant databases", () => {
  let rt: Runtime, pool: Pool, admin: Browser, second: Browser;
  const children: ReturnType<typeof spawn>[] = [];
  const actors: { id: string; browser: Browser }[] = [];
  const logs: string[] = [];
  const stop = async (child: ReturnType<typeof spawn>) => {
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
  beforeAll(async () => {
    const env = parseEnv(
      await readFile(
        process.env.JAP_TEST_ENV ??
          "/workspace/.suite-runtime/j-approval/integration.env",
        "utf8",
      ),
    );
    if (
      env.JAP_TEST_RUNTIME !== "isolated-cloud" ||
      env.JAP_DB_NAME !== "jgw_approval" ||
      env.JAP_DB_USER !== "jgw_approval"
    )
      throw new Error("Dedicated isolated approval runtime required. No skip.");
    process.env.JGW_TEST_APPROVAL_CA = env.JAP_TLS_CERTIFICATE;
    rt = await integrationRuntime({
      serviceCa: await readFile(env.JAP_TLS_CERTIFICATE!, "utf8"),
      serviceEndpoints: { "j-approval": "https://127.0.0.1:54242" },
      serviceEndpointsForTenant: (_tenant, index) => ({
        "j-approval": `https://127.0.0.1:${54242 + index}`,
      }),
    });
    pool = new Pool({
      host: env.JAP_DB_HOST,
      port: Number(env.JAP_DB_PORT),
      database: env.JAP_DB_NAME,
      user: env.JAP_DB_USER,
      password: env.JAP_DB_PASSWORD,
      max: 5,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    if ((await pool.query("SELECT 1 FROM approval_documents LIMIT 1")).rowCount)
      throw new Error(
        "Existing approval data preserved. Empty test database required.",
      );
    for (const [index, fixture] of rt.fixtures.entries()) {
      expect((await rt.subscribe(index, "j-approval")).status).toBe(200);
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
            ...env,
            JAP_TENANT: fixture.tenant,
            JAP_PORT: String(54242 + index),
          },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      child.stdout?.on("data", (b: Buffer) => logs.push(b.toString()));
      child.stderr?.on("data", (b: Buffer) => logs.push(b.toString()));
      let ready = false;
      for (let i = 0; i < 50; i++) {
        if (child.exitCode !== null)
          throw new Error("Actual compiled approval startup failed.");
        try {
          ready = (
            await rt.fetchLoopback(
              `https://approval.jgw.test:${54242 + index}/health/ready`,
              { signal: AbortSignal.timeout(300) },
            )
          ).ok;
        } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error("Actual approval readiness failed.");
    }
    admin = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    second = new Browser(rt.fetch, rt.fixtures[1]!.origin);
    await admin.login(rt.fixtures[0]!.password);
    await second.login(rt.fixtures[1]!.password);
    for (let i = 0; i < 3; i++) {
      const username = `approval-bff-${i}`,
        password = randomBytes(24).toString("base64url");
      rt.secretValues.add(password);
      const response = await admin.change("/api/members", {
        username,
        password,
        roles: ["approval:use"],
      });
      expect(response.status).toBe(201);
      const id = ((await response.json()) as { id: string }).id,
        browser = new Browser(rt.fetch, rt.fixtures[0]!.origin);
      await browser.login(password, username);
      actors.push({ id, browser });
    }
  });
  afterAll(async () => {
    for (const child of children) await stop(child);
    if (pool) {
      const allowed = new Set(rt?.fixtures.map((f) => f.tenant) ?? []);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "LOCK TABLE approval_documents,approval_stages,approval_history,notification_outbox IN ACCESS EXCLUSIVE MODE",
        );
        const rows = await client.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM approval_documents",
        );
        if (rows.rows.some((row) => !allowed.has(row.tenant_id)))
          throw new Error("Unknown approval rows preserved; cleanup refused.");
        await client.query(
          "TRUNCATE approval_documents,approval_stages,approval_history,notification_outbox",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
        await pool.end();
      }
    }
    if (rt) await rt.close();
    delete process.env.JGW_TEST_APPROVAL_CA;
  });
  const submit = async (
    b = admin,
    line = actors.slice(0, 2).map((x) => x.id),
  ) => {
    const response = await b.change("/api/approval/documents", {
      title: "BFF document",
      body: "private approval body",
      memberIds: line,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as ApprovalDocument;
  };
  const decide = (
    doc: ApprovalDocument,
    b = actors[0]!.browser,
    body: unknown = { revision: doc.revision, action: "approve" },
  ) => b.change(`/api/approval/documents/${doc.id}/decisions`, body);
  const count = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM approval_documents) AS docs,(SELECT count(*)::int FROM approval_history) AS history,(SELECT count(*)::int FROM notification_outbox) AS outbox",
      )
    ).rows[0];

  it("submits registered ordered candidates using a reduced approval token without browser credentials", async () => {
    const doc = await submit();
    expect(doc.memberIds).toEqual(actors.slice(0, 2).map((x) => x.id));
    expect(doc.status).toBe("pending");
    const rows = (
      await rt.pool.query(
        "SELECT s.access_token AS original,t.access_token AS reduced FROM sessions s JOIN service_tokens t USING(tenant_id,session_hash) WHERE s.tenant_id=$1 AND s.subject=$2 AND t.service_id='j-approval'",
        [rt.fixtures[0]!.tenant, doc.authorId],
      )
    ).rows;
    expect(rows.length).toBe(1);
    expect(decodeJwt(rows[0].reduced).aud).toBe("j-approval");
    expect(rows[0].reduced).not.toBe(rows[0].original);
    const serial = JSON.stringify(doc);
    for (const value of [rows[0].original, rows[0].reduced, ...rt.secretValues])
      expect(serial.includes(value)).toBe(false);
    expect(Object.keys(doc).sort()).toEqual([
      "authorId",
      "body",
      "createdAt",
      "currentStage",
      "id",
      "memberIds",
      "revision",
      "status",
      "title",
      "updatedAt",
    ]);
  });
  it("rejects missing sessions, CSRF/Origin and invalid or foreign candidates before submission", async () => {
    const before = await count(),
      guest = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    expect(
      (await guest.request("/api/approval/documents?view=authored")).status,
    ).toBe(401);
    expect(
      (
        await admin.request("/api/approval/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "x",
            body: "x",
            memberIds: [actors[0]!.id],
          }),
        })
      ).status,
    ).toBe(403);
    const me = await admin.me();
    expect(
      (
        await admin.request("/api/approval/documents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: second.origin,
            "x-csrf-token": me.csrfToken,
          },
          body: JSON.stringify({
            title: "x",
            body: "x",
            memberIds: [actors[0]!.id],
          }),
        })
      ).status,
    ).toBe(403);
    for (const ids of [[], [me.subject], [actors[0]!.id, actors[0]!.id]])
      expect(
        (
          await admin.change("/api/approval/documents", {
            title: "x",
            body: "x",
            memberIds: ids,
          })
        ).status,
      ).toBe(400);
    for (const id of [randomUUID(), (await second.me()).subject])
      expect(
        (
          await admin.change("/api/approval/documents", {
            title: "x",
            body: "x",
            memberIds: [id],
          })
        ).status,
      ).toBe(404);
    expect(await count()).toEqual(before);
  });
  it("relays sequential approvals and participant history while outsiders cannot act", async () => {
    const doc = await submit();
    expect((await decide(doc, admin)).status).toBe(403);
    expect((await decide(doc, actors[1]!.browser)).status).toBe(403);
    expect(
      (await actors[2]!.browser.request(`/api/approval/documents/${doc.id}`))
        .status,
    ).toBe(403);
    const response = await decide(doc);
    expect(response.status).toBe(200);
    const next = (await response.json()) as ApprovalDocument;
    expect(next.currentStage).toBe(2);
    const last = await decide(next, actors[1]!.browser);
    expect(last.status).toBe(200);
    const done = (await last.json()) as ApprovalDocument;
    expect(done.status).toBe("approved");
    expect((await decide(done, actors[1]!.browser)).status).toBe(409);
    const history = await admin.request(
      `/api/approval/documents/${doc.id}/history`,
    );
    expect(history.status).toBe(200);
    expect(
      ((await history.json()) as HistoryPage).items.map((x) => x.action),
    ).toEqual(["viewed", "approved", "approved", "submitted"]);
  });
  it("relays rejection and safe errors without upstream message/details", async () => {
    const doc = await submit();
    expect(
      (await decide(doc, actors[0]!.browser, { revision: 0, action: "reject" }))
        .status,
    ).toBe(400);
    const response = await decide(doc, actors[0]!.browser, {
      revision: 0,
      action: "reject",
      reason: "revise details",
    });
    expect(response.status).toBe(200);
    const done = (await response.json()) as ApprovalDocument;
    expect(done.status).toBe("rejected");
    const conflict = await decide(done);
    expect(conflict.status).toBe(409);
    expect(Object.keys(await conflict.json()).sort()).toEqual([
      "code",
      "message",
      "requestId",
    ]);
  });
  it("keeps the submitted snapshot after the BFF organization member placement changes", async () => {
    const doc = await submit();
    const org = (await (await admin.request("/api/organization")).json()) as {
      revision: number;
    };
    const moved = await admin.change(
      `/api/organization/members/${actors[0]!.id}`,
      { revision: org.revision, departmentId: null, positionId: null },
      "PATCH",
    );
    expect(moved.status).toBe(200);
    const response = await admin.request(`/api/approval/documents/${doc.id}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ApprovalDocument).memberIds).toEqual(
      doc.memberIds,
    );
  });
  it("filters authored/current/processed inboxes and tenant documents through real upstream servers", async () => {
    const doc = await submit();
    const list = async (b: Browser, view: string) =>
      (await (
        await b.request(`/api/approval/documents?view=${view}`)
      ).json()) as DocumentPage;
    expect(
      (await list(admin, "authored")).items.some((x) => x.id === doc.id),
    ).toBe(true);
    expect(
      (await list(actors[0]!.browser, "pending")).items.some(
        (x) => x.id === doc.id,
      ),
    ).toBe(true);
    expect(
      (await list(actors[1]!.browser, "pending")).items.some(
        (x) => x.id === doc.id,
      ),
    ).toBe(false);
    expect((await list(second, "authored")).items).toEqual([]);
    expect(
      (await second.request(`/api/approval/documents/${doc.id}`)).status,
    ).toBe(404);
    expect(
      (
        await second.change(`/api/approval/documents/${doc.id}/decisions`, {
          revision: 0,
          action: "approve",
        })
      ).status,
    ).toBe(404);
    await decide(doc);
    expect(
      (await list(actors[0]!.browser, "processed")).items.some(
        (x) => x.id === doc.id,
      ),
    ).toBe(true);
  });
  it("forbids caller-controlled tenant/path/identity and malformed cursors", async () => {
    const before = await count();
    for (const additional of [
      { tenant: rt.fixtures[1]!.tenant },
      { authorId: actors[0]!.id },
      { path: "/admin" },
      { audience: "j-mail" },
    ])
      expect(
        (
          await admin.change("/api/approval/documents", {
            title: "x",
            body: "x",
            memberIds: [actors[0]!.id],
            ...additional,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await admin.request(
          "/api/approval/documents?view=authored&tenant=other",
        )
      ).status,
    ).toBe(400);
    expect(
      (await admin.request("/api/approval/documents?view=authored&cursor=bad"))
        .status,
    ).toBe(400);
    expect(await count()).toEqual(before);
  });
  it("denies a fresh real member without approval role", async () => {
    const password = randomBytes(24).toString("base64url"),
      username = "approval-denied";
    rt.secretValues.add(password);
    const response = await admin.change("/api/members", {
      username,
      password,
      roles: [],
    });
    expect(response.status).toBe(201);
    const b = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    await b.login(password, username);
    expect(
      (await b.request("/api/approval/documents?view=authored")).status,
    ).toBe(403);
  });
  it("reports token-exchange failure and serializes concurrent decisions without creating extra events", async () => {
    const doc = await submit();
    await rt.pool.query(
      "DELETE FROM service_tokens WHERE tenant_id=$1 AND service_id='j-approval'",
      [rt.fixtures[0]!.tenant],
    );
    rt.failServiceToken = true;
    try {
      expect((await decide(doc)).status).toBe(503);
    } finally {
      rt.failServiceToken = false;
    }
    const results = await Promise.all([
      decide(doc),
      decide(doc, actors[0]!.browser, {
        revision: 0,
        action: "reject",
        reason: "racing",
      }),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM approval_history WHERE document_id=$1 AND action IN ('approved','rejected')",
          [doc.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("requires a live cookie after logout and releases all compiled approval processes safely", async () => {
    const b = actors[2]!.browser,
      me = await b.me();
    const cookie = b.cookies.get(b.origin)!.get("__Host-jgw-session")!;
    expect((await b.change("/auth/logout", undefined)).status).toBe(303);
    expect(
      (
        await rt.fetch(b.origin + "/api/approval/documents?view=authored", {
          headers: { Cookie: `__Host-jgw-session=${cookie}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await rt.pool.query(
          "SELECT count(*)::int AS n FROM service_tokens WHERE session_hash=$1",
          [digest(cookie)],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(me.subject).toBe(actors[2]!.id);
    for (const secret of rt.secretValues)
      expect(logs.join("").includes(secret)).toBe(false);
  });
});
