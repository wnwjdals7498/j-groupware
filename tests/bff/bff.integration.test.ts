import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { Browser, integrationRuntime, required } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { digest } from "../../apps/server/src/security.js";
import { migrate } from "../../apps/server/src/db/migrate.js";
import { createTokenVerifier } from "@j-auth/token-verifier";
import { ServiceClient } from "../../apps/server/src/services.js";
import { createServer } from "node:http";

describe("actual HTTPS BFF + j-auth + Keycloak + dedicated PostgreSQL", () => {
  let runtime: Runtime;
  const browser = (index = 0) =>
    new Browser(runtime.fetch, runtime.fixtures[index]!.origin);
  const login = async (index = 0) => {
    const b = browser(index);
    await b.login(runtime.fixtures[index]!.password);
    return b;
  };
  const hash = (b: Browser) =>
    digest(b.cookies.get(b.origin)!.get(SESSION_POLICY.cookie)!);
  const wait = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Expected state not observed in five seconds.");
  };
  beforeAll(async () => {
    runtime = await integrationRuntime();
  });
  afterAll(async () => {
    if (runtime) await runtime.close();
  });

  it("migrates idempotently as dedicated non-superuser and denies other databases", async () => {
    await Promise.all([migrate(runtime.pool), migrate(runtime.pool)]);
    const identity = (
      await runtime.pool.query(
        "SELECT current_user,current_database() AS database,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser",
      )
    ).rows[0];
    expect(identity).toMatchObject({
      current_user: "jgw_groupware",
      database: "jgw_groupware",
      superuser: false,
    });
    for (const database of ["postgres", "jgw_other"]) {
      const foreign = new Pool({
        host: "127.0.0.1",
        port: 54232,
        database,
        user: "jgw_groupware",
        password: required("JGW_DB_PASSWORD"),
      });
      try {
        await expect(foreign.query("SELECT 1")).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await foreign.end();
      }
    }
  });
  it("issues Code+PKCE+nonce through BFF, validates callback, and stores only a protected opaque cookie in browser", async () => {
    const b = browser(),
      authorization = await b.begin();
    const url = new URL(authorization);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBeTruthy();
    const callback = await b.code(authorization, runtime.fixtures[0]!.password);
    const response = await b.request(callback);
    expect(response.status).toBe(302);
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.find((cookie) => cookie.startsWith(SESSION_POLICY.cookie + "=")),
    ).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const me = await b.me();
    expect(me.username).toBe("owner");
    expect(me.tenant).toBe(runtime.fixtures[0]!.tenant);
    expect(me.menus.map((menu) => menu.id)).toContain("board");
    const session = (
      await runtime.pool.query("SELECT * FROM sessions WHERE session_hash=$1", [
        hash(b),
      ])
    ).rows[0];
    expect(session.sid).toBeTruthy();
    const exposed =
      JSON.stringify(me) + cookies.join(" ") + response.headers.get("location");
    for (const value of [
      session.access_token,
      session.refresh_token,
      runtime.fixtures[0]!.secrets.clientSecret,
      runtime.fixtures[0]!.secrets.serviceKey,
    ]) {
      expect(exposed).not.toContain(value);
      runtime.secretValues.add(value);
    }
    expect((await b.request(callback)).status).toBe(401);
    expect((await b.request("/api/me")).status).toBe(200);
  });
  it("binds state to browser, rejects unknown Host/redirect and cross-tenant cookies despite forwarded headers", async () => {
    const a = await login(),
      b = await login(1);
    const authorization = await a.begin(),
      state = new URL(authorization).searchParams.get("state")!;
    const other = browser();
    expect(
      (
        await other.request(
          "/auth/callback?" + new URLSearchParams({ state, code: "dummy" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await a.request(
          "/auth/callback?" +
            new URLSearchParams({
              state: randomBytes(32).toString("base64url"),
              code: "dummy",
            }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await a.request("/auth/login?redirect=https://evil.jgw.test")).status,
    ).toBe(400);
    expect(
      await runtime.hostRequest(
        a.origin,
        "gw.unregistered.jgw.test",
        new URL(a.origin).host,
      ),
    ).toBe(400);
    const cookie = a.cookies.get(a.origin)!.get(SESSION_POLICY.cookie)!;
    expect(
      (
        await b.request("/api/me", {
          headers: {
            Cookie: SESSION_POLICY.cookie + "=" + cookie,
            "X-Forwarded-Host": new URL(a.origin).host,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await a.request("/api/me", {
          headers: { "X-Forwarded-Host": new URL(b.origin).host },
        })
      ).status,
    ).toBe(200);
  });
  it("consumes simultaneous callbacks only once", async () => {
    const b = browser(),
      tenant = runtime.fixtures[0]!.tenant;
    const callback = await b.code(
      await b.begin(),
      runtime.fixtures[0]!.password,
    );
    const before = (
      await runtime.pool.query(
        "SELECT count(*)::int AS count FROM sessions WHERE tenant_id=$1",
        [tenant],
      )
    ).rows[0].count;
    const responses = await Promise.all([
      b.request(callback),
      b.request(callback),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      302, 401,
    ]);
    expect(
      (
        await runtime.pool.query(
          "SELECT count(*)::int AS count FROM sessions WHERE tenant_id=$1",
          [tenant],
        )
      ).rows[0].count,
    ).toBe(before + 1);
  });
  it("rejects actual nonce mismatch and Keycloak PKCE mismatch without creating a session", async () => {
    for (const [column, status] of [
      ["nonce", 401],
      ["verifier", 400],
    ] as const) {
      const b = browser(),
        authorization = await b.begin(),
        flow = b.cookies.get(b.origin)!.get(SESSION_POLICY.flowCookie)!;
      const callback = await b.code(
        authorization,
        runtime.fixtures[0]!.password,
      );
      const before = (
        await runtime.pool.query("SELECT count(*)::int AS count FROM sessions")
      ).rows[0].count;
      // Change only this disposable flow's expected proof; token issuance/verification stays real.
      await runtime.pool.query(
        `UPDATE login_flows SET ${column}=$2 WHERE flow_hash=$1`,
        [digest(flow), randomBytes(32).toString("base64url")],
      );
      const response = await b.request(callback);
      expect(response.status).toBe(status);
      expect(
        (
          await runtime.pool.query(
            "SELECT count(*)::int AS count FROM sessions",
          )
        ).rows[0].count,
      ).toBe(before);
      expect(
        response.headers
          .getSetCookie()
          .some((cookie) => cookie.startsWith(SESSION_POLICY.cookie + "=")),
      ).toBe(false);
    }
  });
  it("consumes cancellation once and replaces an earlier pending login without changing an existing session", async () => {
    const b = await login();
    const first = await b.begin(),
      second = await b.begin();
    const cancelled = (authorization: string) =>
      "/auth/callback?" +
      new URLSearchParams({
        state: new URL(authorization).searchParams.get("state")!,
        error: "access_denied",
      });
    expect((await b.request(cancelled(first))).status).toBe(401);
    expect((await b.request(cancelled(second))).status).toBe(400);
    expect((await b.request(cancelled(second))).status).toBe(401);
    expect((await b.request("/api/me")).status).toBe(200);
    const expired = await b.begin();
    await runtime.pool.query(
      "UPDATE login_flows SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",
      [runtime.fixtures[0]!.tenant],
    );
    expect((await b.request(cancelled(expired))).status).toBe(401);
  });
  it("rotates an existing browser session on successful re-login", async () => {
    const b = await login(),
      old = b.cookies.get(b.origin)!.get(SESSION_POLICY.cookie)!;
    await b.login(runtime.fixtures[0]!.password);
    const newer = b.cookies.get(b.origin)!.get(SESSION_POLICY.cookie)!;
    expect(newer).not.toBe(old);
    expect(
      (
        await runtime.pool.query(
          "SELECT 1 FROM sessions WHERE session_hash=$1",
          [digest(old)],
        )
      ).rowCount,
    ).toBe(0);
    expect(runtime.closed).toContain(digest(old));
  });
  it("rejects missing/wrong CSRF and foreign Origin, then persists and reads a tenant-owned board post", async () => {
    const a = await login(),
      b = await login(1),
      me = await a.me();
    const body = JSON.stringify({
      title: "Cloud board",
      body: "Actual DB post",
    });
    for (const headers of [
      { "Content-Type": "application/json" },
      {
        "Content-Type": "application/json",
        Origin: a.origin,
        "x-csrf-token": "wrong",
      },
      {
        "Content-Type": "application/json",
        Origin: b.origin,
        "x-csrf-token": me.csrfToken,
      },
    ])
      expect(
        (await a.request("/api/board/posts", { method: "POST", headers, body }))
          .status,
      ).toBe(403);
    const created = await a.change("/api/board/posts", {
      title: "Cloud board",
      body: "Actual DB post",
    });
    expect(created.status).toBe(201);
    const post = (await created.json()) as {
      id: string;
      authorId: string;
      title: string;
    };
    expect(post.authorId).toBe(me.subject);
    expect((await a.request("/api/board/posts/" + post.id)).status).toBe(200);
    expect((await b.request("/api/board/posts/" + post.id)).status).toBe(404);
    expect(
      (
        await a.change("/api/board/posts", {
          title: "Bad extra field",
          body: "body",
          tenant: b.origin,
        })
      ).status,
    ).toBe(400);
  });
  it("paginates stable board ordering without cross-tenant rows or duplicates", async () => {
    const a = await login(),
      tenant = runtime.fixtures[0]!.tenant;
    await runtime.pool.query(
      "INSERT INTO board_posts(tenant_id,author_id,title,body,created_at) SELECT $1,'fixture','page-'||n,'body',clock_timestamp() FROM generate_series(1,60) n",
      [tenant],
    );
    const one = (await (await a.request("/api/board/posts")).json()) as {
      items: { id: string }[];
      nextCursor: string;
    };
    expect(one.items.length).toBe(50);
    expect(one.nextCursor).toBeTruthy();
    const two = (await (
      await a.request("/api/board/posts?cursor=" + one.nextCursor)
    ).json()) as { items: { id: string }[] };
    expect(two.items.length).toBeGreaterThan(0);
    expect(
      new Set([...one.items, ...two.items].map((post) => post.id)).size,
    ).toBe(one.items.length + two.items.length);
    expect((await a.request("/api/board/posts?cursor=malformed")).status).toBe(
      400,
    );
    for (const time of [
      "0000-01-01 12:00:00+00",
      "2026-99-01 12:00:00+00",
      "2026-02-30 12:00:00+00",
      "2026-10-08 25:00:00+00",
      "2026-10-08 12:00:00.1234567+00",
    ]) {
      const cursor = Buffer.from(
        JSON.stringify([time, "00000000-0000-0000-0000-000000000001"]),
      ).toString("base64url");
      expect(
        (await a.request("/api/board/posts?cursor=" + cursor)).status,
      ).toBe(400);
    }
  });
  it("shows no board menu and denies direct board requests to a real member without roles", async () => {
    const password = randomBytes(24).toString("base64url");
    runtime.secretValues.add(password);
    const created = await runtime.members(0, "", {
      username: "no-board",
      password,
      roles: [],
    });
    expect(created.status).toBe(201);
    const member = browser();
    await member.login(password, "no-board");
    const me = await member.me();
    expect(me.menus).toEqual([]);
    expect((await member.request("/api/board/posts")).status).toBe(403);
    expect(
      (
        await member.change("/api/board/posts", {
          title: "Denied",
          body: "body",
        })
      ).status,
    ).toBe(403);
  });
  it("refreshes once across concurrent requests and persists the replacement refresh token", async () => {
    const b = await login(),
      id = hash(b);
    const previous = (
      await runtime.pool.query(
        "SELECT refresh_token FROM sessions WHERE session_hash=$1",
        [id],
      )
    ).rows[0].refresh_token;
    await runtime.pool.query(
      "UPDATE sessions SET access_expires_at=now()+interval '20 seconds' WHERE session_hash=$1",
      [id],
    );
    const count = runtime.refreshCount;
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => b.request("/api/me")),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(runtime.refreshCount - count).toBe(1);
    const current = (
      await runtime.pool.query(
        "SELECT refresh_token FROM sessions WHERE session_hash=$1",
        [id],
      )
    ).rows[0].refresh_token;
    expect(current).not.toBe(previous);
    runtime.secretValues.add(previous);
    runtime.secretValues.add(current);
  });
  it("keeps a session on injected pre-request transport outage, then resumes actual refresh", async () => {
    const b = await login(),
      id = hash(b);
    await runtime.pool.query(
      "UPDATE sessions SET access_expires_at=now() WHERE session_hash=$1",
      [id],
    );
    runtime.failRefresh = true;
    try {
      expect((await b.request("/api/me")).status).toBe(503);
      expect(
        (
          await runtime.pool.query(
            "SELECT 1 FROM sessions WHERE session_hash=$1",
            [id],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      runtime.failRefresh = false;
    }
    expect((await b.request("/api/me")).status).toBe(200);
  });
  it("ends a session when real Keycloak rejects a missing refresh token and enforces idle/max expiry", async () => {
    const rejected = await login(),
      id = hash(rejected);
    await runtime.pool.query(
      "UPDATE sessions SET refresh_token='invalid-real-token',access_expires_at=now() WHERE session_hash=$1",
      [id],
    );
    expect((await rejected.request("/api/me")).status).toBe(401);
    expect(
      (
        await runtime.pool.query(
          "SELECT 1 FROM sessions WHERE session_hash=$1",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    for (const assignment of [
      "last_seen_at=now()-interval '30 minutes'",
      "created_at=now()-interval '8 hours'",
    ]) {
      const b = await login(),
        key = hash(b);
      await runtime.pool.query(
        `UPDATE sessions SET ${assignment} WHERE session_hash=$1`,
        [key],
      );
      expect((await b.request("/api/me")).status).toBe(401);
      expect(runtime.closed).toContain(key);
    }
  });
  it("receives a real Keycloak backchannel after j-auth role grant, invalidates only the target, and permits safe replay", async () => {
    const password = randomBytes(24).toString("base64url");
    runtime.secretValues.add(password);
    const result = await runtime.members(0, "", {
      username: "role-change",
      password,
      roles: [],
    });
    expect(result.status).toBe(201);
    const member = (await result.json()) as { id: string };
    const target = browser();
    await target.login(password, "role-change");
    const other = await login(),
      sibling = await login(1),
      old = hash(target),
      before = runtime.logoutTokens.length;
    const granted = await runtime.members(
      0,
      "/" + member.id + "/roles/board:write",
      undefined,
      "PUT",
    );
    expect(granted.status).toBe(200);
    await wait(
      async () =>
        runtime.logoutTokens.length > before &&
        (
          await runtime.pool.query(
            "SELECT 1 FROM sessions WHERE session_hash=$1",
            [old],
          )
        ).rowCount === 0,
    );
    expect((await target.request("/api/me")).status).toBe(401);
    expect(runtime.closed).toContain(old);
    expect(
      runtime.incoming.some(
        (item) => item.method === "POST" && item.status === 200,
      ),
    ).toBe(true);
    expect((await other.request("/api/me")).status).toBe(200);
    expect((await sibling.request("/api/me")).status).toBe(200);
    const logoutToken = runtime.logoutTokens.at(-1)!;
    expect(
      (
        await other.request("/auth/backchannel-logout", {
          method: "POST",
          body: new URLSearchParams({ logout_token: logoutToken }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await sibling.request("/auth/backchannel-logout", {
          method: "POST",
          body: new URLSearchParams({ logout_token: logoutToken }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await other.request("/auth/backchannel-logout", {
          method: "POST",
          body: new URLSearchParams({
            logout_token: logoutToken.slice(0, -20) + "aaaaaaaaaaaaaaaaaaaa",
          }),
        })
      ).status,
    ).toBe(400);
    expect((await other.request("/api/me")).status).toBe(200);
    await target.login(password, "role-change");
    expect((await target.me()).menus.map((menu) => menu.id)).toContain("board");
    expect(
      (
        await target.change("/api/board/posts", {
          title: "Granted",
          body: "write implies read",
        })
      ).status,
    ).toBe(201);
    const revoked = await runtime.members(
      0,
      "/" + member.id + "/roles/board:write",
      undefined,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    await wait(async () => (await target.request("/api/me")).status === 401);
    await target.login(password, "role-change");
    expect((await target.me()).menus).toEqual([]);
    expect((await target.request("/api/board/posts")).status).toBe(403);
  });
  it("locally logs out with CSRF, completes actual RP logout confirmation, and rejects repeat use", async () => {
    const b = await login(),
      me = await b.me(),
      id = hash(b);
    const old = (
      await runtime.pool.query(
        "SELECT refresh_token FROM sessions WHERE session_hash=$1",
        [id],
      )
    ).rows[0].refresh_token;
    expect((await b.request("/auth/logout", { method: "POST" })).status).toBe(
      403,
    );
    const logout = await b.request("/auth/logout", {
      method: "POST",
      headers: { Origin: b.origin, "x-csrf-token": me.csrfToken },
    });
    expect(logout.status).toBe(303);
    const url = logout.headers.get("location")!;
    expect(url).not.toContain("id_token_hint");
    expect((await b.request("/api/me")).status).toBe(401);
    expect(
      (
        await b.request("/auth/logout", {
          method: "POST",
          headers: { Origin: b.origin, "x-csrf-token": me.csrfToken },
        })
      ).status,
    ).toBe(401);
    const confirm = await b.request(url);
    const html = await confirm.text();
    if (confirm.status === 200) {
      const form = html.match(/<form\b[^>]*>/)?.[0];
      const action = form
        ?.match(/action="([^"]+)"/)?.[1]
        ?.replaceAll("&amp;", "&");
      expect(action).toBeTruthy();
      const fields = new URLSearchParams({ confirmLogout: "true" });
      for (const tag of html.matchAll(/<input\b[^>]*>/g)) {
        const name = tag[0].match(/name="([^"]+)"/)?.[1],
          value = tag[0].match(/value="([^"]*)"/)?.[1];
        if (name && value !== undefined) fields.set(name, value);
      }
      const confirmed = await b.request(new URL(action!, url).toString(), {
        method: "POST",
        body: fields,
      });
      expect(confirmed.status).toBe(302);
    } else expect(confirm.status).toBe(302);
    const fixture = runtime.fixtures[0]!;
    const refresh = await runtime.fetch(
      required("KC_PUBLIC_URL") +
        "/realms/tenant-" +
        fixture.tenant +
        "/protocol/openid-connect/token",
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "j-groupware",
          client_secret: fixture.secrets.clientSecret,
          refresh_token: old,
        }),
      },
    );
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });
  it("exchanges real tokens to one audience and shares a PG cache across concurrent server callers", async () => {
    expect((await runtime.subscribe(0, "j-mail")).status).toBe(200);
    expect((await runtime.subscribe(0, "j-messenger")).status).toBe(200);
    const a = await login(),
      fixture = runtime.fixtures[0]!,
      session = a.cookies.get(a.origin)!.get(SESSION_POLICY.cookie)!;
    expect((await a.me()).roles).toContain("mail:read");
    const before = runtime.serviceTokenCount;
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () =>
        fixture.app.serviceTokens.get(session, "j-mail"),
      ),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(runtime.serviceTokenCount - before).toBe(1);
    const token = tokens[0]!;
    runtime.secretValues.add(token);
    const verifier = createTokenVerifier({
      publicUrl: fixture.config.keycloakOrigin,
      fetch: runtime.fetch,
    });
    const identity = await verifier.verify(token, {
      tenantId: fixture.tenant,
      audience: "j-mail",
    });
    expect(identity.claims.aud).toBe("j-mail");
    expect(identity.roles).toContain("mail:read");
    await expect(
      verifier.verify(token, {
        tenantId: fixture.tenant,
        audience: "j-messenger",
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    const cache = (
      await runtime.pool.query(
        "SELECT * FROM service_tokens WHERE tenant_id=$1 AND session_hash=$2",
        [fixture.tenant, hash(a)],
      )
    ).rows;
    expect(cache).toHaveLength(1);
    expect(cache[0].service_id).toBe("j-mail");
    const other = await login();
    await fixture.app.serviceTokens.get(
      other.cookies.get(other.origin)!.get(SESSION_POLICY.cookie)!,
      "j-mail",
    );
    expect(runtime.serviceTokenCount - before).toBe(2);
  });
  it("denies cross-tenant cookies, unsubscribed roles, unknown services and corrupt cached signatures", async () => {
    const a = await login(),
      fixture = runtime.fixtures[0]!,
      session = a.cookies.get(a.origin)!.get(SESSION_POLICY.cookie)!;
    const b = await login(1),
      bSession = b.cookies.get(b.origin)!.get(SESSION_POLICY.cookie)!;
    await expect(
      runtime.fixtures[1]!.app.serviceTokens.get(session, "j-mail"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      runtime.fixtures[1]!.app.serviceTokens.get(bSession, "j-mail"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      fixture.app.serviceTokens.get(session, "j-groupware"),
    ).rejects.toMatchObject({ status: 400 });
    const token = await fixture.app.serviceTokens.get(session, "j-mail");
    runtime.secretValues.add(token);
    const parts = token.split(".");
    parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1);
    await runtime.pool.query(
      "UPDATE service_tokens SET access_token=$3 WHERE tenant_id=$1 AND session_hash=$2",
      [fixture.tenant, hash(a), parts.join(".")],
    );
    await expect(
      fixture.app.serviceTokens.get(session, "j-mail"),
    ).rejects.toMatchObject({ status: 503 });
    expect((await a.request("/api/me")).status).toBe(200);
    await runtime.pool.query(
      "UPDATE service_tokens SET access_token=$3 WHERE tenant_id=$1 AND session_hash=$2",
      [fixture.tenant, hash(a), token],
    );
  });
  it("replaces cache after actual refresh and cache expiry; transport failure preserves safe retry", async () => {
    const a = await login(),
      fixture = runtime.fixtures[0]!,
      session = a.cookies.get(a.origin)!.get(SESSION_POLICY.cookie)!;
    await fixture.app.serviceTokens.get(session, "j-mail");
    const previous = (
      await runtime.pool.query(
        "SELECT source_hash FROM service_tokens WHERE tenant_id=$1 AND session_hash=$2",
        [fixture.tenant, hash(a)],
      )
    ).rows[0].source_hash;
    await runtime.pool.query(
      "UPDATE sessions SET access_expires_at=now()+interval '10 seconds' WHERE tenant_id=$1 AND session_hash=$2",
      [fixture.tenant, hash(a)],
    );
    const refreshed = runtime.refreshCount;
    await fixture.app.serviceTokens.get(session, "j-mail");
    expect(runtime.refreshCount - refreshed).toBe(1);
    const current = (
      await runtime.pool.query(
        "SELECT source_hash FROM service_tokens WHERE tenant_id=$1 AND session_hash=$2",
        [fixture.tenant, hash(a)],
      )
    ).rows[0].source_hash;
    expect(current).not.toBe(previous);
    await runtime.pool.query(
      "UPDATE service_tokens SET expires_at=now() WHERE tenant_id=$1 AND session_hash=$2",
      [fixture.tenant, hash(a)],
    );
    const before = runtime.serviceTokenCount;
    runtime.failServiceToken = true;
    try {
      await expect(
        fixture.app.serviceTokens.get(session, "j-mail"),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      runtime.failServiceToken = false;
    }
    expect((await a.request("/api/me")).status).toBe(200);
    await fixture.app.serviceTokens.get(session, "j-mail");
    expect(runtime.serviceTokenCount - before).toBe(2);
  });
  it("keeps a real rotated refresh token when the subsequent service exchange fails", async () => {
    const a = await login(),
      fixture = runtime.fixtures[0]!,
      session = a.cookies.get(a.origin)!.get(SESSION_POLICY.cookie)!;
    const old = (
      await runtime.pool.query(
        "SELECT refresh_token FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
        [fixture.tenant, digest(session)],
      )
    ).rows[0].refresh_token as string;
    runtime.secretValues.add(old);
    await runtime.pool.query(
      "UPDATE sessions SET access_expires_at=now() WHERE tenant_id=$1 AND session_hash=$2",
      [fixture.tenant, digest(session)],
    );
    const before = runtime.refreshCount;
    runtime.failServiceToken = true;
    try {
      await expect(
        fixture.app.serviceTokens.get(session, "j-mail"),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      runtime.failServiceToken = false;
    }
    const fresh = (
      await runtime.pool.query(
        "SELECT refresh_token FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
        [fixture.tenant, digest(session)],
      )
    ).rows[0].refresh_token as string;
    runtime.secretValues.add(fresh);
    expect(fresh).not.toBe(old);
    await fixture.app.serviceTokens.get(session, "j-mail");
    expect(runtime.refreshCount - before).toBe(1);
    expect((await a.request("/api/me")).status).toBe(200);
  });
  it("cancels after a real exchange response without persisting or returning the token", async () => {
    const a = await login(),
      fixture = runtime.fixtures[0]!,
      session = a.cookies.get(a.origin)!.get(SESSION_POLICY.cookie)!;
    const aborted = new AbortController();
    aborted.abort();
    const before = runtime.serviceTokenCount;
    await expect(
      fixture.app.serviceTokens.get(session, "j-mail", aborted.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.serviceTokenCount).toBe(before);
    const signal = new AbortController(),
      gate = runtime.holdNextServiceToken();
    const result = fixture.app.serviceTokens
      .get(session, "j-mail", signal.signal)
      .then(
        () => null,
        (error) => error as Error,
      );
    try {
      await gate.arrival;
      signal.abort();
    } finally {
      gate.release();
    }
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(
      (
        await runtime.pool.query(
          "SELECT 1 FROM service_tokens WHERE tenant_id=$1 AND session_hash=$2",
          [fixture.tenant, digest(session)],
        )
      ).rowCount,
    ).toBe(0);
    expect((await a.request("/api/me")).status).toBe(200);
  });
  it("sends only the narrowed bearer to a real loopback HTTP receiver and blocks endpoint redirects", async () => {
    const a = await login(),
      fixture = runtime.fixtures[0]!,
      session = a.cookies.get(a.origin)!.get(SESSION_POLICY.cookie)!;
    const verifier = createTokenVerifier({
      publicUrl: fixture.config.keycloakOrigin,
      fetch: runtime.fetch,
    });
    let received = 0,
      headers: Record<string, string | string[] | undefined> = {};
    const receiver = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "http://127.0.0.1:3001/steal" });
        response.end();
        return;
      }
      headers = request.headers;
      received++;
      void verifier
        .verify(request.headers.authorization?.slice(7) ?? "", {
          tenantId: fixture.tenant,
          audience: "j-mail",
        })
        .then(
          (identity) => {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                tenant: identity.tenantId,
                roles: identity.roles,
              }),
            );
          },
          () => {
            response.writeHead(401);
            response.end();
          },
        );
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, "127.0.0.1", resolve),
    );
    const address = receiver.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture address failed");
    const client = new ServiceClient(
      fixture.app.serviceTokens,
      { "j-mail": `http://127.0.0.1:${address.port}` },
      runtime.fetch,
    );
    try {
      const result = await client.request(session, "j-mail", "/mail");
      expect(result.status).toBe(200);
      const content = (await result.json()) as {
        tenant: string;
        roles: string[];
      };
      expect(content.tenant).toBe(fixture.tenant);
      expect(content.roles).toContain("mail:read");
      expect(content.roles).not.toContain("messenger:use");
      expect(headers.cookie).toBeUndefined();
      expect(headers["x-jgw-service-key"]).toBeUndefined();
      await expect(
        client.request(session, "j-mail", "//attacker.test/"),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        client.request(session, "j-mail", "/redirect"),
      ).rejects.toMatchObject({ status: 503 });
      expect(received).toBe(1);
    } finally {
      receiver.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("deletes cached tokens on actual local logout and member-role backchannel, including repeat calls", async () => {
    const a = await login(),
      fixture = runtime.fixtures[0]!,
      session = a.cookies.get(a.origin)!.get(SESSION_POLICY.cookie)!;
    await fixture.app.serviceTokens.get(session, "j-mail");
    const me = await a.me();
    const logout = await a.request("/auth/logout", {
      method: "POST",
      headers: { Origin: a.origin, "x-csrf-token": me.csrfToken },
    });
    expect(logout.status).toBe(303);
    expect(
      (
        await runtime.pool.query(
          "SELECT 1 FROM service_tokens WHERE tenant_id=$1 AND session_hash=$2",
          [fixture.tenant, digest(session)],
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      fixture.app.serviceTokens.get(session, "j-mail"),
    ).rejects.toMatchObject({ status: 401 });
    const password = randomBytes(24).toString("base64url");
    runtime.secretValues.add(password);
    const created = await runtime.members(0, "", {
      username: "cached-member",
      password,
      roles: ["mail:read"],
    });
    expect(created.status).toBe(201);
    const member = (await created.json()) as { id: string };
    const fresh = browser();
    await fresh.login(password, "cached-member");
    const freshSession = fresh.cookies
      .get(fresh.origin)!
      .get(SESSION_POLICY.cookie)!;
    await fixture.app.serviceTokens.get(freshSession, "j-mail");
    expect(
      (
        await runtime.members(
          0,
          `/${member.id}/roles/mail:read`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    await wait(
      async () =>
        !(
          await runtime.pool.query(
            "SELECT 1 FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
            [fixture.tenant, hash(fresh)],
          )
        ).rowCount,
    );
    expect(
      (
        await runtime.pool.query(
          "SELECT 1 FROM service_tokens WHERE tenant_id=$1 AND session_hash=$2",
          [fixture.tenant, hash(fresh)],
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      fixture.app.serviceTokens.get(freshSession, "j-mail"),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await runtime.members(
          0,
          `/${member.id}/roles/mail:read`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
  });
  it("restarts the compiled loopback HTTPS process without losing sessions or logging secrets", async () => {
    const first = await runtime.startCompiled();
    const b = new Browser(runtime.fetchLoopback, runtime.fixtures[0]!.origin);
    try {
      await b.login(runtime.fixtures[0]!.password);
      expect((await b.me()).username).toBe("owner");
    } finally {
      await runtime.stop(first);
    }
    const second = await runtime.startCompiled();
    try {
      expect((await b.request("/api/me")).status).toBe(200);
    } finally {
      await runtime.stop(second);
    }
    const row = (
      await runtime.pool.query(
        "SELECT access_token,refresh_token FROM sessions WHERE session_hash=$1",
        [hash(b)],
      )
    ).rows[0];
    runtime.secretValues.add(row.access_token);
    runtime.secretValues.add(row.refresh_token);
    runtime.secretValues.add(
      b.cookies.get(b.origin)!.get(SESSION_POLICY.cookie)!,
    );
    const logs = runtime.logs.join("");
    for (const value of runtime.secretValues) expect(logs).not.toContain(value);
  });
});
