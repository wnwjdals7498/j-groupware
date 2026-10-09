import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  rm,
  readFile,
  chmod,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createConnection, createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { request as httpsRequest } from "node:https";
import { Pool } from "pg";
import { createLocalJWKSet, jwtVerify, decodeJwt } from "jose";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { Browser, integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { customerBrowser } from "./customer-browser.js";
import { OidcClient } from "../../apps/server/src/oidc.js";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { digest } from "../../apps/server/src/security.js";
import { PostgresServiceDatabase } from "../../deploy/agent/service-database.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";
import { createApp as createBffApp } from "../../apps/server/src/app.js";
import { ProductEnvironment } from "../../deploy/agent/product-environment.mjs";
import {
  ProductReadiness,
  ServiceInventory,
} from "../../deploy/agent/product-readiness.mjs";
import { ServiceStateFiles } from "../../deploy/agent/service-lifecycle.mjs";
import { buildProductBundle } from "../../deploy/agent/build-product-bundle.mjs";
import { BundleInstaller } from "../../deploy/agent/bundle-install.mjs";
import { ServiceEnvironment } from "../../deploy/agent/service-environment.mjs";
import { ProductGateway } from "../../deploy/agent/product-gateway.mjs";
import { createApp } from "../../../j-customer-auth-db/apps/server/dist/app.js";
import { GuestSigner } from "../../../j-customer-auth-db/apps/server/dist/security.js";
import { PageCursor } from "../../../j-customer-auth-db/apps/server/dist/security.js";
import { CustomerStore } from "../../../j-customer-auth-db/apps/server/dist/store.js";
import { migrate } from "../../../j-customer-auth-db/apps/server/dist/db/migrate.js";
import { createApp as createTalkApp } from "../../../j-talk/apps/server/dist/app.js";
import { migrate as migrateTalk } from "../../../j-talk/apps/server/dist/db/migrate.js";
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
    db: PostgresServiceDatabase,
    talkPool: Pool;
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
    foreignBrowser: Browser,
    talkOnlyBrowser: Browser;
  let malformedMode = "extra";
  const container = "jcadb-integration-" + randomUUID().slice(0, 8),
    password = randomBytes(32).toString("base64url"),
    guestPassword = "permanent-guest-fixture-7498",
    dbPassword = randomBytes(32).toString("base64url"),
    talkDbPassword = randomBytes(32).toString("base64url");
  const children: ReturnType<typeof spawn>[] = [],
    customerEnvironments: NodeJS.ProcessEnv[] = [],
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
    for (const port of [55070, 55071, 55072, 55073, 55076, 55078, 55080, 55081])
      await free(port);
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
        "j-talk": `https://127.0.0.1:${55080 + index}`,
      }),
    });
    rt.secretValues.add(guestPassword);
    rt.secretValues.add(dbPassword);
    rt.secretValues.add(talkDbPassword);
    for (const [index] of rt.fixtures.entries()) {
      expect((await rt.subscribe(index, "j-customer-auth-db")).status).toBe(
        200,
      );
      expect((await rt.subscribe(index, "j-talk")).status).toBe(200);
    }
    db = new PostgresServiceDatabase({
      admin,
      tenant: rt.fixtures[0]!.tenant,
      connection: () => ({ host: "127.0.0.1", port: 55070 }),
      dumpBinary: "/workspace/.cloud-setup/pg18/bin/pg_dump",
    });
    await db.prepareBase();
    await db.ensure("j-customer-auth-db", dbPassword);
    await db.ensure("j-talk", talkDbPassword);
    talkPool = new Pool({
      host: "127.0.0.1",
      port: 55070,
      database: "jgw_talk",
      user: "jgw_talk",
      password: talkDbPassword,
      connectionTimeoutMillis: 1000,
      statement_timeout: 5000,
    });
    talkPool.on("error", () => {});
    await migrateTalk(talkPool);
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
    await execute("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      root + "/server.key",
      "-out",
      root + "/server.csr",
      "-subj",
      "/CN=Customer Fixture",
    ]);
    await chmod(root + "/server.key", 0o600);
    await writeFile(
      root + "/server.ext",
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:127.0.0.1,DNS:localhost," +
        rt.fixtures.map((f) => "DNS:" + new URL(f.origin).hostname).join(",") +
        "\n",
      { mode: 0o600 },
    );
    await execute("openssl", [
      "x509",
      "-req",
      "-in",
      root + "/server.csr",
      "-CA",
      caFile,
      "-CAkey",
      process.env.JAUTH_TLS_KEY!,
      "-set_serial",
      "0x" + randomBytes(16).toString("hex"),
      "-out",
      root + "/server.crt",
      "-days",
      "1",
      "-extfile",
      root + "/server.ext",
    ]);
    for (const [index, fixture] of rt.fixtures.entries()) {
      const talk = createTalkApp({
        pool: talkPool,
        tenant: fixture.tenant,
        keycloakOrigin: process.env.KC_PUBLIC_URL!,
        fetch: rt.fetch,
        https: {
          cert: await readFile(root + "/server.crt"),
          key: await readFile(root + "/server.key"),
          minVersion: "TLSv1.2",
        },
      });
      servers.push(talk);
      await talk.listen({ host: "127.0.0.1", port: 55080 + index });
      const customerEnv = {
          ...process.env,
          JCADB_TENANT: fixture.tenant,
          JCADB_PUBLIC_ORIGIN: fixture.origin,
          JCADB_PORT: String(55071 + index),
          JCADB_DB_PORT: "55070",
          JCADB_DB_PASSWORD: dbPassword,
          JCADB_TLS_CERTIFICATE: root + "/server.crt",
          JCADB_TLS_KEY: root + "/server.key",
          JCADB_CA_CERTIFICATE: caFile,
          JCADB_GUEST_SIGNING_KEY: root + "/signing.key",
          JCADB_CURSOR_SIGNING_KEY: randomBytes(32).toString("base64url"),
        },
        child = spawn(
          process.execPath,
          [
            "--import",
            "./tests/bff/resolve-customer-auth-test-hosts.mjs",
            "../j-customer-auth-db/apps/server/dist/main.js",
          ],
          {
            cwd: "/workspace/j-groupware",
            env: customerEnv,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
          },
        );
      customerEnvironments.push(customerEnv);
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
      ["guest-reader", ["guest:read", "talk:read"]],
      ["guest-denied", []],
      ["guest-writer", ["guest:write"]],
      ["talk-only", ["talk:read"]],
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
      } else if (name === "guest-writer") writerBrowser = browser;
      else talkOnlyBrowser = browser;
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
    await talkPool?.end();
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
    for (const invalid of [
      { name: 123 },
      { loginId: 123456 },
      { password: 123456789012 },
    ])
      expect(
        (
          await ownerBrowser.change("/api/customer-auth/guests", {
            ...input,
            ...invalid,
          })
        ).status,
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
    for (const input of [
      { name: 123, scopes: ["guest:read"] },
      { name: "invalid", scopes: "guest:read" },
    ])
      expect(
        (await writerBrowser.change("/api/customer-auth/api-keys", input))
          .status,
      ).toBe(400);
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
  it("composes room names through real customer-auth only with guest:read and deduplicates page lookups", async () => {
    const fixture = rt.fixtures[0]!,
      created = await ownerBrowser.change("/api/customer-auth/guests", {
        name: "상담 손님",
        loginId: "talk-name-fixture",
        contact: "private contact",
        password: guestPassword,
      }),
      foreignCreated = await foreignBrowser.change(
        "/api/customer-auth/guests",
        {
          name: "다른 고객 손님",
          loginId: "foreign-talk-name",
          password: guestPassword,
        },
      );
    expect(created.status).toBe(201);
    expect(foreignCreated.status).toBe(201);
    const guest = (await created.json()) as Guest,
      foreignGuest = (await foreignCreated.json()) as Guest,
      guests = [guest.id, guest.id, null, foreignGuest.id],
      rooms: string[] = [];
    try {
      for (const guestId of guests) {
        const visitor = randomUUID(),
          room = randomUUID();
        await talkPool.query(
          "INSERT INTO visitors(tenant_id,id,guest_id) VALUES ($1,$2,$3)",
          [fixture.tenant, visitor, guestId],
        );
        await talkPool.query(
          "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
          [fixture.tenant, room, visitor],
        );
        rooms.push(room);
      }
      const before = rt.serviceCalls.length,
        response = await readerBrowser.request(
          "/api/talk/rooms?status=waiting&limit=100",
        );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: {
          id: string;
          guestId: string | null;
          guestName: string | null;
        }[];
      };
      expect(page.items).toHaveLength(4);
      for (const [index, room] of rooms.entries())
        expect(page.items.find((item) => item.id === room)).toMatchObject({
          guestId: guests[index],
          guestName: index < 2 ? guest.name : null,
        });
      const lookups = rt.serviceCalls
        .slice(before)
        .filter((call) => call.path.startsWith("/customer-auth/guests/"));
      expect(lookups.map((call) => call.path).sort()).toEqual(
        [guest.id, foreignGuest.id]
          .map((id) => "/customer-auth/guests/" + id)
          .sort(),
      );
      const detail = await readerBrowser.request("/api/talk/rooms/" + rooms[0]);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toEqual({
        id: rooms[0],
        status: "waiting",
        assignedMemberId: null,
        guestId: guest.id,
        guestName: guest.name,
      });
      const noRoleStart = rt.serviceCalls.length;
      for (const path of [
        "/api/talk/rooms?limit=100",
        "/api/talk/rooms/" + rooms[0],
      ]) {
        const result = await talkOnlyBrowser.request(path);
        expect(result.status).toBe(200);
        const text = await result.text();
        expect(text).toContain(guest.id);
        expect(text).not.toContain("guestName");
        expect(text).not.toContain(guest.name);
        expect(text).not.toContain(guest.contact);
      }
      expect(
        rt.serviceCalls
          .slice(noRoleStart)
          .filter((call) => call.path.startsWith("/customer-auth/")),
      ).toEqual([]);
      const cookie = talkOnlyBrowser.cookies
        .get(new URL(fixture.origin).origin)!
        .get(SESSION_POLICY.cookie)!;
      expect(
        (
          await rt.pool.query(
            "SELECT 1 FROM service_tokens WHERE tenant_id=$1 AND session_hash=$2 AND service_id='j-customer-auth-db'",
            [fixture.tenant, digest(cookie)],
          )
        ).rowCount,
      ).toBe(0);
      expect((await deniedBrowser.request("/api/talk/rooms")).status).toBe(403);
      expect(
        (await foreignBrowser.request("/api/talk/rooms/" + rooms[0])).status,
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
      const stale = await readerBrowser.request("/api/talk/rooms/" + rooms[0]);
      expect(stale.status).toBe(200);
      expect(await stale.json()).toMatchObject({
        guestId: guest.id,
        guestName: null,
      });
    } finally {
      // Seeded rooms now own occurrence rows; preserve the production FK rules.
      await talkPool.query("DELETE FROM event_outbox WHERE tenant_id=$1", [
        fixture.tenant,
      ]);
      await talkPool.query("DELETE FROM rooms WHERE tenant_id=$1", [
        fixture.tenant,
      ]);
      await talkPool.query("DELETE FROM visitors WHERE tenant_id=$1", [
        fixture.tenant,
      ]);
      await ownerBrowser.change(
        "/api/customer-auth/guests/" + guest.id,
        undefined,
        "DELETE",
      );
      await foreignBrowser.change(
        "/api/customer-auth/guests/" + foreignGuest.id,
        undefined,
        "DELETE",
      );
    }
  });
  it("rejects malformed stored guest identifiers before lookup", async () => {
    const fixture = rt.fixtures[0]!,
      visitor = randomUUID(),
      room = randomUUID();
    await talkPool.query(
      "INSERT INTO visitors(tenant_id,id,guest_id) VALUES ($1,$2,$3)",
      [fixture.tenant, visitor, "../api-keys?private=fixture"],
    );
    await talkPool.query(
      "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
      [fixture.tenant, room, visitor],
    );
    try {
      const before = rt.serviceCalls.length,
        deniedLookup = await readerBrowser.request("/api/talk/rooms/" + room);
      expect(deniedLookup.status).toBe(503);
      expect(await deniedLookup.text()).not.toContain("private=fixture");
      expect(
        (await talkOnlyBrowser.request("/api/talk/rooms/" + room)).status,
      ).toBe(503);
      expect(
        rt.serviceCalls
          .slice(before)
          .filter((call) => call.path.startsWith("/customer-auth/")),
      ).toEqual([]);
    } finally {
      await talkPool.query(
        "DELETE FROM event_outbox WHERE tenant_id=$1 AND room_id=$2",
        [fixture.tenant, room],
      );
      await talkPool.query("DELETE FROM rooms WHERE tenant_id=$1 AND id=$2", [
        fixture.tenant,
        room,
      ]);
      await talkPool.query(
        "DELETE FROM visitors WHERE tenant_id=$1 AND id=$2",
        [fixture.tenant, visitor],
      );
    }
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
  it("installs and boots the seventh cold bundle with real customer profile, persisted secrets, native Argon2 and TLS readiness", async () => {
    const service = "j-customer-auth-db",
      fixture = rt.fixtures[0]!;
    const output = root + "/customer-auth.tar.gz",
      base = {
        npmConfig: "/workspace/.suite-runtime/j-groupware/registry/user.npmrc",
        cache: "/workspace/.cloud-setup/cache/npm",
        npmCli:
          "/workspace/.cloud-setup/node22/lib/node_modules/npm/bin/npm-cli.js",
      };
    const bundle = await buildProductBundle({
      ...base,
      service,
      sourceRoot: "/workspace/" + service,
      output,
    });
    await mkdir(root + "/runtime", { mode: 0o755 });
    await chmod(root + "/runtime", 0o755);
    const installer = new BundleInstaller({ ...base, root: root + "/runtime" });
    const installation = { service, archive: output, digest: bundle.sha256 };
    expect((await installer.install(installation)).changed).toBe(true);
    expect((await installer.install(installation)).changed).toBe(false);
    expect(
      await readFile(
        root + "/runtime/" + service + "/packages/contracts/dist/index.js",
      ),
    ).toEqual(
      await readFile(
        "/workspace/j-groupware/node_modules/@j-customer-auth-db/contracts/dist/index.js",
      ),
    );
    const profile = {
      port: 55078,
      certificate: root + "/server.crt",
      key: root + "/server.key",
      ca: process.env.JAUTH_TLS_CERTIFICATE!,
      publicOrigin: fixture.origin,
      guestSigningKey: root + "/signing.key",
    };
    const options = {
      tenant: fixture.tenant,
      databasePort: 55070,
      keycloakOrigin: process.env.KC_PUBLIC_URL!,
      profiles: { [service]: profile },
    };
    const adapter = new ProductEnvironment(options);
    expect(
      () =>
        new ProductEnvironment({
          ...options,
          profiles: {
            [service]: { ...profile, publicOrigin: rt.fixtures[1]!.origin },
          },
        }),
    ).toThrow();
    const environment = new ServiceEnvironment({
      root: root + "/product-env",
      backups: root + "/product-backups",
      render: adapter.render.bind(adapter),
      read: adapter.read.bind(adapter),
    });
    const secrets = await environment.prepare(service, () => ({
      databasePassword: dbPassword,
      notificationKey: randomBytes(32).toString("base64url"),
      cursorSigningKey: randomBytes(32).toString("base64url"),
    }));
    expect(
      await environment.prepare(service, () => {
        throw new Error("Existing secrets must not be reissued.");
      }),
    ).toEqual(secrets);
    rt.secretValues.add(secrets.cursorSigningKey!);
    rt.secretValues.add(secrets.notificationKey);
    // Isolated auth.jgw.test has no host DNS entry; this native-only test
    // resolver is external to the cold bundle and adds no package fallback.
    await writeFile(
      root + "/test-hosts.mjs",
      await readFile("tests/bff/resolve-customer-auth-test-hosts.mjs"),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      ["--import", root + "/test-hosts.mjs", "apps/server/dist/main.js"],
      {
        cwd: root + "/runtime/" + service,
        env: {
          ...adapter.variables(service, secrets),
          JGW_TEST_RUNTIME: "isolated-cloud",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    child.stdout?.on("data", (value) => logs.push(String(value)));
    child.stderr?.on("data", (value) => logs.push(String(value)));
    const readiness = new ProductReadiness({
      environment: adapter,
      timeout: 1000,
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw new Error("Cold customer process stopped before readiness.");
      if (await readiness.probe(service)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ready).toBe(true);
    const wrongCa = new ProductEnvironment({
      ...options,
      profiles: {
        [service]: { ...profile, ca: process.env.JGW_TLS_CERTIFICATE! },
      },
    });
    expect(
      await new ProductReadiness({ environment: wrongCa, timeout: 1000 }).probe(
        service,
      ),
    ).toBe(false);
    expect(
      (
        await request(
          "/customer-auth/guests/" + first.id,
          ownerToken,
          undefined,
          "GET",
          55078,
        )
      ).status,
    ).toBe(200);
    const key = await newKey();
    const login = await rt.fetchLoopback(
      "https://127.0.0.1:55078/ext/customer-auth/v1/login",
      {
        method: "POST",
        headers: {
          "X-JCADB-API-Key": key.secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          loginId: first.loginId,
          password: guestPassword,
        }),
      },
    );
    expect(login.status).toBe(200);
    const jwt = (await login.json()) as GuestLoginResult;
    rt.secretValues.add(jwt.accessToken);
    expect(
      (
        await jwtVerify(jwt.accessToken, createLocalJWKSet(signer.jwks), {
          issuer: fixture.origin + "/ext/customer-auth",
          audience: "j-customer-auth-db-guest",
          algorithms: ["RS256"],
        })
      ).payload.sub,
    ).toBe(first.id);
    const state = new ServiceStateFiles(root + "/inventory", fixture.tenant);
    await state.write(service, { status: "active", phase: "active" });
    const inventory = new ServiceInventory({
      tenant: fixture.tenant,
      state,
      readiness,
    });
    expect(await inventory.read()).toEqual({
      tenant: fixture.tenant,
      installed: [service],
      incomplete: [],
    });
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await exit;
    expect(child.exitCode).toBe(0);
    expect(await inventory.read()).toEqual({
      tenant: fixture.tenant,
      installed: [],
      incomplete: [service],
    });
  }, 120000);
  it("publishes actual customer HTTPS through Nginx and withdraws it while keeping the BFF management boundary", async () => {
    const fixture = rt.fixtures[0]!,
      gatewayRoot = root + "/gateway",
      gatewayContainer = "jcadb-gateway-" + randomUUID().slice(0, 8),
      image =
        "nginx@sha256:9bf97bd7714f5e24c1ccd545ecb9eb5435cb6d109c97cebb15e7e455e0239edb",
      sockets = new Set<Socket>();
    for (const port of [54233, 55075, 55077]) await free(port);
    await mkdir(gatewayRoot, { mode: 0o700 });
    for (const [name, source] of [
      ["certificate.pem", process.env.JGW_TLS_CERTIFICATE!],
      ["key.pem", process.env.JGW_TLS_KEY!],
    ])
      await writeFile(gatewayRoot + "/" + name, await readFile(source!), {
        mode: 0o600,
      });
    await writeFile(
      gatewayRoot + "/upstream-ca.pem",
      (await readFile(process.env.JAUTH_TLS_CERTIFICATE!, "utf8")) +
        "\n" +
        (await readFile(process.env.JGW_TLS_CERTIFICATE!, "utf8")),
      { mode: 0o600 },
    );
    // The real BFF binds the isolated bridge address. This transparent TCP
    // relay changes only its address; both Nginx TLS verification and member
    // authentication still reach the actual BFF and customer server.
    const relay = createTcpServer((client) => {
      const upstream = createConnection({
        host: process.env.JGW_TEST_BIND_IP!,
        port: 54233,
      });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    let running = false;
    const identity = ["--user", `${process.getuid!()}:${process.getgid!()}`],
      dockerRun = [
        "run",
        "--network",
        "host",
        "--read-only",
        ...identity,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        `type=bind,source=${gatewayRoot},target=${gatewayRoot}`,
        "--entrypoint",
        "/usr/sbin/nginx",
      ];
    try {
      await new Promise<void>((resolve, reject) => {
        relay.once("error", reject);
        relay.listen(55077, "127.0.0.1", resolve);
      });
      const state = new ServiceStateFiles(
          root + "/gateway-state",
          fixture.tenant,
        ),
        gateway = new ProductGateway({
          root: gatewayRoot,
          state,
          profile: {
            JGW_TENANT: fixture.tenant,
            JGW_GATEWAY_ALLOWED_TENANTS: fixture.tenant,
            JGW_GATEWAY_SERVICES: "",
            JGW_GATEWAY_BIND: "127.0.0.1",
            JGW_GATEWAY_HTTP_PORT: "55075",
            JGW_GATEWAY_HTTPS_PORT: "54233",
            JGW_PORT: "55077",
            JCADB_INTERNAL_PORT: "55071",
            JCADB_INTERNAL_PROTOCOL: "https",
            JGW_TLS_CERTIFICATE: gatewayRoot + "/certificate.pem",
            JGW_TLS_KEY: gatewayRoot + "/key.pem",
            JGW_GATEWAY_UPSTREAM_CA: gatewayRoot + "/upstream-ca.pem",
            JGW_EXT_RATE: "1000",
            JGW_EXT_BURST: "1000",
          },
          commands: {
            validate: () =>
              execute(
                "docker",
                running
                  ? [
                      "exec",
                      gatewayContainer,
                      "nginx",
                      "-t",
                      "-c",
                      gatewayRoot + "/nginx.conf",
                    ]
                  : [
                      ...dockerRun,
                      "--rm",
                      image,
                      "-t",
                      "-c",
                      gatewayRoot + "/nginx.conf",
                    ],
              ),
            reload: async () => {
              if (running)
                return execute("docker", [
                  "exec",
                  gatewayContainer,
                  "nginx",
                  "-s",
                  "reload",
                  "-c",
                  gatewayRoot + "/nginx.conf",
                ]);
              await execute("docker", [
                ...dockerRun,
                "-d",
                "--name",
                gatewayContainer,
                image,
                "-c",
                gatewayRoot + "/nginx.conf",
                "-g",
                "daemon off;",
              ]);
              running = true;
            },
          },
          substitute: (input, variables) =>
            execute(
              "docker",
              [
                "run",
                "-i",
                "--rm",
                "--network",
                "none",
                "--read-only",
                ...identity,
                ...Object.entries(variables).flatMap(([key, value]) => [
                  "--env",
                  `${key}=${value}`,
                ]),
                "--entrypoint",
                "/usr/bin/envsubst",
                image,
                Object.keys(variables)
                  .map((key) => "$" + key)
                  .join(" "),
              ],
              { input },
            ),
        });
      expect(await gateway.set("j-customer-auth-db", true)).toEqual({
        changed: true,
        reloaded: true,
      });
      const browser = new Browser(rt.fetchLoopback, fixture.origin);
      browser.cookies.set(
        fixture.origin,
        new Map(ownerBrowser.cookies.get(fixture.origin)!),
      );
      expect(
        (await browser.request("/api/customer-auth/guests/" + first.id)).status,
      ).toBe(200);
      const keyResponse = await browser.change("/api/customer-auth/api-keys", {
        name: "gateway-site",
        scopes: ["guest:read"],
      });
      expect(keyResponse.status).toBe(201);
      const key = (await keyResponse.json()) as IssuedApiKey;
      rt.secretValues.add(key.secret);
      const headers = {
        "X-JCADB-API-Key": key.secret,
        "Content-Type": "application/json",
      };
      const jwksResponse = await rt.fetchLoopback(
        fixture.origin + "/ext/customer-auth/v1/jwks",
      );
      expect(jwksResponse.status).toBe(200);
      const login = await rt.fetchLoopback(
        fixture.origin + "/ext/customer-auth/v1/login",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            loginId: first.loginId,
            password: guestPassword,
          }),
        },
      );
      expect(login.status).toBe(200);
      const jwt = (await login.json()) as GuestLoginResult;
      rt.secretValues.add(jwt.accessToken);
      expect(
        (
          await jwtVerify(
            jwt.accessToken,
            createLocalJWKSet(
              (await jwksResponse.json()) as Parameters<
                typeof createLocalJWKSet
              >[0],
            ),
            {
              issuer: fixture.origin + "/ext/customer-auth",
              audience: "j-customer-auth-db-guest",
              algorithms: ["RS256"],
            },
          )
        ).payload.sub,
      ).toBe(first.id);
      expect(
        (
          await rt.fetchLoopback(
            fixture.origin + "/ext/customer-auth/v1/guests",
            { headers },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await rt.fetchLoopback(fixture.origin + "/customer-auth/guests", {
            headers: { Authorization: "Bearer " + ownerToken },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await rt.fetchLoopback(
            fixture.origin + "/ext/customer-auth/v1/guests",
            { method: "POST", headers, body: "{}" },
          )
        ).status,
      ).toBe(404);
      expect(await gateway.set("j-customer-auth-db", false)).toEqual({
        changed: true,
        reloaded: true,
      });
      // Nginx drains the previous worker's established keepalive connection.
      // Require the same actual client to observe withdrawal within a bound,
      // in addition to ProductGateway's new-worker revision confirmation.
      let withdrawn = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const response = await rt.fetchLoopback(
          fixture.origin + "/ext/customer-auth/v1/guests",
          { headers, signal: AbortSignal.timeout(1000) },
        );
        await response.body?.cancel();
        if (response.status === 404) {
          withdrawn = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(withdrawn).toBe(true);
      expect(
        (await browser.request("/api/customer-auth/guests/" + first.id)).status,
      ).toBe(200);
      for (const secret of [key.secret, jwt.accessToken, guestPassword])
        expect(
          await readFile(gatewayRoot + "/access.log", "utf8"),
        ).not.toContain(secret);
    } finally {
      if (running) await execute("docker", ["rm", "-f", gatewayContainer]);
      for (const socket of sockets) socket.destroy();
      if (relay.listening)
        await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  }, 120000);
  it("loads the published contracts and customer endpoint in the actual compiled BFF", async () => {
    const child = await rt.startCompiled();
    try {
      const fixture = rt.fixtures[0]!,
        browser = new Browser(rt.fetchLoopback, fixture.origin);
      browser.cookies.set(
        fixture.origin,
        new Map(ownerBrowser.cookies.get(fixture.origin)!),
      );
      const invalid = await browser.change("/api/customer-auth/guests", {
        name: "compiled",
        loginId: "compiled-relay",
        password: 123456789012,
      });
      expect(invalid.status).toBe(400);
      const created = await browser.change("/api/customer-auth/guests", {
        name: "compiled",
        loginId: "compiled-relay",
        password: guestPassword,
      });
      expect(created.status).toBe(201);
      const guest = (await created.json()) as Guest;
      expect(
        (await browser.request("/api/customer-auth/guests/" + guest.id)).status,
      ).toBe(200);
      expect(
        (
          await browser.change(
            "/api/customer-auth/guests/" + guest.id,
            { name: "updated" },
            "PATCH",
          )
        ).status,
      ).toBe(200);
      const keyResponse = await browser.change("/api/customer-auth/api-keys", {
        name: "compiled",
        scopes: ["guest:read"],
      });
      expect(keyResponse.status).toBe(201);
      const key = (await keyResponse.json()) as IssuedApiKey;
      rt.secretValues.add(key.secret);
      expect(
        (
          await browser.change(
            "/api/customer-auth/api-keys/" + key.apiKey.id,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(200);
      expect(
        (await external("/ext/customer-auth/v1/guests", key.secret)).status,
      ).toBe(401);
      expect(
        (
          await browser.change(
            "/api/customer-auth/guests/" + guest.id,
            undefined,
            "DELETE",
          )
        ).status,
      ).toBe(204);
    } finally {
      await rt.stop(child);
    }
  });
  it("fails name composition on actual customer-auth outage while keeping identifier-only Talk available", async () => {
    const fixture = rt.fixtures[0]!,
      visitor = randomUUID(),
      room = randomUUID(),
      guestId = randomUUID(),
      primary = children[0]!;
    await talkPool.query(
      "INSERT INTO visitors(tenant_id,id,guest_id) VALUES ($1,$2,$3)",
      [fixture.tenant, visitor, guestId],
    );
    await talkPool.query(
      "INSERT INTO rooms(tenant_id,id,visitor_id) VALUES ($1,$2,$3)",
      [fixture.tenant, room, visitor],
    );
    const closed = once(primary, "close");
    primary.kill("SIGTERM");
    const stopTimer = setTimeout(() => primary.kill("SIGKILL"), 5000);
    stopTimer.unref();
    await closed;
    clearTimeout(stopTimer);
    try {
      const failed = await readerBrowser.request("/api/talk/rooms/" + room);
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain(guestId);
      const available = await talkOnlyBrowser.request(
        "/api/talk/rooms/" + room,
      );
      expect(available.status).toBe(200);
      expect(await available.json()).toEqual({
        id: room,
        status: "waiting",
        assignedMemberId: null,
        guestId,
      });
    } finally {
      await free(55071);
      const restarted = spawn(process.execPath, primary.spawnargs.slice(1), {
        cwd: "/workspace/j-groupware",
        env: customerEnvironments[0],
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      children.push(restarted);
      restarted.stdout?.on("data", (b) => logs.push(String(b)));
      restarted.stderr?.on("data", (b) => logs.push(String(b)));
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (restarted.exitCode !== null)
          throw new Error("Owned customer fixture restart failed.");
        try {
          const result = await rt.fetchLoopback(
            "https://127.0.0.1:55071/health/ready",
            { signal: AbortSignal.timeout(300) },
          );
          ready = result.ok;
          await result.body?.cancel();
          if (ready) break;
        } catch {
          /* bounded actual startup */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      await talkPool.query(
        "DELETE FROM event_outbox WHERE tenant_id=$1 AND room_id=$2",
        [fixture.tenant, room],
      );
      await talkPool.query("DELETE FROM rooms WHERE tenant_id=$1 AND id=$2", [
        fixture.tenant,
        room,
      ]);
      await talkPool.query(
        "DELETE FROM visitors WHERE tenant_id=$1 AND id=$2",
        [fixture.tenant, visitor],
      );
    }
  });
  it("creates and edits a guest, displays an API key once and confirms revocation through the real business screens", async () => {
    const ui = await customerBrowser(rt, ownerBrowser);
    try {
      await ui.page.goto(ui.origin + "/guests");
      const form = ui.page.getByRole("form", { name: "손님 등록" });
      await form.getByLabel("손님 이름").fill("화면 손님");
      await form.getByLabel("로그인 ID").fill("browser-guest");
      await form.getByLabel("연락처").fill("public-display");
      await form.getByLabel("손님 비밀번호").fill(guestPassword);
      await form
        .getByRole("button", { name: "손님 등록", exact: true })
        .click();
      await ui.page
        .getByRole("button", { name: "수정 화면 손님", exact: true })
        .click();
      const editing = ui.page.getByRole("dialog", { name: "손님 수정" });
      await editing.getByLabel("손님 이름").fill("수정된 화면 손님");
      await editing
        .getByRole("button", { name: "수정 저장", exact: true })
        .click();
      await ui.page
        .getByRole("button", { name: "수정 수정된 화면 손님", exact: true })
        .waitFor();
      const keyForm = ui.page.getByRole("form", { name: "API 키 발급" });
      await keyForm.getByLabel("API 키 이름").fill("브라우저 키");
      await keyForm
        .getByRole("button", { name: "키 발급", exact: true })
        .click();
      const secretDialog = ui.page.getByRole("dialog", {
        name: "발급된 API 키",
      });
      await secretDialog.waitFor();
      const secret = await secretDialog.locator("pre").textContent();
      expect(typeof secret).toBe("string");
      if (secret) rt.secretValues.add(secret);
      await secretDialog
        .getByRole("button", { name: "보관 완료", exact: true })
        .click();
      expect(
        await ui.page.getByRole("dialog", { name: "발급된 API 키" }).count(),
      ).toBe(0);
      const storage = await ui.page.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
      }));
      expect(storage).toEqual({ local: 0, session: 0 });
      await ui.page
        .getByRole("button", { name: "회수 브라우저 키", exact: true })
        .click();
      await ui.page
        .getByRole("dialog", { name: "API 키 회수 확인" })
        .getByRole("button", { name: "확인", exact: true })
        .click();
      await ui.page
        .getByRole("row")
        .filter({ hasText: "브라우저 키" })
        .getByText("회수됨", { exact: true })
        .waitFor();
      await ui.page.reload();
      expect(
        await ui.page
          .locator("body")
          .textContent()
          .then((text) => !!secret && text?.includes(secret)),
      ).toBe(false);
      expect(ui.pageErrors).toEqual([]);
    } finally {
      await ui.close();
    }
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
