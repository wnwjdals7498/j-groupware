import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { Agent, fetch as undiciFetch } from "undici";
import { OidcClient, digest } from "@j-groupware/bff-auth";
import {
  createConsoleApp,
  CONSOLE_COOKIES,
} from "../../apps/console-server/src/app.js";
import { loadConsoleDatabase } from "../../apps/console-server/src/config.js";
import { migrate } from "../../apps/console-server/src/db/migrate.js";
import { Browser, integrationRuntime, required } from "./runtime.js";
import type { Runtime } from "./runtime.js";
describe("actual isolated operator console Code/PKCE BFF", () => {
  let r: Runtime,
    pool: Pool,
    app: ReturnType<typeof createConsoleApp>,
    agent: Agent,
    consoleFetch: typeof fetch,
    original: Record<string, unknown>,
    clientPath: string;
  let refreshes = 0;
  const origin = "https://console.jgw.test:55053",
    tokens: string[] = [];
  const browser = () => new Browser(consoleFetch, origin);
  const login = async () => {
    const b = browser();
    await b.login(required("JGW_OPERATOR_OP_ADMIN_PASSWORD"), "op-admin");
    return b;
  };
  const config = () => ({
    tenant: "operator",
    origin,
    keycloakOrigin: required("KC_PUBLIC_URL"),
    clientSecret: required("JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET"),
  });
  const me = async (b: Browser) => {
    const response = await b.request("/console/api/me");
    expect(response.status).toBe(200);
    return response.json() as Promise<{ roles: string[]; csrfToken: string }>;
  };
  const hash = (b: Browser) =>
    digest(b.cookies.get(origin)!.get(CONSOLE_COOKIES.session)!);
  beforeAll(async () => {
    const external = parseEnv(
      await readFile(
        "/workspace/.suite-runtime/j-groupware/console/integration.env",
        "utf8",
      ),
    );
    if (external.JGC_TEST_RUNTIME !== "isolated-cloud")
      throw new Error("Owned console fixture required.");
    pool = new Pool(loadConsoleDatabase(external));
    pool.on("error", () => {});
    await migrate(pool);
    const cert = await readFile(external.JGC_TLS_CERTIFICATE!),
      key = await readFile(external.JGC_TLS_KEY!);
    r = await integrationRuntime({ serviceCa: cert.toString() });
    const rows = (await (
      await r.admin("/admin/realms/operator/clients?clientId=j-console")
    ).json()) as { id: string }[];
    clientPath = "/admin/realms/operator/clients/" + rows[0]!.id;
    original = (await (await r.admin(clientPath)).json()) as Record<
      string,
      unknown
    >;
    const changed = await r.admin(clientPath, {
      method: "PUT",
      body: JSON.stringify({
        ...original,
        redirectUris: [
          ...(original.redirectUris as string[]),
          origin + "/auth/callback",
        ],
        attributes: {
          ...(original.attributes as Record<string, string>),
          "post.logout.redirect.uris":
            String(
              (original.attributes as Record<string, string>)[
                "post.logout.redirect.uris"
              ],
            ) +
            "##" +
            origin +
            "/",
          "backchannel.logout.url": origin + "/auth/backchannel-logout",
        },
      }),
    });
    if (changed.status !== 204)
      throw new Error("Test operator callback configuration failed.");
    const bridge = required("JGW_TEST_BIND_IP");
    agent = new Agent({
      connect: {
        ca: [cert],
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: bridge, family: 4 }]);
          else callback(null, bridge, 4);
        },
      },
    });
    consoleFetch = async (input, init) =>
      new URL(String(input)).hostname === "console.jgw.test"
        ? ((await undiciFetch(String(input), {
            ...init,
            dispatcher: agent,
            redirect: init?.redirect ?? "error",
            signal: init?.signal ?? AbortSignal.timeout(10000),
          } as Parameters<typeof undiciFetch>[1])) as unknown as Response)
        : r.fetch(input, init);
    const transport: typeof fetch = async (input, init) => {
      if (
        String(input).endsWith(
          "/realms/operator/protocol/openid-connect/token",
        ) &&
        init?.body instanceof URLSearchParams &&
        init.body.get("grant_type") === "refresh_token"
      )
        refreshes++;
      return r.fetch(input, init);
    };
    app = createConsoleApp({
      pool,
      config: config(),
      oidc: new OidcClient(config(), { fetch: transport }),
      https: { cert, key },
    });
    app.addHook("preHandler", async (request) => {
      if (request.routeOptions.url === "/auth/backchannel-logout") {
        const token = (request.body as { logout_token: string }).logout_token;
        tokens.push(token);
        r.secretValues.add(token);
      }
    });
    await app.listen({ host: bridge, port: 55053 });
  });
  afterAll(async () => {
    await app?.close();
    if (original && r)
      expect(
        (
          await r.admin(clientPath, {
            method: "PUT",
            body: JSON.stringify(original),
          })
        ).status,
      ).toBe(204);
    if (pool) {
      await pool.query("DELETE FROM sessions");
      await pool.query("DELETE FROM login_flows");
      await pool.query("DELETE FROM logout_events");
      await pool.end();
    }
    await agent?.close();
    await r?.close();
  });
  it("stores operator tokens only in its dedicated database and issues a separate opaque secure cookie", async () => {
    const b = browser(),
      authorization = await b.begin(),
      url = new URL(authorization);
    expect(url.pathname).toContain("/realms/operator/");
    expect(url.searchParams.get("client_id")).toBe("j-console");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBeTruthy();
    const callback = await b.code(
      authorization,
      required("JGW_OPERATOR_OP_ADMIN_PASSWORD"),
      "op-admin",
    );
    const response = await b.request(callback);
    expect(response.status).toBe(302);
    expect(
      response.headers
        .getSetCookie()
        .some(
          (x) =>
            x.startsWith(CONSOLE_COOKIES.session + "=") &&
            x.includes("HttpOnly") &&
            x.includes("Secure") &&
            x.includes("SameSite=Lax"),
        ),
    ).toBe(true);
    const info = await me(b);
    expect(info.roles).toEqual(
      expect.arrayContaining(["customer:read", "customer:write"]),
    );
    expect(b.cookies.get(origin)!.get(CONSOLE_COOKIES.session)).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    const row = (
      await pool.query<{
        access_token: string;
        refresh_token: string;
        tenant_id: string;
      }>(
        "SELECT access_token,refresh_token,tenant_id FROM sessions WHERE session_hash=$1",
        [hash(b)],
      )
    ).rows[0]!;
    expect(row.tenant_id).toBe("operator");
    r.secretValues.add(row.access_token);
    r.secretValues.add(row.refresh_token);
    const claims = JSON.parse(
      Buffer.from(row.access_token.split(".")[1]!, "base64url").toString(),
    ) as { azp: string; tenant: string };
    expect(claims).toMatchObject({ azp: "j-console", tenant: "operator" });
    expect(JSON.stringify(info)).not.toContain(row.access_token);
    expect(
      (
        await r.pool.query("SELECT 1 FROM sessions WHERE session_hash=$1", [
          hash(b),
        ])
      ).rowCount,
    ).toBe(0);
    expect((await b.request(callback)).status).toBe(401);
  });
  it("denies missing/customer cookies, bearer shortcuts and undeclared routes", async () => {
    const b = browser();
    expect((await b.request("/console/api/me")).status).toBe(401);
    const customer = new Browser(r.fetch, r.fixtures[0]!.origin);
    await customer.login(r.fixtures[0]!.password);
    const customerCookie = customer.cookies
      .get(customer.origin)!
      .get("__Host-jgw-session")!;
    for (const name of ["__Host-jgw-session", CONSOLE_COOKIES.session])
      expect(
        (
          await consoleFetch(origin + "/console/api/me", {
            headers: { Cookie: name + "=" + customerCookie },
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await consoleFetch(origin + "/console/api/me", {
          headers: { Authorization: "Bearer invalid" },
        })
      ).status,
    ).toBe(400);
    expect((await b.request("/console/api/customers")).status).toBe(404);
    const good = await login();
    await pool.query(
      "UPDATE sessions SET roles=ARRAY[]::text[] WHERE session_hash=$1",
      [hash(good)],
    );
    expect((await good.request("/console/api/me")).status).toBe(403);
  });
  it("rejects wrong state, issuer and nonce with no operator session creation", async () => {
    const state = browser(),
      start = await state.begin(),
      callback = await state.code(
        start,
        required("JGW_OPERATOR_OP_ADMIN_PASSWORD"),
        "op-admin",
      ),
      wrong = new URL(callback);
    wrong.searchParams.set("state", "A".repeat(43));
    expect((await state.request(wrong.toString())).status).toBe(401);
    wrong.searchParams.set(
      "state",
      new URL(callback).searchParams.get("state")!,
    );
    wrong.searchParams.set(
      "iss",
      required("KC_PUBLIC_URL") + "/realms/tenant-" + r.fixtures[0]!.tenant,
    );
    expect((await state.request(wrong.toString())).status).toBe(400);
    const nonce = browser(),
      auth = await nonce.begin();
    await pool.query(
      "UPDATE login_flows SET nonce='incorrect' WHERE flow_hash=$1",
      [digest(nonce.cookies.get(origin)!.get(CONSOLE_COOKIES.flow)!)],
    );
    expect(
      (
        await nonce.request(
          await nonce.code(
            auth,
            required("JGW_OPERATOR_OP_ADMIN_PASSWORD"),
            "op-admin",
          ),
        )
      ).status,
    ).toBe(401);
  });
  it("serializes concurrent actual refresh and rotates the saved refresh token", async () => {
    const b = await login(),
      h = hash(b),
      before = (
        await pool.query<{ refresh_token: string }>(
          "SELECT refresh_token FROM sessions WHERE session_hash=$1",
          [h],
        )
      ).rows[0]!.refresh_token,
      previous = refreshes;
    await pool.query(
      "UPDATE sessions SET access_expires_at=now()+interval '15 seconds' WHERE session_hash=$1",
      [h],
    );
    const responses = await Promise.all([
      b.request("/console/api/me"),
      b.request("/console/api/me"),
      b.request("/console/api/me"),
    ]);
    expect(responses.map((x) => x.status)).toEqual([200, 200, 200]);
    expect(refreshes - previous).toBe(1);
    const after = (
      await pool.query<{ refresh_token: string }>(
        "SELECT refresh_token FROM sessions WHERE session_hash=$1",
        [h],
      )
    ).rows[0]!.refresh_token;
    expect(after === before).toBe(false);
    r.secretValues.add(after);
  });
  it("protects logout with CSRF and uses the console RP logout target", async () => {
    const b = await login(),
      info = await me(b);
    expect(
      (
        await b.request("/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await b.request("/console/api/me")).status).toBe(200);
    const response = await b.request("/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "x-csrf-token": info.csrfToken,
      },
      body: "{}",
    });
    expect(response.status).toBe(303);
    const url = new URL(response.headers.get("location")!);
    expect(url.searchParams.get("client_id")).toBe("j-console");
    expect(url.searchParams.has("id_token_hint")).toBe(false);
    expect((await b.request("/console/api/me")).status).toBe(401);
  });
  it("ends the local session after real Keycloak operator backchannel logout and accepts idempotent replay", async () => {
    const b = await login(),
      h = hash(b),
      row = (
        await pool.query<{ sid: string }>(
          "SELECT sid FROM sessions WHERE session_hash=$1",
          [h],
        )
      ).rows[0]!;
    const before = tokens.length;
    expect(
      (
        await r.admin(
          "/admin/realms/operator/sessions/" + encodeURIComponent(row.sid),
          { method: "DELETE" },
        )
      ).status,
    ).toBe(204);
    let ended = false;
    for (let i = 0; i < 50; i++) {
      if (
        !(await pool.query("SELECT 1 FROM sessions WHERE session_hash=$1", [h]))
          .rowCount
      ) {
        ended = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ended).toBe(true);
    expect(tokens.length).toBeGreaterThan(before);
    expect((await b.request("/console/api/me")).status).toBe(401);
    const replay = await consoleFetch(origin + "/auth/backchannel-logout", {
      method: "POST",
      body: new URLSearchParams({ logout_token: tokens.at(-1)! }),
    });
    expect(replay.status).toBe(200);
    expect(
      (
        await consoleFetch(origin + "/auth/backchannel-logout", {
          method: "POST",
          body: new URLSearchParams({ logout_token: "invalid" }),
        })
      ).status,
    ).toBe(400);
  });
  it("returns 503 during actual console DB failure and recovers without losing its session", async () => {
    const b = await login();
    execFileSync("docker", ["stop", "suite-ready-console-pg-20261008"], {
      stdio: "ignore",
    });
    try {
      expect((await b.request("/console/api/me")).status).toBe(503);
    } finally {
      execFileSync("docker", ["start", "suite-ready-console-pg-20261008"], {
        stdio: "ignore",
      });
    }
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await pool.query("SELECT 1");
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(ready).toBe(true);
    expect((await b.request("/console/api/me")).status).toBe(200);
  });
  it("runs the compiled loopback HTTPS entry and shuts down cleanly without secret output", async () => {
    const external = parseEnv(
      await readFile(
        "/workspace/.suite-runtime/j-groupware/console/integration.env",
        "utf8",
      ),
    );
    const env = "/workspace/.suite-runtime/j-groupware/console/compiled.env";
    await writeFile(
      env,
      Object.entries({
        ...external,
        JGC_PORT: "55054",
        JGC_PUBLIC_ORIGIN: "https://console.jgw.test:55054",
        KC_PUBLIC_URL: required("KC_PUBLIC_URL"),
        JGC_CLIENT_SECRET: required("JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET"),
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    const logs: string[] = [];
    const child = spawn(
      process.execPath,
      [`--env-file=${env}`, "apps/console-server/dist/main.js"],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (bytes: Buffer) => logs.push(bytes.toString()));
    child.stderr.on("data", (bytes: Buffer) => logs.push(bytes.toString()));
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try {
          if (
            (await r.fetch("https://console.jgw.test:55054/health/ready"))
              .status === 200
          ) {
            ready = true;
            break;
          }
        } catch {}
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      expect(
        (await r.fetch("https://console.jgw.test:55054/console/api/me")).status,
      ).toBe(401);
    } finally {
      if (child.exitCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        timer.unref();
        try {
          await ended;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    expect(child.exitCode).toBe(0);
    for (const secret of r.secretValues)
      expect(logs.join("")).not.toContain(secret);
    expect(logs.join("")).not.toContain(
      required("JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET"),
    );
  });
});
