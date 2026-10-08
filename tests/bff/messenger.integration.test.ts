import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { decodeJwt } from "jose";
import { SESSION_POLICY } from "@j-groupware/contracts";
import {
  Browser,
  integrationRuntime,
  required,
  type Runtime,
} from "./runtime.js";
import { OidcClient } from "../../apps/server/src/oidc.js";
import { digest } from "../../apps/server/src/security.js";
import { createApplication } from "../../../j-messenger/apps/server/dist/bootstrap/application.js";
import { loadConfig } from "../../../j-messenger/apps/server/dist/platform/config/index.js";

describe("actual messenger j-auth HTTP/WSS + BFF relay (SQLite foundation; PostgreSQL pending)", () => {
  let rt: Runtime, root: string, ca: Buffer[];
  let conversationId: string;
  const apps: Awaited<ReturnType<typeof createApplication>>[] = [],
    browsers: Browser[] = [],
    tokens: string[] = [],
    sources: string[] = [],
    logs: string[] = [],
    sockets = new Set<WebSocket>();
  const origins = [54250, 54251].map((port) => `https://127.0.0.1:${port}`);
  const me: { id: string; serverId: string }[] = [];
  let second: Browser,
    noRole: Browser,
    secondToken: string,
    noRoleToken: string;
  const logger: NonNullable<
    NonNullable<Parameters<typeof createApplication>[1]>["logger"]
  > = {
    emit(event) {
      logs.push(JSON.stringify(event));
    },
    afterCommit(tx, event) {
      tx.afterCommit(() => {
        logs.push(JSON.stringify(event));
      });
    },
  };
  const boot = async (index: number) => {
    const config = loadConfig(
      {
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: String(54250 + index),
        PUBLIC_ORIGIN: origins[index]!,
        AUTH_MODE: "j-auth",
        JAUTH_TENANT: rt.fixtures[index]!.tenant,
        KC_PUBLIC_URL: rt.fixtures[index]!.config.keycloakOrigin,
        DB_PATH: root + "/messenger.sqlite",
        TLS_CERT_PATH: required("JGW_TLS_CERTIFICATE"),
        TLS_KEY_PATH: required("JGW_TLS_KEY"),
      },
      root,
    );
    const app = await createApplication(config, {
      authFetch: rt.fetchLoopback,
      logger,
      maintenance: false,
    });
    await app.app.listen({ host: "127.0.0.1", port: 54250 + index });
    return app;
  };
  const exchanged = async (b: Browser, index = 0, audience = "j-messenger") => {
    const cookie = b.cookies.get(b.origin)!.get(SESSION_POLICY.cookie)!;
    const row = (
      await rt.pool.query<{ access_token: string }>(
        "SELECT access_token FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
        [rt.fixtures[index]!.tenant, digest(cookie)],
      )
    ).rows[0]!;
    rt.secretValues.add(row.access_token);
    const token = await new OidcClient(rt.fixtures[index]!.config, {
      fetch: rt.fetchLoopback,
    }).serviceToken(row.access_token, audience);
    rt.secretValues.add(token);
    return { token, source: row.access_token };
  };
  const request = (
    token: string | undefined,
    path = "/api/v1/me",
    index = 0,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    headers: Record<string, string> = {},
  ) =>
    rt.fetchLoopback(origins[index]! + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const wire = (url: string, headers: Record<string, string>, bff = false) => {
    const socket = new WebSocket(url, {
      ca,
      lookup: (_host, options, callback) => {
        const address = bff ? required("JGW_TEST_BIND_IP") : "127.0.0.1";
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
      headers,
      perMessageDeflate: false,
    });
    sockets.add(socket);
    const queue: string[] = [],
      waiters: Array<(value: string) => void> = [];
    socket.on("message", (value) => {
      const text = value.toString(),
        waiter = waiters.shift();
      if (waiter) waiter(text);
      else queue.push(text);
    });
    const ended = new Promise<number>((resolve) =>
      socket.once("close", (code) => {
        sockets.delete(socket);
        resolve(code);
      }),
    );
    const opened = new Promise<number>((resolve) => {
      socket.once("open", () => resolve(101));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode!);
        socket.terminate();
      });
      socket.once("error", () => resolve(0));
    });
    socket.on("error", () => undefined);
    const next = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(JSON.parse(queued) as Record<string, unknown>);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("Actual messenger frame timeout.")),
          5000,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(JSON.parse(value) as Record<string, unknown>);
        });
      });
    return { socket, opened, ended, next };
  };
  const direct = (
    token: string,
    index = 0,
    query = "",
    headers: Record<string, string> = {},
  ) =>
    wire(origins[index]!.replace("https:", "wss:") + "/api/v1/events" + query, {
      Authorization: "Bearer " + token,
      ...headers,
    });
  const relayed = (b: Browser) =>
    wire(
      b.origin.replace("https:", "wss:") + "/api/messenger/ws",
      {
        Origin: b.origin,
        Cookie:
          SESSION_POLICY.cookie +
          "=" +
          b.cookies.get(b.origin)!.get(SESSION_POLICY.cookie)!,
      },
      true,
    );
  const userCount = () =>
    Number(
      (
        apps[0]!.db.prepare("SELECT count(*) AS n FROM users").get() as {
          n: bigint;
        }
      ).n,
    );
  beforeAll(async () => {
    await mkdir("/workspace/.suite-runtime/j-messenger", { recursive: true });
    root = await mkdtemp("/workspace/.suite-runtime/j-messenger/auth-");
    rt = await integrationRuntime({
      serviceEndpointsForTenant: (_tenant, i) => ({
        "j-messenger": `https://127.0.0.1:${54250 + i}`,
      }),
    });
    ca = await Promise.all(
      ["JAUTH_TLS_CERTIFICATE", "JGW_TLS_CERTIFICATE"].map((key) =>
        readFile(required(key)),
      ),
    );
    for (let i = 0; i < 2; i++) {
      expect((await rt.subscribe(i, "j-messenger")).status).toBe(200);
      const b = new Browser(rt.fetch, rt.fixtures[i]!.origin);
      await b.login(rt.fixtures[i]!.password);
      browsers.push(b);
      const got = await exchanged(b, i);
      tokens.push(got.token);
      sources.push(got.source);
      apps.push(await boot(i));
    }
    for (const [role, username] of [
      [true, "messenger-second"],
      [false, "messenger-denied"],
    ] as const) {
      const password = randomBytes(24).toString("base64url");
      rt.secretValues.add(password);
      const created = await browsers[0]!.change("/api/members", {
        username,
        password,
        roles: role ? ["messenger:use"] : [],
      });
      expect(created.status).toBe(201);
      const b = new Browser(rt.fetch, rt.fixtures[0]!.origin);
      await b.login(password, username);
      const got = await exchanged(b);
      if (role) {
        second = b;
        secondToken = got.token;
      } else {
        noRole = b;
        noRoleToken = got.token;
      }
    }
  });
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    for (const app of apps) await app.close();
    if (rt) await rt.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("maps real exchanged tokens to tenant/username without Keycloak sub or persisted sessions", async () => {
    for (let i = 0; i < 2; i++) {
      expect(decodeJwt(tokens[i]!).aud).toBe("j-messenger");
      const response = await request(tokens[i], "/api/v1/me", i);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      const value = (await response.json()) as {
        data: { id: string; serverId: string };
      };
      me.push(value.data);
      expect(value.data.serverId).toBe(rt.fixtures[i]!.tenant);
      expect(value.data.id).not.toBe(decodeJwt(tokens[i]!).sub);
    }
    expect(decodeJwt(tokens[0]!).preferred_username).toBe(
      decodeJwt(tokens[1]!).preferred_username,
    );
    expect(me[0]!.id).not.toBe(me[1]!.id);
    expect(
      Number(
        (
          apps[0]!.db.prepare("SELECT count(*) AS n FROM sessions").get() as {
            n: bigint;
          }
        ).n,
      ),
    ).toBe(0);
    expect((await request(tokens[0])).status).toBe(200);
    expect(userCount()).toBe(2);
  });
  it("rejects real role-less, wrong-audience/realm and corrupt bearer before user writes", async () => {
    const before = userCount();
    expect((await request(noRoleToken)).status).toBe(403);
    expect((await request(sources[0])).status).toBe(401);
    expect((await request(tokens[1])).status).toBe(401);
    expect((await request(tokens[0]! + "x")).status).toBe(401);
    expect((await request(undefined)).status).toBe(401);
    expect(userCount()).toBe(before);
  });
  it("does not expose own login/logout/server list and refuses cookie/query/origin fallback", async () => {
    for (const [path, method, body] of [
      [
        "/api/v1/session",
        "POST",
        {
          serverId: rt.fixtures[0]!.tenant,
          username: "admin",
          password: "fake",
        },
      ],
      ["/api/v1/native/session", "POST", {}],
      ["/api/v1/session", "DELETE", undefined],
      ["/api/v1/servers", "GET", undefined],
    ] as const)
      expect((await request(undefined, path, 0, body, method)).status).toBe(
        404,
      );
    expect(
      (
        await request(tokens[0], "/api/v1/me", 0, undefined, "GET", {
          Cookie: "jm_session=fake",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(undefined, "/api/v1/me", 0, undefined, "GET", {
          Cookie: "jm_session=fake",
        })
      ).status,
    ).toBe(401);
    expect((await request(tokens[0], "/api/v1/me?token=hidden")).status).toBe(
      401,
    );
    expect(
      (
        await request(tokens[0], "/api/v1/conversations", 0, {}, "POST", {
          Origin: "https://outside.test",
        })
      ).status,
    ).toBe(403);
    expect((await request(undefined, "/health/ready")).status).toBe(200);
  });
  it("handles two real members' conversation, duplicate send and actual direct WSS delivery", async () => {
    const secondMe = await request(secondToken);
    expect(secondMe.status).toBe(200);
    const other = ((await secondMe.json()) as { data: { id: string } }).data;
    const created = await request(tokens[0], "/api/v1/conversations", 0, {
      kind: "direct",
      memberIds: [other.id],
      clientRequestId: randomUUID(),
    });
    expect(created.status).toBe(201);
    const conversation = ((await created.json()) as { data: { id: string } })
      .data;
    conversationId = conversation.id;
    const stream = direct(secondToken);
    expect(await stream.opened).toBe(101);
    expect((await stream.next()).type).toBe("ready");
    const input = {
      clientMessageId: randomUUID(),
      text: "실제 인증 메신저 메시지",
    };
    const sent = await request(
      tokens[0],
      `/api/v1/conversations/${conversation.id}/messages`,
      0,
      input,
    );
    expect(sent.status).toBe(201);
    const message = (await sent.json()) as { data: { id: string } };
    const frame = await stream.next();
    expect(frame.type).toBe("message.created.v1");
    expect(JSON.stringify(frame)).toContain(message.data.id);
    expect(JSON.stringify(frame)).toContain(input.text);
    const repeat = await request(
      tokens[0],
      `/api/v1/conversations/${conversation.id}/messages`,
      0,
      input,
    );
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { data: { id: string } }).data.id).toBe(
      message.data.id,
    );
    expect(
      (
        await request(
          tokens[0],
          `/api/v1/conversations/${conversation.id}/messages`,
          0,
          { ...input, text: "changed" },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          tokens[1],
          `/api/v1/conversations/${conversation.id}/messages`,
          1,
        )
      ).status,
    ).toBe(404);
    stream.socket.close();
    await stream.ended;
  });
  it("recovers a real disconnected member's offline message through the authoritative cursor sync", async () => {
    const first = direct(secondToken);
    expect(await first.opened).toBe(101);
    const ready = await first.next();
    expect(ready.type).toBe("ready");
    expect(typeof ready.cursor).toBe("string");
    first.socket.close();
    await first.ended;
    const sent = await request(
      tokens[0],
      `/api/v1/conversations/${conversationId}/messages`,
      0,
      { clientMessageId: randomUUID(), text: "단절 중 기록" },
    );
    expect(sent.status).toBe(201);
    const id = ((await sent.json()) as { data: { id: string } }).data.id;
    const reconnected = direct(secondToken);
    expect(await reconnected.opened).toBe(101);
    expect((await reconnected.next()).type).toBe("ready");
    const synced = await request(
      secondToken,
      `/api/v1/sync?after=${encodeURIComponent(ready.cursor as string)}`,
    );
    expect(synced.status).toBe(200);
    const data = await synced.json();
    expect(JSON.stringify(data)).toContain(id);
    expect(JSON.stringify(data)).toContain("단절 중 기록");
    reconnected.socket.close();
    await reconnected.ended;
  });
  it("rejects actual WSS handshake role, audience, realm, cookie and query credential violations", async () => {
    const denied = relayed(noRole);
    expect(await denied.opened).toBe(403);
    for (const [token, query, headers, status] of [
      [noRoleToken, "", {}, 403],
      [sources[0]!, "", {}, 401],
      [tokens[1]!, "", {}, 401],
      [tokens[0]!, "?token=x", {}, 401],
      [tokens[0]!, "", { Cookie: "jm_session=fake" }, 401],
      [tokens[0]!, "", { Origin: "https://outside.test" }, 403],
    ] as Array<[string, string, Record<string, string>, number]>) {
      const stream = direct(token, 0, query, headers);
      expect(await stream.opened).toBe(status);
    }
  });
  it("relays a real messenger ready frame through BFF and ends the relay on actual logout", async () => {
    const stream = relayed(second);
    expect(await stream.opened).toBe(101);
    expect((await stream.next()).type).toBe("ready");
    expect((await second.change("/auth/logout", undefined)).status).toBe(303);
    await stream.ended;
  });
  it("closes real BFF-to-messenger WSS after actual member role revocation", async () => {
    const stream = relayed(browsers[0]!);
    expect(await stream.opened).toBe(101);
    expect((await stream.next()).type).toBe("ready");
    const self = decodeJwt(tokens[0]!).sub!;
    expect(
      (
        await browsers[0]!.change(
          `/api/members/${self}/roles/messenger:use`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    await stream.ended;
    expect((await browsers[0]!.request("/api/me")).status).toBe(401);
  });
  it("distinguishes a real JWKS transport outage from invalid tokens without changing users", async () => {
    const denied = await createApplication(
      loadConfig(
        {
          NODE_ENV: "test",
          AUTH_MODE: "j-auth",
          JAUTH_TENANT: rt.fixtures[0]!.tenant,
          KC_PUBLIC_URL: rt.fixtures[0]!.config.keycloakOrigin,
        },
        root + "/outage",
      ),
      {
        authFetch: (input, init) =>
          rt.fetchLoopback(
            String(input).replace(/:\d+\/realms/, ":54259/realms"),
            init,
          ),
        logger,
        maintenance: false,
      },
    );
    try {
      const response = await denied.app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { Authorization: "Bearer " + tokens[0] },
      });
      expect(response.statusCode).toBe(503);
      expect(
        Number(
          (
            denied.db.prepare("SELECT count(*) AS n FROM users").get() as {
              n: bigint;
            }
          ).n,
        ),
      ).toBe(0);
    } finally {
      await denied.close();
    }
  });
  it("reopens the actual file database and revalidates tokens while preserving users/messages", async () => {
    const count = userCount(),
      rows = Number(
        (
          apps[0]!.db.prepare("SELECT count(*) AS n FROM messages").get() as {
            n: bigint;
          }
        ).n,
      );
    await apps[0]!.close();
    apps[0] = await boot(0);
    expect((await request(secondToken)).status).toBe(200);
    expect(userCount()).toBe(count);
    expect(
      Number(
        (
          apps[0]!.db.prepare("SELECT count(*) AS n FROM messages").get() as {
            n: bigint;
          }
        ).n,
      ),
    ).toBe(rows);
    expect(rows).toBeGreaterThan(0);
    for (const secret of rt.secretValues)
      expect(logs.join("") + rt.logs.join("")).not.toContain(secret);
    expect(logs.join("")).not.toContain("실제 인증 메신저 메시지");
  });
  it("starts the compiled main with real remote JWKS and exits cleanly on SIGTERM", async () => {
    const repository = fileURLToPath(
      new URL("../../../j-messenger/", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(
          new URL("./resolve-messenger-test-hosts.mjs", import.meta.url),
        ),
        repository + "apps/server/dist/main.js",
      ],
      {
        cwd: repository,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_ENV: "test",
          HOST: "127.0.0.1",
          PORT: "54252",
          PUBLIC_ORIGIN: "https://127.0.0.1:54252",
          AUTH_MODE: "j-auth",
          JAUTH_TENANT: rt.fixtures[0]!.tenant,
          KC_PUBLIC_URL: rt.fixtures[0]!.config.keycloakOrigin,
          DB_PATH: root + "/compiled/messenger.sqlite",
          FILE_ROOT: root + "/compiled/files",
          TEMP_ROOT: root + "/compiled/temp",
          WEB_DIST: root + "/compiled/web",
          BACKUP_ROOT: root + "/compiled/backups",
          TLS_CERT_PATH: required("JGW_TLS_CERTIFICATE"),
          TLS_KEY_PATH: required("JGW_TLS_KEY"),
          CURSOR_SIGNING_KEY: randomBytes(32).toString("base64url"),
        },
      },
    );
    const captured: string[] = [];
    child.stdout?.on("data", (b: Buffer) => captured.push(b.toString()));
    child.stderr?.on("data", (b: Buffer) => captured.push(b.toString()));
    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Compiled messenger stopped before readiness.");
        try {
          ready = (
            await rt.fetchLoopback("https://127.0.0.1:54252/health/ready", {
              signal: AbortSignal.timeout(500),
            })
          ).ok;
        } catch {
          /* Bound startup probing. */
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      const response = await rt.fetchLoopback(
        "https://127.0.0.1:54252/api/v1/me",
        { headers: { Authorization: "Bearer " + secondToken } },
      );
      expect(response.status).toBe(200);
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
      expect(child.exitCode).toBe(0);
      for (const secret of rt.secretValues)
        expect(captured.join("")).not.toContain(secret);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await ended;
        } finally {
          clearTimeout(timer);
        }
      }
    }
  });
});
