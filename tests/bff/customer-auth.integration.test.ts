import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { request as httpsRequest } from "node:https";
import { Pool } from "pg";
import { createLocalJWKSet, jwtVerify, decodeJwt } from "jose";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { Browser, integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { OidcClient } from "../../apps/server/src/oidc.js";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { digest } from "../../apps/server/src/security.js";
import { PostgresServiceDatabase } from "../../deploy/agent/service-database.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";
import { createApp as createBffApp } from "../../apps/server/src/app.js";
import { createApp } from "../../../j-customer-auth-db/apps/server/dist/app.js";
import { GuestSigner } from "../../../j-customer-auth-db/apps/server/dist/security.js";
import { PageCursor } from "../../../j-customer-auth-db/apps/server/dist/security.js";
import { CustomerStore } from "../../../j-customer-auth-db/apps/server/dist/store.js";
import { migrate } from "../../../j-customer-auth-db/apps/server/dist/db/migrate.js";
import type {
  Guest,
  IssuedApiKey,
  GuestLoginResult,
} from "@j-customer-auth-db/contracts";

describe("actual customer-auth PostgreSQL and member/site authentication", () => {
  let rt: Runtime,
    root: string,
    admin: Pool,
    pool: Pool,
    db: PostgresServiceDatabase;
  let ownerToken: string,
    readerToken: string,
    deniedToken: string,
    foreignToken: string,
    bffToken: string;
  let signer: GuestSigner,
    faultApp: Awaited<ReturnType<typeof createApp>>,
    jwksFault: FastifyInstance;
  let first: Guest, second: Guest, issued: IssuedApiKey;
  let ownerBrowser: Browser,
    readerBrowser: Browser,
    deniedBrowser: Browser,
    writerBrowser: Browser,
    foreignBrowser: Browser;
  let malformedMode = "extra";
  const container = "jcadb-integration-" + randomUUID().slice(0, 8),
    password = randomBytes(32).toString("base64url"),
    guestPassword = "permanent-guest-fixture-7498",
    dbPassword = randomBytes(32).toString("base64url");
  const children: ReturnType<typeof spawn>[] = [],
    logs: string[] = [],
    servers: FastifyInstance[] = [];
  let containerOwned = false;
  async function free(port: number) {
    if (port === 3001) throw new Error("Reserved port refused.");
    const occupied = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(500, () => done(false));
    });
    if (occupied)
      throw new Error(
        "Customer-auth fixture port occupied; existing process preserved.",
      );
  }
  async function token(browser: Browser, index = 0) {
    const fixture = rt.fixtures[index]!;
    const cookie = browser.cookies
      .get(new URL(fixture.origin).origin)
      ?.get(SESSION_POLICY.cookie);
    const source = (
      await rt.pool.query<{ access_token: string }>(
        "SELECT access_token FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
        [fixture.tenant, digest(cookie!)],
      )
    ).rows[0]!.access_token;
    rt.secretValues.add(source);
    const value = await new OidcClient(fixture.config, {
      fetch: rt.fetch,
    }).serviceToken(source, "j-customer-auth-db");
    rt.secretValues.add(value);
    expect(decodeJwt(value).aud).toBe("j-customer-auth-db");
    return { value, source };
  }
  async function request(
    path: string,
    bearer = ownerToken,
    body?: unknown,
    method = "GET",
    port = 55071,
  ) {
    return rt.fetchLoopback(`https://127.0.0.1:${port}` + path, {
      method,
      headers: {
        Authorization: "Bearer " + bearer,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  }
  async function external(
    path: string,
    secret = issued.secret,
    body?: unknown,
    method = "GET",
    extra: Record<string, string> = {},
  ) {
    return rt.fetchLoopback("https://127.0.0.1:55071" + path, {
      method,
      headers: {
        "X-JCADB-API-Key": secret,
        ...extra,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  }
  async function newKey(scopes = ["guest:read"]) {
    const response = await request(
      "/customer-auth/api-keys",
      ownerToken,
      { name: "site-server", scopes },
      "POST",
    );
    expect(response.status).toBe(201);
    const value = (await response.json()) as IssuedApiKey;
    rt.secretValues.add(value.secret);
    return value;
  }
  async function clearLimits() {
    await pool.query("DELETE FROM login_limits WHERE tenant_id=$1", [
      rt.fixtures[0]!.tenant,
    ]);
  }
  beforeAll(async () => {
    if (process.env.JGW_TEST_RUNTIME !== "isolated-cloud")
      throw new Error("Explicit isolated runtime required; no skip.");
    for (const port of [55070, 55071, 55072, 55073, 55076]) await free(port);
    root = await mkdtemp(tmpdir() + "/jcadb-");
    await writeFile(
      root + "/postgres.env",
      "POSTGRES_PASSWORD=" + password + "\n",
      { mode: 0o600 },
    );
    await execute("docker", [
      "run",
      "--detach",
      "--name",
      container,
      "--env-file",
      root + "/postgres.env",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=256m",
      "--publish",
      "127.0.0.1:55070:5432",
      "postgres:18.6",
    ]);
    containerOwned = true;
    admin = new Pool({
      host: "127.0.0.1",
      port: 55070,
      database: "postgres",
      user: "postgres",
      password,
      connectionTimeoutMillis: 1000,
    });
    admin.on("error", () => {});
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        await admin.query("SELECT 1");
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(ready).toBe(true);
    rt = await integrationRuntime({
      serviceEndpointsForTenant: (_tenant, index) => ({
        "j-customer-auth-db": `https://127.0.0.1:${55071 + index}`,
      }),
    });
    rt.secretValues.add(guestPassword);
    rt.secretValues.add(dbPassword);
    for (const [index] of rt.fixtures.entries())
      expect((await rt.subscribe(index, "j-customer-auth-db")).status).toBe(
        200,
      );
    db = new PostgresServiceDatabase({
      admin,
      tenant: rt.fixtures[0]!.tenant,
      connection: () => ({ host: "127.0.0.1", port: 55070 }),
      dumpBinary: "/workspace/.cloud-setup/pg18/bin/pg_dump",
    });
    await db.prepareBase();
    await db.ensure("j-customer-auth-db", dbPassword);
    pool = new Pool({
      host: "127.0.0.1",
      port: 55070,
      database: "jgw_customer_auth",
      user: "jgw_customer_auth",
      password: dbPassword,
      max: 10,
      connectionTimeoutMillis: 1000,
      statement_timeout: 5000,
    });
    pool.on("error", () => {});
    await migrate(pool);
    await migrate(pool);
    const signingKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ type: "pkcs8", format: "pem" });
    await writeFile(root + "/signing.key", signingKey, { mode: 0o600 });
    const caFile = process.env.JAUTH_TLS_CERTIFICATE!;
    for (const [index, fixture] of rt.fixtures.entries()) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "./tests/bff/resolve-customer-auth-test-hosts.mjs",
          "../j-customer-auth-db/apps/server/dist/main.js",
        ],
        {
          cwd: "/workspace/j-groupware",
          env: {
            ...process.env,
            JCADB_TENANT: fixture.tenant,
            JCADB_PUBLIC_ORIGIN: fixture.origin,
            JCADB_PORT: String(55071 + index),
            JCADB_DB_PORT: "55070",
            JCADB_DB_PASSWORD: dbPassword,
            JCADB_TLS_CERTIFICATE: caFile,
            JCADB_TLS_KEY: process.env.JAUTH_TLS_KEY!,
            JCADB_CA_CERTIFICATE: caFile,
            JCADB_GUEST_SIGNING_KEY: root + "/signing.key",
            JCADB_CURSOR_SIGNING_KEY: randomBytes(32).toString("base64url"),
          },
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        },
      );
      children.push(child);
      child.stdout?.on("data", (b) => logs.push(String(b)));
      child.stderr?.on("data", (b) => logs.push(String(b)));
      let available = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null)
          throw new Error(
            "Compiled customer-auth startup failed: " +
              logs
                .join("\n")
                .replace(
                  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
                  "[JWT redacted]",
                )
                .replace(/jcadb_[A-Za-z0-9_-]{43}/g, "[key redacted]"),
          );
        try {
          if (
            (
              await rt.fetchLoopback(
                `https://127.0.0.1:${55071 + index}/health/ready`,
                { signal: AbortSignal.timeout(300) },
              )
            ).ok
          ) {
            available = true;
            break;
          }
        } catch {
          /* bounded readiness */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(available).toBe(true);
    }
    const owner = new Browser(rt.fetch, rt.fixtures[0]!.origin),
      foreign = new Browser(rt.fetch, rt.fixtures[1]!.origin);
    ownerBrowser = owner;
    foreignBrowser = foreign;
    await owner.login(rt.fixtures[0]!.password);
    await foreign.login(rt.fixtures[1]!.password);
    const own = await token(owner);
    ownerToken = own.value;
    bffToken = own.source;
    foreignToken = (await token(foreign, 1)).value;
    for (const [name, roles] of [
      ["guest-reader", ["guest:read"]],
      ["guest-denied", []],
      ["guest-writer", ["guest:write"]],
    ] as const) {
      const memberPassword = randomBytes(24).toString("base64url");
      rt.secretValues.add(memberPassword);
      expect(
        (
          await owner.change("/api/members", {
            username: name,
            password: memberPassword,
            roles,
          })
        ).status,
      ).toBe(201);
      const browser = new Browser(rt.fetch, rt.fixtures[0]!.origin);
      await browser.login(memberPassword, name);
      const value = (await token(browser)).value;
      if (name === "guest-reader") {
        readerToken = value;
        readerBrowser = browser;
      } else if (name === "guest-denied") {
        deniedToken = value;
        deniedBrowser = browser;
      } else writerBrowser = browser;
    }
    signer = await GuestSigner.create(signingKey, rt.fixtures[0]!.origin);
    const [cert, key] = await Promise.all([
      readFile(caFile),
      readFile(process.env.JAUTH_TLS_KEY!),
    ]);
    jwksFault = Fastify({ https: { cert, key } });
    servers.push(jwksFault);
    jwksFault.get<{ Params: { id: string } }>(
      "/customer-auth/guests/:id",
      async (request, reply) => {
        if (malformedMode === "error")
          return reply
            .code(404)
            .send({ message: "private SQL and password fixture" });
        if (malformedMode === "large")
          return reply.type("application/json").send("x".repeat(1048577));
        return reply.header("Set-Cookie", "upstream-private=fixture").send({
          id: request.params.id,
          name: malformedMode === "type" ? { private: true } : "upstream guest",
          loginId: "upstream-guest",
          contact: "",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
          password_hash: "private-password-hash-fixture",
          tenant_id: "private-tenant",
          api_key: "private-key-fixture",
        });
      },
    );
    jwksFault.get("/*", async (_request, reply) =>
      reply.code(503).send({ unavailable: true }),
    );
    await jwksFault.listen({ host: "127.0.0.1", port: 55073 });
    faultApp = await createApp({
      pool,
      tenant: rt.fixtures[0]!.tenant,
      keycloakOrigin: process.env.KC_PUBLIC_URL!,
      cursorKey: randomBytes(32).toString("base64url"),
      signer,
      fetch: async () => rt.fetchLoopback("https://127.0.0.1:55073/certs"),
    });
    servers.push(faultApp);
  }, 120000);
  afterAll(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        timer.unref();
        await exit;
        clearTimeout(timer);
      }
    for (const server of servers) await server.close();
    await pool?.end();
    await admin?.end();
    await rt?.close();
    if (containerOwned)
      await execute("docker", ["rm", "--force", "--volumes", container]);
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("relays real BFF guest CRUD, literal paging and write-implies-read with the published contracts", async () => {
    expect((await writerBrowser.me()).roles).toContain("guest:read");
    const made: Guest[] = [];
    for (const suffix of ["a", "b"]) {
      const response = await writerBrowser.change("/api/customer-auth/guests", {
        name: "relay %_ " + suffix,
        loginId: "relay-" + suffix,
        contact: "server fixture",
        password: guestPassword,
      });
      expect(response.status).toBe(201);
      made.push((await response.json()) as Guest);
    }
    const response = await readerBrowser.request(
      "/api/customer-auth/guests?q=" +
        encodeURIComponent("relay %_") +
        "&limit=1",
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: Guest[]; next: string };
    expect(page.items).toHaveLength(1);
    expect(page.next).toBeTruthy();
    const next = await readerBrowser.request(
      "/api/customer-auth/guests?q=" +
        encodeURIComponent("relay %_") +
        "&limit=1&cursor=" +
        encodeURIComponent(page.next),
    );
    expect(next.status).toBe(200);
    expect(((await next.json()) as { items: Guest[] }).items[0]!.id).not.toBe(
      page.items[0]!.id,
    );
    const changed = await writerBrowser.change(
      "/api/customer-auth/guests/" + made[0]!.id.toUpperCase(),
      { name: "수정한 손님" },
      "PATCH",
    );
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as Guest).name).toBe("수정한 손님");
    const direct = await request(
      "/customer-auth/guests/" + made[0]!.id,
      readerToken,
    );
    expect(((await direct.json()) as Guest).name).toBe("수정한 손님");
    const keys = Object.keys(
      (await (
        await readerBrowser.request("/api/customer-auth/guests/" + made[0]!.id)
      ).json()) as object,
    ).sort();
    expect(keys).toEqual([
      "contact",
      "createdAt",
      "id",
      "loginId",
      "name",
      "updatedAt",
    ]);
    for (const guest of made)
      expect(
        (
          await writerBrowser.change(
            "/api/customer-auth/guests/" + guest.id,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(204);
    expect(
      (await readerBrowser.request("/api/customer-auth/guests/" + made[0]!.id))
        .status,
    ).toBe(404);
    const cached = await rt.pool.query<{ access_token: string }>(
      "SELECT access_token FROM service_tokens WHERE tenant_id=$1 AND service_id='j-customer-auth-db'",
      [rt.fixtures[0]!.tenant],
    );
    expect(cached.rowCount).toBeGreaterThan(0);
    for (const row of cached.rows) {
      rt.secretValues.add(row.access_token);
      expect(decodeJwt(row.access_token).aud).toBe("j-customer-auth-db");
    }
  });
  it("refuses BFF missing session, roles, CSRF, tenant spoofing and cross-tenant resources before changing data", async () => {
    const before = (
      await pool.query(
        "SELECT id,name,login_id FROM guests ORDER BY tenant_id,id",
      )
    ).rows;
    const input = {
      name: "forbidden guest",
      loginId: "forbidden-guest",
      password: guestPassword,
    };
    const anon = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    expect((await anon.request("/api/customer-auth/guests")).status).toBe(401);
    expect(
      (await deniedBrowser.request("/api/customer-auth/guests")).status,
    ).toBe(403);
    expect(
      (await readerBrowser.change("/api/customer-auth/guests", input)).status,
    ).toBe(403);
    expect(
      (await readerBrowser.request("/api/customer-auth/api-keys")).status,
    ).toBe(403);
    expect(
      (
        await ownerBrowser.request("/api/customer-auth/guests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await ownerBrowser.change("/api/customer-auth/guests", {
          ...input,
          tenant: rt.fixtures[1]!.tenant,
        })
      ).status,
    ).toBe(400);
    expect(
      (await ownerBrowser.request("/api/customer-auth/guests?q=%00")).status,
    ).toBe(400);
    const guestResponse = await ownerBrowser.change(
      "/api/customer-auth/guests",
      { ...input, loginId: "isolated-relay" },
    );
    expect(guestResponse.status).toBe(201);
    const guest = (await guestResponse.json()) as Guest;
    expect(
      (await foreignBrowser.request("/api/customer-auth/guests/" + guest.id))
        .status,
    ).toBe(404);
    expect(
      (
        await foreignBrowser.change(
          "/api/customer-auth/guests/" + guest.id,
          { name: "foreign" },
          "PATCH",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await ownerBrowser.change(
          "/api/customer-auth/guests/" + guest.id,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await pool.query(
          "SELECT id,name,login_id FROM guests ORDER BY tenant_id,id",
        )
      ).rows,
    ).toEqual(before);
  });
  it("issues and revokes BFF API keys once while refusing external login/write proxy routes", async () => {
    const created = await writerBrowser.change("/api/customer-auth/api-keys", {
      name: "relay-site",
      scopes: ["guest:read"],
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as IssuedApiKey;
    rt.secretValues.add(key.secret);
    const rows = await writerBrowser.request("/api/customer-auth/api-keys");
    expect(rows.status).toBe(200);
    const text = await rows.text();
    expect(text).not.toContain(key.secret);
    expect(text).not.toContain("key_hash");
    expect(
      (await external("/ext/customer-auth/v1/guests", key.secret)).status,
    ).toBe(200);
    const revoked = await writerBrowser.change(
      "/api/customer-auth/api-keys/" + key.apiKey.id.toUpperCase(),
      undefined,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect(
      ((await revoked.json()) as { revokedAt: string }).revokedAt,
    ).toBeTruthy();
    expect(
      (await external("/ext/customer-auth/v1/guests", key.secret)).status,
    ).toBe(401);
    expect(
      (
        await writerBrowser.request("/api/customer-auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            loginId: "relay-site",
            password: guestPassword,
          }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await writerBrowser.request(
          "/api/customer-auth/ext/customer-auth/v1/guests",
        )
      ).status,
    ).toBe(404);
  });
  it("bounds and whitelists actual TLS upstream responses without forwarding private fields, cookies or error text", async () => {
    const fixture = rt.fixtures[0]!;
    const bff = createBffApp({
      pool: rt.pool,
      config: fixture.config,
      oidc: new OidcClient(fixture.config, { fetch: rt.fetch }),
      https: {
        cert: await readFile(process.env.JGW_TLS_CERTIFICATE!),
        key: await readFile(process.env.JGW_TLS_KEY!),
      },
      serviceEndpoints: { "j-customer-auth-db": "https://127.0.0.1:55073" },
      serviceFetch: rt.fetchLoopback,
    });
    servers.push(bff);
    await bff.listen({ host: "127.0.0.1", port: 55076 });
    const cookie = ownerBrowser.cookies
      .get(new URL(fixture.origin).origin)!
      .get(SESSION_POLICY.cookie)!;
    const ca = await readFile(process.env.JGW_TLS_CERTIFICATE!);
    const call = () =>
      new Promise<Response>((resolve, reject) => {
        const request = httpsRequest(
          {
            hostname: "127.0.0.1",
            port: 55076,
            servername: new URL(fixture.origin).hostname,
            ca,
            path: "/api/customer-auth/guests/" + randomUUID(),
            headers: {
              Host: new URL(fixture.origin).host,
              Cookie: SESSION_POLICY.cookie + "=" + cookie,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 2097152)
                response.destroy(
                  new Error("Bounded fixture response exceeded."),
                );
              else chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => {
              const headers = new Headers();
              for (const [name, value] of Object.entries(response.headers))
                for (const item of Array.isArray(value)
                  ? value
                  : value === undefined
                    ? []
                    : [value])
                  headers.append(name, item);
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode!,
                  headers,
                }),
              );
            });
          },
        );
        request.on("error", reject);
        request.setTimeout(10000, () =>
          request.destroy(new Error("Fixture request timed out.")),
        );
        request.end();
      });
    malformedMode = "extra";
    const safe = await call();
    expect(safe.status).toBe(200);
    const body = await safe.text();
    expect(body).not.toContain("private");
    expect(safe.headers.get("set-cookie")).toBeNull();
    for (const mode of ["type", "large"]) {
      malformedMode = mode;
      expect((await call()).status).toBe(503);
    }
    malformedMode = "error";
    const error = await call();
    expect(error.status).toBe(404);
    expect(await error.text()).not.toContain("private SQL");
    await bff.close();
    servers.splice(servers.indexOf(bff), 1);
  });
  it("creates actual non-superuser isolated database and detects migration checksum drift", async () => {
    expect(
      (
        await pool.query(
          "SELECT current_user,current_database() AS db,rolsuper FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0],
    ).toEqual({
      current_user: "jgw_customer_auth",
      db: "jgw_customer_auth",
      rolsuper: false,
    });
    const other = new Pool({
      host: "127.0.0.1",
      port: 55070,
      database: "postgres",
      user: "jgw_customer_auth",
      password: dbPassword,
      connectionTimeoutMillis: 1000,
    });
    await expect(other.query("SELECT 1")).rejects.toMatchObject({
      code: "42501",
    });
    await other.end();
    const row = (
      await pool.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations LIMIT 1",
      )
    ).rows[0]!;
    await pool.query("UPDATE schema_migrations SET checksum='drift'");
    await expect(migrate(pool)).rejects.toThrow("modified");
    await pool.query("UPDATE schema_migrations SET checksum=$1", [
      row.checksum,
    ]);
    await migrate(pool);
  });
  it("performs actual CRUD, literal search and signed pagination without password disclosure", async () => {
    for (const [index, loginId] of ["guest.7498", "second.7498"].entries()) {
      const response = await request(
        "/customer-auth/guests",
        ownerToken,
        {
          name: index ? "둘째" : "literal%_손님",
          loginId,
          contact: " contact ",
          password: guestPassword,
        },
        "POST",
      );
      expect(response.status).toBe(201);
      const guest = (await response.json()) as Guest;
      expect(Object.keys(guest).sort()).toEqual([
        "contact",
        "createdAt",
        "id",
        "loginId",
        "name",
        "updatedAt",
      ]);
      if (index) second = guest;
      else first = guest;
    }
    expect(
      (await request("/customer-auth/guests/" + first.id, readerToken)).status,
    ).toBe(200);
    const search = await request("/customer-auth/guests?q=%25_", readerToken);
    expect(
      ((await search.json()) as { items: Guest[] }).items.map((g) => g.id),
    ).toEqual([first.id]);
    const page = await request("/customer-auth/guests?limit=1", readerToken),
      body = (await page.json()) as { items: Guest[]; next: string };
    expect(body.items).toHaveLength(1);
    expect(body.next).toBeTruthy();
    const next = await request(
      "/customer-auth/guests?limit=1&cursor=" + encodeURIComponent(body.next),
      readerToken,
    );
    expect(((await next.json()) as { items: Guest[] }).items[0]!.id).not.toBe(
      body.items[0]!.id,
    );
    expect(
      (
        await request(
          "/customer-auth/guests?q=other&cursor=" +
            encodeURIComponent(body.next),
          readerToken,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          "/customer-auth/guests?cursor=" + encodeURIComponent(body.next),
          foreignToken,
          undefined,
          "GET",
          55072,
        )
      ).status,
    ).toBe(400);
    const hash = (
      await pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM guests WHERE tenant_id=$1 AND id=$2",
        [rt.fixtures[0]!.tenant, first.id],
      )
    ).rows[0]!.password_hash;
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain(guestPassword);
    expect(
      (
        await request(
          "/customer-auth/guests",
          ownerToken,
          {
            name: "duplicate",
            loginId: first.loginId,
            password: guestPassword,
          },
          "POST",
        )
      ).status,
    ).toBe(409);
    const updated = await request(
      "/customer-auth/guests/" + second.id,
      ownerToken,
      { name: "updated" },
      "PATCH",
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as Guest).name).toBe("updated");
  });
  it("rejects role, tenant, audience, signature, cookie and forged inputs without DB mutation", async () => {
    const before = (
      await pool.query("SELECT count(*)::int AS count FROM guests")
    ).rows[0];
    expect(
      (
        await request(
          "/customer-auth/guests",
          readerToken,
          { name: "blocked", loginId: "blocked.7498", password: guestPassword },
          "POST",
        )
      ).status,
    ).toBe(403);
    expect((await request("/customer-auth/guests", deniedToken)).status).toBe(
      403,
    );
    expect((await request("/customer-auth/guests", foreignToken)).status).toBe(
      401,
    );
    expect(
      (
        await request(
          "/customer-auth/guests/" + first.id,
          foreignToken,
          undefined,
          "GET",
          55072,
        )
      ).status,
    ).toBe(404);
    expect((await request("/customer-auth/guests", bffToken)).status).toBe(401);
    expect(
      (
        await request(
          "/customer-auth/guests",
          ownerToken.slice(0, -8) + "AAAAAAAA",
        )
      ).status,
    ).toBe(401);
    const cookie = await rt.fetchLoopback(
      "https://127.0.0.1:55071/customer-auth/guests",
      {
        headers: {
          Authorization: "Bearer " + ownerToken,
          Cookie: "session=forged",
        },
      },
    );
    expect(cookie.status).toBe(401);
    expect(
      (
        await request(
          "/customer-auth/guests",
          ownerToken,
          {
            tenant: rt.fixtures[1]!.tenant,
            name: "forged",
            loginId: "forged.7498",
            password: guestPassword,
          },
          "POST",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          "/customer-auth/guests/" + first.id,
          ownerToken,
          { password: "another-password-7498" },
          "PATCH",
        )
      ).status,
    ).toBe(400);
    expect(
      (await request("/customer-auth/guests?q=%00", readerToken)).status,
    ).toBe(400);
    expect(
      (
        await request(
          "/customer-auth/guests",
          ownerToken,
          {
            name: "invalid",
            loginId: "invalid.7498\n",
            password: guestPassword,
          },
          "POST",
        )
      ).status,
    ).toBe(400);
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM guests")).rows[0],
    ).toEqual(before);
    const unavailable = await faultApp.inject({
      method: "GET",
      url: "/customer-auth/guests",
      headers: { authorization: "Bearer " + ownerToken },
    });
    expect(unavailable.statusCode).toBe(503);
  });
  it("issues keys once, stores hashes only and exposes only external schemas", async () => {
    issued = await newKey();
    const writeKey = await newKey(["guest:write"]);
    expect(issued.secret).toMatch(/^jcadb_[A-Za-z0-9_-]{43}$/);
    const rows = (
      await pool.query("SELECT key_hash FROM api_keys WHERE id=$1", [
        issued.apiKey.id,
      ])
    ).rows;
    expect(rows[0]).toEqual({ key_hash: digest(issued.secret) });
    const list = await request("/customer-auth/api-keys");
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(issued.secret);
    expect(text).not.toContain(rows[0]!.key_hash);
    expect((await request("/customer-auth/api-keys", readerToken)).status).toBe(
      403,
    );
    expect(
      (
        await request(
          "/customer-auth/api-keys",
          ownerToken,
          { name: "bad", scopes: ["admin"] },
          "POST",
        )
      ).status,
    ).toBe(400);
    expect(
      (await external("/ext/customer-auth/v1/guests", writeKey.secret)).status,
    ).toBe(200);
    expect(
      (await request("/ext/customer-auth/v1/guests", ownerToken)).status,
    ).toBe(401);
    expect(
      (
        await external(
          "/ext/customer-auth/v1/guests",
          issued.secret,
          {},
          "POST",
        )
      ).status,
    ).toBe(404);
    const doc = await rt.fetchLoopback(
        "https://127.0.0.1:55071/ext/customer-auth/openapi.json",
      ),
      spec = (await doc.json()) as {
        paths: Record<string, unknown>;
        components: { securitySchemes: Record<string, { name: string }> };
      };
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/ext/customer-auth/v1/guests",
      "/ext/customer-auth/v1/jwks",
      "/ext/customer-auth/v1/login",
    ]);
    expect(spec.components.securitySchemes.apiKey!.name).toBe(
      "X-JCADB-API-Key",
    );
    expect(JSON.stringify(spec)).not.toContain(issued.secret);
    expect(JSON.stringify(spec)).not.toContain("/customer-auth/api-keys");
  });
  it("serves site-server login and verifies actual public JWKS, expiry and signature", async () => {
    await clearLimits();
    const login = await external(
      "/ext/customer-auth/v1/login",
      issued.secret,
      { loginId: first.loginId, password: guestPassword },
      "POST",
    );
    expect(login.status).toBe(200);
    const body = (await login.json()) as GuestLoginResult;
    rt.secretValues.add(body.accessToken);
    const jwks = (await (
      await rt.fetchLoopback(
        "https://127.0.0.1:55071/ext/customer-auth/v1/jwks",
      )
    ).json()) as Parameters<typeof createLocalJWKSet>[0];
    expect(jwks.keys[0]).not.toHaveProperty("d");
    const verifier = createLocalJWKSet(jwks),
      verified = await jwtVerify(body.accessToken, verifier, {
        issuer: rt.fixtures[0]!.origin + "/ext/customer-auth",
        audience: "j-customer-auth-db-guest",
        algorithms: ["RS256"],
      });
    expect(verified.payload).toMatchObject({
      sub: first.id,
      tenant: rt.fixtures[0]!.tenant,
      typ: "Guest",
    });
    expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(
      300,
    );
    await expect(
      jwtVerify(body.accessToken, verifier, {
        currentDate: new Date((Number(verified.payload.exp) + 1) * 1000),
      }),
    ).rejects.toThrow();
    await expect(
      jwtVerify(body.accessToken.slice(0, -8) + "AAAAAAAA", verifier),
    ).rejects.toThrow();
    expect(
      (await request("/ext/customer-auth/v1/guests", body.accessToken)).status,
    ).toBe(401);
    const wrong = await external(
        "/ext/customer-auth/v1/login",
        issued.secret,
        { loginId: first.loginId, password: "wrong-password-7498" },
        "POST",
      ),
      absent = await external(
        "/ext/customer-auth/v1/login",
        issued.secret,
        { loginId: "absent.7498", password: "wrong-password-7498" },
        "POST",
      );
    expect(wrong.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(await absent.json()).toEqual(await wrong.json());
    const foreign = await request(
      "/customer-auth/api-keys",
      foreignToken,
      { name: "foreign-site", scopes: ["guest:read"] },
      "POST",
      55072,
    );
    const foreignKey = (await foreign.json()) as IssuedApiKey;
    rt.secretValues.add(foreignKey.secret);
    expect(
      (
        await external(
          "/ext/customer-auth/v1/login",
          foreignKey.secret,
          { loginId: first.loginId, password: guestPassword },
          "POST",
        )
      ).status,
    ).toBe(401);
  });
  it("persists guest/IP limits across a fresh server instance and ignores spoofed forwarding", async () => {
    await clearLimits();
    for (let i = 0; i < 10; i++)
      expect(
        (
          await external(
            "/ext/customer-auth/v1/login",
            issued.secret,
            { loginId: "limited.7498", password: "wrong-password-7498" },
            "POST",
            { "X-Forwarded-For": "203.0.113." + i },
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await external(
          "/ext/customer-auth/v1/login",
          issued.secret,
          { loginId: "limited.7498", password: "wrong-password-7498" },
          "POST",
        )
      ).status,
    ).toBe(429);
    const fresh = await createApp({
      pool,
      tenant: rt.fixtures[0]!.tenant,
      keycloakOrigin: process.env.KC_PUBLIC_URL!,
      cursorKey: randomBytes(32).toString("base64url"),
      signer,
    });
    servers.push(fresh);
    expect(
      (
        await fresh.inject({
          method: "POST",
          url: "/ext/customer-auth/v1/login",
          headers: { "x-jcadb-api-key": issued.secret },
          payload: { loginId: "limited.7498", password: "wrong-password-7498" },
        })
      ).statusCode,
    ).toBe(429);
    await pool.query(
      "UPDATE login_limits SET attempts=60 WHERE tenant_id=$1 AND kind='ip'",
      [rt.fixtures[0]!.tenant],
    );
    expect(
      (
        await external(
          "/ext/customer-auth/v1/login",
          issued.secret,
          { loginId: "independent.7498", password: "wrong-password-7498" },
          "POST",
          { "X-Forwarded-For": "198.51.100.123" },
        )
      ).status,
    ).toBe(429);
    await clearLimits();
  });
  it("waits for in-flight key use before completing revocation", async () => {
    const key = await newKey();
    const store = new CustomerStore(
      pool,
      rt.fixtures[0]!.tenant,
      new PageCursor(randomBytes(32).toString("base64url")),
    );
    let entered!: () => void, release!: () => void;
    const arrival = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const use = store.withApiKey(key.secret, async () => {
      entered();
      await barrier;
      return true;
    });
    await arrival;
    let finished = false;
    const revoke = request(
      "/customer-auth/api-keys/" + key.apiKey.id,
      ownerToken,
      undefined,
      "DELETE",
    ).then((result) => {
      finished = true;
      return result;
    });
    try {
      let waiting = false;
      for (let i = 0; i < 50; i++) {
        const result = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname='jgw_customer_auth' AND wait_event_type='Lock' AND query LIKE 'UPDATE api_keys%' LIMIT 1",
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      expect(finished).toBe(false);
    } finally {
      release();
    }
    expect(await use).toBe(true);
    expect((await revoke).status).toBe(200);
    expect(
      (await external("/ext/customer-auth/v1/guests", key.secret)).status,
    ).toBe(401);
  });
  it("revalidates revoked keys immediately and preserves other tenant data", async () => {
    expect(
      (
        await request(
          "/customer-auth/api-keys/" + issued.apiKey.id,
          foreignToken,
          undefined,
          "DELETE",
          55072,
        )
      ).status,
    ).toBe(404);
    const revoked = await request(
      "/customer-auth/api-keys/" + issued.apiKey.id,
      ownerToken,
      undefined,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect(
      ((await revoked.json()) as { revokedAt: string }).revokedAt,
    ).toBeTruthy();
    expect((await external("/ext/customer-auth/v1/guests")).status).toBe(401);
    expect(
      (
        await external(
          "/ext/customer-auth/v1/login",
          issued.secret,
          { loginId: first.loginId, password: guestPassword },
          "POST",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/customer-auth/guests/" + second.id,
          foreignToken,
          undefined,
          "DELETE",
          55072,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          "/customer-auth/guests/" + second.id,
          ownerToken,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    expect(
      (await request("/customer-auth/guests/" + second.id, readerToken)).status,
    ).toBe(404);
  });
  it("reports actual DB outage separately and keeps compiled logs free of secrets", async () => {
    const key = await newKey();
    await execute("docker", ["stop", container]);
    const failed = await external(
      "/ext/customer-auth/v1/login",
      key.secret,
      { loginId: first.loginId, password: guestPassword },
      "POST",
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: "unavailable",
      message: "Service unavailable.",
    });
    const text = logs.join("\n");
    for (const secret of rt.secretValues) expect(text).not.toContain(secret);
    expect(text).not.toContain("password_hash");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });
});
