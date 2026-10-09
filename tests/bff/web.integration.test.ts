import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Browser, integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { createApp as createWebApp } from "../../../j-web/apps/server/dist/app.js";
import { migrate } from "../../../j-web/apps/server/dist/db/migrate.js";
import { hostingRuntime } from "../../../j-web/tests/hosting/runtime.mjs";
import type { HostingFixture } from "../../../j-web/tests/hosting/runtime.mjs";
describe("actual member BFF → exact Web contract → owned PG and isolated hosting", () => {
  let rt: Runtime,
    pool: Pool,
    h: HostingFixture,
    owner: Browser,
    reader: Browser,
    denied: Browser,
    foreign: Browser,
    siteId: string;
  const apps: ReturnType<typeof createWebApp>[] = [];
  const password = randomBytes(24).toString("base64url"),
    replacement = randomBytes(24).toString("base64url");
  const content = {
    name: "<script>bad()</script>",
    introduction: "BFF content",
    contact: "<&>",
    logo: null,
  };
  beforeAll(async () => {
    const env = parseEnv(
      await readFile("/workspace/.suite-runtime/j-web/integration.env", "utf8"),
    );
    if (env.JW_TEST_RUNTIME !== "isolated-cloud")
      throw new Error("Actual isolated Web DB required. No skip.");
    const cert = await readFile(env.JW_TLS_CERTIFICATE!),
      key = await readFile(env.JW_TLS_KEY!);
    rt = await integrationRuntime({
      serviceCa: cert.toString(),
      serviceEndpointsForTenant: (_t, i) => ({
        "j-web": "https://127.0.0.1:" + (55085 + i),
      }),
    });
    pool = new Pool({
      host: env.JW_DB_HOST,
      port: Number(env.JW_DB_PORT),
      database: "jgw_web",
      user: "jgw_web",
      password: env.JW_DB_PASSWORD,
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
    ).toEqual({ current_user: "jgw_web", db: "jgw_web", rolsuper: false });
    await migrate(pool);
    h = await hostingRuntime(rt.fixtures[0]!.tenant);
    for (const [i, f] of rt.fixtures.entries()) {
      expect((await rt.subscribe(i, "j-web")).status).toBe(200);
      const app = createWebApp({
        pool,
        tenant: f.tenant,
        keycloakOrigin: f.config.keycloakOrigin,
        fetch: rt.fetch,
        https: { cert, key },
        helper: { run: h.helper },
        disk: h.disk,
        customerAddress: "192.0.2.77",
      });
      apps.push(app);
      await app.listen({ host: "127.0.0.1", port: 55085 + i });
    }
    owner = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    foreign = new Browser(rt.fetch, rt.fixtures[1]!.origin);
    await owner.login(rt.fixtures[0]!.password);
    await foreign.login(rt.fixtures[1]!.password);
    rt.secretValues.add(password);
    rt.secretValues.add(replacement);
    for (const [role, name] of [
      ["web:read", "web-reader"],
      ["", "web-denied"],
    ]) {
      const p = randomBytes(24).toString("base64url");
      rt.secretValues.add(p);
      expect(
        (
          await owner.change("/api/members", {
            username: name,
            password: p,
            roles: role ? [role] : [],
          })
        ).status,
      ).toBe(201);
      const b = new Browser(rt.fetch, rt.fixtures[0]!.origin);
      await b.login(p, name);
      if (role) reader = b;
      else denied = b;
    }
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
    if (pool) {
      for (const f of rt?.fixtures ?? [])
        await pool.query("DELETE FROM sites WHERE tenant_id=$1", [f.tenant]);
      await pool.end();
    }
    try {
      await h?.close();
    } finally {
      await rt?.close();
    }
  });
  it("creates an owned hosting site through real session/CSRF/exchange and returns the account password only once", async () => {
    expect(
      (
        await new Browser(rt.fetch, rt.fixtures[0]!.origin).request(
          "/api/web/sites",
        )
      ).status,
    ).toBe(401);
    const created = await owner.change("/api/web/sites", {
      domain: "bff-web.jgw.test",
      password,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      account: string;
      password: string;
    };
    siteId = body.id;
    expect(body.password).toBe(password);
    await h.protocols({
      action: "sftp-upload",
      account: body.account,
      password,
      name: "index.html",
      data: "bff-manual-byte-proof",
    });
    expect((await reader.request("/api/web/sites/" + siteId)).status).toBe(200);
    const details = await reader.request(
      "/api/web/sites/" + siteId + "/hosting",
    );
    expect(details.status).toBe(200);
    expect(JSON.stringify(await details.json())).not.toContain(password);
  });
  it("relays saved revisions and inert previews while preserving actual public files", async () => {
    const saved = await owner.change(
      "/api/web/sites/" + siteId + "/content",
      { expectedRevision: 0, content },
      "PUT",
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ siteId, revision: 1, content });
    expect(
      await (
        await reader.request("/api/web/sites/" + siteId + "/content")
      ).json(),
    ).toEqual({ siteId, revision: 1, content });
    const preview = await owner.change(
      "/api/web/sites/" + siteId + "/preview",
      { content },
    );
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { html: string; widgetSnippet: string };
    expect(p.html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(p.html).toContain("script-src 'none'");
    expect(p.html).toContain(p.widgetSnippet);
    await h.protocols({
      action: "https",
      domain: "bff-web.jgw.test",
      data: "bff-manual-byte-proof",
    });
    expect(
      (
        await owner.change(
          "/api/web/sites/" + siteId + "/content",
          { expectedRevision: 0, content },
          "PUT",
        )
      ).status,
    ).toBe(409);
  });
  it("keeps read/write roles, CSRF, tenant ownership and strict route input enforced", async () => {
    expect((await denied.request("/api/web/sites")).status).toBe(403);
    for (const actor of [reader, denied]) {
      expect(
        (
          await actor.change(
            "/api/web/sites/" + siteId + "/content",
            { expectedRevision: 1, content },
            "PUT",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await actor.change("/api/web/sites/" + siteId + "/preview", {
            content,
          })
        ).status,
      ).toBe(403);
      expect(
        (await actor.change("/api/web/sites/" + siteId, {}, "DELETE")).status,
      ).toBe(403);
    }
    expect(
      (await foreign.request("/api/web/sites/" + siteId + "/content")).status,
    ).toBe(404);
    expect(
      (
        await foreign.change(
          "/api/web/sites/" + siteId + "/content",
          { expectedRevision: 1, content },
          "PUT",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await owner.request("/api/web/sites/" + siteId + "/content", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: 1, content }),
        })
      ).status,
    ).toBe(403);
    expect((await owner.request("/api/web/sites?path=/etc")).status).toBe(400);
    expect(
      (await owner.request("/api/web/sites/" + randomUUID() + "/dns")).status,
    ).toBe(404);
    expect(
      (
        await owner.change("/api/web/sites/" + siteId + "/deploy", {
          expectedRevision: 1,
        })
      ).status,
    ).toBe(404);
  });
  it("returns typed actual capacity and DNS/hosts advice without secrets or DNS writes", async () => {
    const list = await reader.request("/api/web/sites/hosting?limit=1");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      items: { id: string; usedBytes: string }[];
      next: string | null;
    };
    expect(body.items[0]!.id).toBe(siteId);
    expect(BigInt(body.items[0]!.usedBytes)).toBeGreaterThan(0n);
    expect(
      await (await reader.request("/api/web/sites/" + siteId + "/dns")).json(),
    ).toEqual({
      type: "A",
      name: "bff-web.jgw.test",
      address: "192.0.2.77",
      guidance: "DNS는 등록처·DNS 서비스에서 별도 관리합니다.",
      hostsEntry: "192.0.2.77 bff-web.jgw.test",
    });
    expect(JSON.stringify(body)).not.toContain(password);
  });
  it("resets the actual account and removes owned routes/files through the existing helper without retaining passwords in PG", async () => {
    const reset = await owner.change(
      "/api/web/sites/" + siteId + "/account-password",
      { password: replacement },
    );
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { password: string }).password).toBe(
      replacement,
    );
    const removed = await owner.change(
      "/api/web/sites/" + siteId,
      {},
      "DELETE",
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { backupId: string }).backupId).toMatch(
      /^[a-f0-9-]{73}$/,
    );
    expect((await reader.request("/api/web/sites/" + siteId)).status).toBe(404);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM site_content WHERE tenant_id=$1 AND site_id=$2",
          [rt.fixtures[0]!.tenant, siteId],
        )
      ).rowCount,
    ).toBe(0);
    for (const secret of rt.secretValues)
      expect(rt.logs.join("\n")).not.toContain(secret);
  });
});
