import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { AuthControlClient } from "../../apps/console-server/src/auth-control.js";
import { ConsoleAgentClient } from "../../deploy/agent/console-client.mjs";
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
  const customer = "console-" + randomUUID().slice(0, 8),
    secondCustomer = "console-" + randomUUID().slice(0, 8),
    createdCustomers: string[] = [];
  let agentKey = "",
    secondAgentKey = "",
    failProjection = false;
  const write = async (
    b: Browser,
    path: string,
    body: unknown,
    method = "POST",
  ) =>
    b.request(path, {
      method,
      headers: {
        Origin: origin,
        "x-csrf-token": (await me(b)).csrfToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const agentRequest = (
    key: string,
    path = "/console/api/agent/desired-state",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    consoleFetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
      authControl: new AuthControlClient(
        "https://jauth.jgw.test:54231",
        required("JAUTH_CONSOLE_SERVICE_KEY"),
        async (input, init) => {
          if (failProjection && String(input).includes("/services"))
            return r.fetch(String(input).replace(":54231", ":55057"), init);
          return r.fetch(input, init);
        },
      ),
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
    for (const tenant of createdCustomers) {
      await r.admin("/admin/realms/tenant-" + tenant, { method: "DELETE" });
      await r.authPool.query("DELETE FROM tenants WHERE tenant_id=$1", [
        tenant,
      ]);
      await pool.query("DELETE FROM agent_reports WHERE tenant_id=$1", [
        tenant,
      ]);
      await pool.query("DELETE FROM customers WHERE tenant_id=$1", [tenant]);
    }
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
    expect((await b.request("/console/api/customers")).status).toBe(401);
    expect((await b.request("/console/api/unregistered")).status).toBe(404);
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
  it("creates actual j-auth customers and returns bootstrap only once, storing agent hashes without plaintext secrets", async () => {
    const b = await login();
    for (const tenant of [customer, secondCustomer]) {
      expect(
        (
          await pool.query("SELECT 1 FROM customers WHERE tenant_id=$1", [
            tenant,
          ])
        ).rowCount,
      ).toBe(0);
      expect((await r.admin("/admin/realms/tenant-" + tenant)).status).toBe(
        404,
      );
      createdCustomers.push(tenant);
      const password = randomBytes(24).toString("base64url");
      r.secretValues.add(password);
      const result = await write(b, "/console/api/customers", {
        tenantId: tenant,
        adminUsername: "owner",
        adminPassword: password,
      });
      expect(result.status).toBe(201);
      const data = (await result.json()) as {
        agentKey: string;
        serviceKey: string;
        clientSecret: string;
        consoleOrigin: string;
      };
      expect(data.consoleOrigin).toBe(origin);
      expect(data.agentKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      for (const value of [data.agentKey, data.serviceKey, data.clientSecret])
        r.secretValues.add(value);
      if (tenant === customer) agentKey = data.agentKey;
      else secondAgentKey = data.agentKey;
      const row = (
        await pool.query("SELECT * FROM customers WHERE tenant_id=$1", [tenant])
      ).rows[0];
      expect(row.registration).toBe("ready");
      expect(row.agent_key_hash).toBe(digest(data.agentKey));
      for (const value of [
        password,
        data.agentKey,
        data.serviceKey,
        data.clientSecret,
      ])
        expect(JSON.stringify(row)).not.toContain(value);
      expect(
        (
          await write(b, "/console/api/customers", {
            tenantId: tenant,
            adminUsername: "owner",
            adminPassword: password,
          })
        ).status,
      ).toBe(409);
      const detail = await b.request("/console/api/customers/" + tenant);
      expect(detail.status).toBe(200);
      for (const value of [
        password,
        data.agentKey,
        data.serviceKey,
        data.clientSecret,
      ])
        expect(await detail.clone().text()).not.toContain(value);
    }
  });
  it("requires operator write and CSRF while customer list/status remain readable", async () => {
    const b = await login();
    expect((await b.request("/console/api/customers?limit=1")).status).toBe(
      200,
    );
    expect(
      (
        await b.request(`/console/api/customers/${customer}/agent-key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    await pool.query(
      "UPDATE sessions SET roles=ARRAY['customer:read']::text[] WHERE session_hash=$1",
      [hash(b)],
    );
    expect((await b.request(`/console/api/customers/${customer}`)).status).toBe(
      200,
    );
    expect(
      (await write(b, `/console/api/customers/${customer}/agent-key`, {}))
        .status,
    ).toBe(403);
    expect(
      (
        await agentRequest(
          agentKey,
          "/console/api/agent/desired-state",
          undefined,
          { Cookie: "any=value" },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await agentRequest(
          agentKey,
          "/console/api/agent/desired-state?tenant=" + secondCustomer,
        )
      ).status,
    ).toBe(400);
  });
  it("projects desired service changes through real j-auth while preserving separate installed reports", async () => {
    const b = await login();
    const detail = (await (
      await b.request(`/console/api/customers/${customer}`)
    ).json()) as { desiredRevision: number };
    const changed = await write(
      b,
      `/console/api/customers/${customer}/services/j-talk`,
      { revision: detail.desiredRevision, enabled: true },
      "PUT",
    );
    expect(changed.status).toBe(200);
    const result = (await changed.json()) as {
      desiredServices: string[];
      authServices: string[];
      authState: string;
      installation: unknown;
      desiredRevision: number;
    };
    expect(result).toMatchObject({
      desiredServices: ["j-talk"],
      authState: "applied",
      installation: null,
    });
    expect(result.authServices).toContain("j-talk");
    expect(
      (
        await write(
          b,
          `/console/api/customers/${customer}/services/j-web`,
          { revision: detail.desiredRevision, enabled: true },
          "PUT",
        )
      ).status,
    ).toBe(409);
    const desired = await (await agentRequest(agentKey)).json();
    expect(desired).toMatchObject({
      tenant: customer,
      services: ["j-talk"],
      revision: result.desiredRevision,
      agentEpoch: 1,
      reportSequence: 0,
    });
    expect(await (await agentRequest(secondAgentKey)).json()).toMatchObject({
      tenant: secondCustomer,
      services: [],
    });
  });
  it("keeps desired intent after an actual connection refusal and retries auth projection without claiming installation", async () => {
    const b = await login(),
      detail = (await (
        await b.request(`/console/api/customers/${customer}`)
      ).json()) as { desiredRevision: number };
    failProjection = true;
    try {
      expect(
        (
          await write(
            b,
            `/console/api/customers/${customer}/services/j-web`,
            { revision: detail.desiredRevision, enabled: true },
            "PUT",
          )
        ).status,
      ).toBe(503);
    } finally {
      failProjection = false;
    }
    const failed = (await (
      await b.request(`/console/api/customers/${customer}`)
    ).json()) as {
      desiredServices: string[];
      authServices: string[];
      authState: string;
      desiredRevision: number;
      installation: unknown;
    };
    expect(failed.desiredServices).toEqual(["j-talk", "j-web"]);
    expect(failed.authState).toBe("failed");
    expect(failed.authServices).not.toContain("j-web");
    expect(failed.installation).toBeNull();
    const retry = await write(
      b,
      `/console/api/customers/${customer}/reconcile`,
      {},
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      desiredRevision: failed.desiredRevision,
      authState: "applied",
      authServices: expect.arrayContaining(["j-talk", "j-web"]),
      installation: null,
    });
  });
  it("authenticates agent-only tenant and rejects stale revision, sequence or forged synchronized inventory", async () => {
    const current = (await (await agentRequest(agentKey)).json()) as {
      revision: number;
      agentEpoch: number;
      reportSequence: number;
    };
    const report = {
      desiredRevision: current.revision,
      agentEpoch: current.agentEpoch,
      reportSequence: current.reportSequence + 1,
      outcome: "failed",
      installed: ["j-talk"],
      phase: "provision",
      error: "provision_failed",
    };
    expect(
      (
        await agentRequest(agentKey, "/console/api/agent/status", {
          ...report,
          tenant: secondCustomer,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await agentRequest(agentKey, "/console/api/agent/status", {
          ...report,
          desiredRevision: current.revision - 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await agentRequest(agentKey, "/console/api/agent/status", {
          ...report,
          outcome: "synchronized",
        })
      ).status,
    ).toBe(400);
    expect(
      (await agentRequest(agentKey, "/console/api/agent/status", report))
        .status,
    ).toBe(200);
    expect(
      (await agentRequest(agentKey, "/console/api/agent/status", report))
        .status,
    ).toBe(200);
    expect(
      (
        await agentRequest(agentKey, "/console/api/agent/status", {
          ...report,
          error: "read_timeout",
        })
      ).status,
    ).toBe(409);
    const complete = {
      desiredRevision: current.revision,
      agentEpoch: current.agentEpoch,
      reportSequence: report.reportSequence + 1,
      outcome: "synchronized",
      installed: ["j-talk", "j-web"],
    };
    expect(
      (await agentRequest(agentKey, "/console/api/agent/status", complete))
        .status,
    ).toBe(200);
    expect(
      (await agentRequest(agentKey, "/console/api/agent/status", report))
        .status,
    ).toBe(409);
    const b = await login(),
      detail = (await (
        await b.request(`/console/api/customers/${customer}`)
      ).json()) as { installation: { report: { outcome: string } } };
    expect(detail.installation.report.outcome).toBe("synchronized");
    expect((await b.request("/console/api/agent/desired-state")).status).toBe(
      401,
    );
  });
  it("connects the real console wire client to desired/report and refuses a mismatched tenant", async () => {
    const client = new ConsoleAgentClient({
      tenant: customer,
      origin,
      key: agentKey,
      fetch: consoleFetch,
    });
    const desired = await client.desired();
    expect(desired).toEqual({
      tenant: customer,
      services: ["j-talk", "j-web"],
    });
    await client.report({
      tenant: customer,
      outcome: "synchronized",
      installed: desired.services,
    });
    const wrong = new ConsoleAgentClient({
      tenant: secondCustomer,
      origin,
      key: agentKey,
      fetch: consoleFetch,
    });
    await expect(wrong.desired()).rejects.toMatchObject({
      code: "invalid_state",
    });
    await expect(
      wrong.report({
        tenant: secondCustomer,
        outcome: "synchronized",
        installed: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("rotates and revokes agent hashes immediately without returning keys from reads", async () => {
    const b = await login(),
      previous = agentKey;
    const response = await write(
      b,
      `/console/api/customers/${customer}/agent-key`,
      {},
    );
    expect(response.status).toBe(200);
    agentKey = ((await response.json()) as { agentKey: string }).agentKey;
    r.secretValues.add(agentKey);
    expect((await agentRequest(previous)).status).toBe(401);
    expect(await (await agentRequest(agentKey)).json()).toMatchObject({
      tenant: customer,
      agentEpoch: 2,
      reportSequence: 0,
    });
    expect(
      (
        await write(
          b,
          `/console/api/customers/${customer}/agent-key`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    expect((await agentRequest(agentKey)).status).toBe(401);
  });
  it("records lost bootstrap after a real post-create DB failure and permits only explicit upstream secret reset", async () => {
    const tenant = "console-" + randomUUID().slice(0, 8),
      b = await login();
    createdCustomers.push(tenant);
    const password = randomBytes(24).toString("base64url");
    r.secretValues.add(password);
    await pool.query(
      "CREATE FUNCTION fixture_console_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.registration='ready' THEN RAISE EXCEPTION 'fixture final storage refusal'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER fixture_console_completion BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION fixture_console_completion()",
    );
    try {
      const failure = await write(b, "/console/api/customers", {
        tenantId: tenant,
        adminUsername: "owner",
        adminPassword: password,
      });
      expect(failure.status).toBe(503);
      expect(await failure.json()).toMatchObject({
        code: "bootstrap_unrecoverable",
      });
      const row = (
        await pool.query(
          "SELECT registration,agent_key_hash FROM customers WHERE tenant_id=$1",
          [tenant],
        )
      ).rows[0];
      expect(row).toEqual({
        registration: "bootstrap_unrecoverable",
        agent_key_hash: null,
      });
      expect((await r.admin("/admin/realms/tenant-" + tenant)).status).toBe(
        200,
      );
    } finally {
      await pool.query("DROP TRIGGER fixture_console_completion ON customers");
      await pool.query("DROP FUNCTION fixture_console_completion()");
    }
    const reset = await write(
      b,
      `/console/api/customers/${tenant}/bootstrap/reset`,
      {},
    );
    expect(reset.status).toBe(200);
    const data = (await reset.json()) as {
      agentKey: string;
      serviceKey: string;
      clientSecret: string;
    };
    for (const key of Object.values(data))
      if (typeof key === "string" && key.length > 20) r.secretValues.add(key);
    expect((await agentRequest(data.agentKey)).status).toBe(200);
  });
});
