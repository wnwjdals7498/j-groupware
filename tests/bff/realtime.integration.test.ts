import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { decodeJwt } from "jose";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { createTokenVerifier } from "@j-auth/token-verifier";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { Browser, integrationRuntime, required } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { createApp } from "../../apps/server/src/app.js";
import { OidcClient } from "../../apps/server/src/oidc.js";
import { digest } from "../../apps/server/src/security.js";

describe("actual WSS/SSE sockets and multi-instance session invalidation", () => {
  let runtime: Runtime,
    second: ReturnType<typeof createApp>,
    ca: Buffer[],
    upstreamPort: number,
    secondaryAgent: Agent;
  const peerHttp = createServer(),
    peer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const sockets = new Set<WebSocket>();
  const handshakes: {
    tenant: string;
    audience: unknown;
    bearerHash: string;
    cookie: boolean;
    origin: boolean;
  }[] = [];
  const browser = (index = 0, secondary = false) => {
    const origin = runtime.fixtures[index]!.origin;
    if (!secondary) return new Browser(runtime.fetch, origin);
    return new Browser(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== origin) return runtime.fetch(input, init);
      return (await undiciFetch(String(input), {
        ...init,
        dispatcher: secondaryAgent,
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    }, origin);
  };
  const login = async (index = 0, secondary = false) => {
    const b = browser(index, secondary);
    await b.login(runtime.fixtures[index]!.password);
    return b;
  };
  const session = (b: Browser) =>
    b.cookies.get(b.origin)!.get(SESSION_POLICY.cookie)!;
  const wait = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 70; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("State not observed in seven seconds.");
  };
  const ws = (
    b: Browser,
    options: {
      secondary?: boolean;
      path?: string;
      origin?: string;
      cookie?: string;
      loopback?: boolean;
    } = {},
  ) => {
    const optionsForConnection = options;
    const url = new URL(options.path ?? "/api/messenger/ws", b.origin);
    url.protocol = "wss:";
    if (options.secondary) url.port = "54235";
    const socket = new WebSocket(url, {
      ca,
      lookup: (_host, options, callback) => {
        const address = optionsForConnection.loopback
          ? "127.0.0.1"
          : required("JGW_TEST_BIND_IP");
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
      headers: {
        Origin: options.origin ?? b.origin,
        Host: new URL(b.origin).host,
        Cookie: SESSION_POLICY.cookie + "=" + (options.cookie ?? session(b)),
      },
      perMessageDeflate: false,
    });
    sockets.add(socket);
    const ended = new Promise<void>((resolve) =>
      socket.once("close", () => {
        sockets.delete(socket);
        resolve();
      }),
    );
    socket.on("error", () => {});
    const opened = new Promise<number>((resolve) => {
      socket.once("open", () => resolve(101));
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode!);
        socket.terminate();
      });
      socket.once("error", () => resolve(0));
    });
    return { socket, opened, ended };
  };
  const connect = async (b: Browser, secondary = false) => {
    const result = ws(b, { secondary });
    expect(await result.opened).toBe(101);
    return result;
  };
  const echo = async (socket: WebSocket, text = "safe-test-frame") => {
    const message = once(socket, "message");
    socket.send(text);
    const [data] = await message;
    return JSON.parse((data as Buffer).toString()) as {
      tenant: string;
      subject: string;
      echo: string;
    };
  };
  const sse = async (b: Browser) => {
    const response = await b.request("/api/notifications/stream");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader(),
      first = await reader.read();
    expect(new TextDecoder().decode(first.value).split("\n\n")[0]).toBe(
      ": connected",
    );
    const ended = (async () => {
      while (!(await reader.read()).done) {
        /* drain keepalives */
      }
    })();
    return { ended, cancel: () => reader.cancel() };
  };
  const member = async (roles = ["messenger:use"]) => {
    const admin = await login(),
      username = "realtime-" + randomBytes(8).toString("hex"),
      password = randomBytes(24).toString("base64url");
    runtime.secretValues.add(password);
    const response = await admin.change("/api/members", {
      username,
      password,
      roles,
    });
    expect(response.status).toBe(201);
    return {
      ...((await response.json()) as { id: string }),
      username,
      password,
    };
  };
  beforeAll(async () => {
    peerHttp.listen(0, "127.0.0.1");
    await once(peerHttp, "listening");
    upstreamPort = (peerHttp.address() as { port: number }).port;
    runtime = await integrationRuntime({
      serviceEndpoints: { "j-messenger": `http://127.0.0.1:${upstreamPort}` },
    });
    const verifier = createTokenVerifier({
      publicUrl: required("KC_PUBLIC_URL"),
      fetch: runtime.fetch,
    });
    peerHttp.on("upgrade", (request, socket, head) => {
      void (async () => {
        const token = request.headers.authorization?.slice(7) ?? "",
          claim = decodeJwt(token);
        const tenant = runtime.fixtures.find(
          (fixture) => fixture.tenant === claim.tenant,
        )?.tenant;
        if (!tenant || request.url !== "/api/v1/events")
          throw new Error("Unregistered peer tenant/path");
        const identity = await verifier.verify(token, {
          tenantId: tenant,
          audience: "j-messenger",
        });
        if (
          !identity.roles.includes("messenger:use") ||
          identity.claims.aud !== "j-messenger"
        )
          throw new Error("Wrong peer permission/audience");
        runtime.secretValues.add(token);
        handshakes.push({
          tenant,
          audience: identity.claims.aud,
          bearerHash: digest(token),
          cookie: request.headers.cookie !== undefined,
          origin: request.headers.origin !== undefined,
        });
        peer.handleUpgrade(request, socket, head, (connection) => {
          connection.on("error", () => {});
          connection.on("message", (data) =>
            connection.send(
              JSON.stringify({
                tenant,
                subject: identity.subject,
                echo: data.toString(),
              }),
            ),
          );
        });
      })().catch(() => socket.destroy());
    });
    expect((await runtime.subscribe(0, "j-messenger")).status).toBe(200);
    expect((await runtime.subscribe(1, "j-messenger")).status).toBe(200);
    ca = await Promise.all(
      ["JGW_TLS_CERTIFICATE", "JAUTH_TLS_CERTIFICATE"].map((name) =>
        readFile(required(name)),
      ),
    );
    const connector = buildConnector({
      ca,
      lookup: (_host, options, callback) => {
        if (options.all)
          callback(null, [
            { address: required("JGW_TEST_BIND_IP"), family: 4 },
          ]);
        else callback(null, required("JGW_TEST_BIND_IP"), 4);
      },
    });
    secondaryAgent = new Agent({
      connect: (options, callback) =>
        connector({ ...options, port: "54235" }, callback),
    });
    const fixture = runtime.fixtures[0]!,
      config = {
        tenant: fixture.tenant,
        origin: fixture.origin,
        keycloakOrigin: required("KC_PUBLIC_URL"),
        clientSecret: fixture.secrets.clientSecret,
      };
    second = createApp({
      pool: runtime.pool,
      config,
      oidc: new OidcClient(config, { fetch: runtime.fetch }),
      memberAuth: fixture.memberAuth,
      serviceEndpoints: { "j-messenger": `http://127.0.0.1:${upstreamPort}` },
      https: {
        cert: ca[0]!,
        key: await readFile(required("JGW_TLS_KEY")),
        minVersion: "TLSv1.2",
      },
    });
    await second.listen({ host: required("JGW_TEST_BIND_IP"), port: 54235 });
  });
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    if (second) await second.close();
    if (secondaryAgent) await secondaryAgent.close();
    for (const connection of peer.clients) connection.terminate();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    await new Promise<void>((resolve) => peerHttp.close(() => resolve()));
    if (runtime) await runtime.close();
  });
  it("relays actual WSS frames with a single-audience exchanged token and no browser credentials", async () => {
    const b = await login(),
      connection = await connect(b);
    try {
      expect(await echo(connection.socket)).toMatchObject({
        tenant: runtime.fixtures[0]!.tenant,
        echo: "safe-test-frame",
      });
      expect(handshakes.at(-1)).toMatchObject({
        audience: "j-messenger",
        cookie: false,
        origin: false,
      });
      const original = (
        await runtime.pool.query(
          "SELECT access_token FROM sessions WHERE session_hash=$1",
          [digest(session(b))],
        )
      ).rows[0].access_token as string;
      expect(handshakes.at(-1)!.bearerHash).not.toBe(digest(original));
    } finally {
      connection.socket.close();
      await connection.ended;
    }
  });
  it("rejects missing/foreign sessions, wrong Origin, missing role and token query before upgrading", async () => {
    const a = await login(),
      b = await login(1),
      noRole = await member([]),
      user = browser();
    await user.login(noRole.password, noRole.username);
    const before = handshakes.length;
    for (const [who, options, expected] of [
      [a, { cookie: "" }, 401],
      [a, { cookie: session(b) }, 401],
      [a, { origin: "https://evil.jgw.test" }, 403],
      [a, { path: "/api/messenger/ws?access_token=forbidden" }, 400],
      [user, {}, 403],
    ] as const)
      expect(await ws(who, options).opened).toBe(expected);
    expect(handshakes.length).toBe(before);
    expect(
      (await a.request("/api/notifications/stream?tenant=untrusted")).status,
    ).toBe(400);
    expect(
      (
        await a.request("/api/notifications/stream", {
          headers: { Origin: b.origin },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await a.request("/api/notifications/stream", {
          headers: { Cookie: SESSION_POLICY.cookie + "=" + session(b) },
        })
      ).status,
    ).toBe(401);
  });
  it("uses a real refreshed and newly exchanged token when the browser reconnects", async () => {
    const b = await login(),
      first = await connect(b);
    await echo(first.socket);
    const previous = handshakes.at(-1)!.bearerHash,
      before = runtime.refreshCount;
    first.socket.close();
    await first.ended;
    await runtime.pool.query(
      "UPDATE sessions SET access_expires_at=now() WHERE tenant_id=$1 AND session_hash=$2",
      [runtime.fixtures[0]!.tenant, digest(session(b))],
    );
    const fresh = await connect(b);
    try {
      expect(await echo(fresh.socket, "after-refresh")).toMatchObject({
        echo: "after-refresh",
      });
      expect(runtime.refreshCount - before).toBe(1);
      expect(handshakes.at(-1)!.bearerHash).not.toBe(previous);
    } finally {
      fresh.socket.close();
      await fresh.ended;
    }
  });
  it("closes WSS and SSE on both instances when the same session logs out", async () => {
    const first = await login(),
      other = browser(0, true);
    other.cookies.set(other.origin, new Map(first.cookies.get(first.origin)!));
    const one = await connect(first),
      two = await connect(other, true),
      s1 = await sse(first),
      s2 = await sse(other);
    expect((await echo(one.socket)).tenant).toBe(runtime.fixtures[0]!.tenant);
    await echo(two.socket);
    expect((await first.change("/auth/logout", undefined)).status).toBe(303);
    await Promise.all([one.ended, two.ended, s1.ended, s2.ended]);
    expect((await other.request("/api/me")).status).toBe(401);
  });
  it("closes target member sockets on actual role revocation while retaining another tenant and member", async () => {
    const target = await member(),
      a = browser(),
      b = browser(0, true);
    await a.login(target.password, target.username);
    await b.login(target.password, target.username);
    const one = await connect(a),
      two = await connect(b, true),
      s1 = await sse(a),
      s2 = await sse(b),
      other = await login(1),
      safe = await connect(other),
      admin = await login();
    await echo(one.socket);
    await echo(two.socket);
    await echo(safe.socket);
    expect(
      (
        await admin.change(
          `/api/members/${target.id}/roles/messenger:use`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    await Promise.all([one.ended, two.ended, s1.ended, s2.ended]);
    expect(safe.socket.readyState).toBe(WebSocket.OPEN);
    expect((await echo(safe.socket)).tenant).toBe(runtime.fixtures[1]!.tenant);
    safe.socket.close();
    await safe.ended;
    const fresh = browser();
    await fresh.login(target.password, target.username);
    expect(await ws(fresh).opened).toBe(403);
  });
  it("closes sockets after direct committed DB session disposal and does not act on rolled-back deletion", async () => {
    const b = await login(),
      connection = await connect(b),
      stream = await sse(b),
      hash = digest(session(b)),
      transaction = await runtime.pool.connect();
    await echo(connection.socket);
    try {
      await transaction.query("BEGIN");
      await transaction.query(
        "DELETE FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
        [runtime.fixtures[0]!.tenant, hash],
      );
      await transaction.query("ROLLBACK");
      expect(await echo(connection.socket, "after-rollback")).toMatchObject({
        echo: "after-rollback",
      });
    } finally {
      await transaction.query("ROLLBACK");
      transaction.release();
    }
    await runtime.pool.query(
      "DELETE FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
      [runtime.fixtures[0]!.tenant, hash],
    );
    await Promise.all([connection.ended, stream.ended]);
  });
  it("closes both instances through actual Keycloak backchannel logout without a BFF member mutation", async () => {
    const target = await member(),
      a = browser(),
      b = browser(0, true);
    await a.login(target.password, target.username);
    await b.login(target.password, target.username);
    const one = await connect(a),
      two = await connect(b, true),
      stream = await sse(b),
      before = runtime.incoming.length;
    await echo(one.socket);
    await echo(two.socket);
    expect(
      (
        await runtime.members(
          0,
          `/${target.id}/roles/messenger:use`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    await Promise.all([one.ended, two.ended, stream.ended]);
    await wait(async () => runtime.incoming.length > before);
    expect(
      runtime.incoming
        .slice(before)
        .some((event) => event.method === "POST" && event.status === 200),
    ).toBe(true);
    expect((await b.request("/api/me")).status).toBe(401);
  });
  it("closes expired idle/absolute sessions with periodic DB validation even without a delete event", async () => {
    for (const column of ["last_seen_at", "created_at"]) {
      const b = await login(),
        connection = await connect(b),
        stream = await sse(b);
      await echo(connection.socket);
      await runtime.pool.query(
        `UPDATE sessions SET ${column}=now()-interval '${column === "created_at" ? "8 hours" : "30 minutes"}'-interval '1 second' WHERE tenant_id=$1 AND session_hash=$2`,
        [runtime.fixtures[0]!.tenant, digest(session(b))],
      );
      await Promise.all([connection.ended, stream.ended]);
    }
  });
  it("fails closed on loss of a real PG listener and restores it before accepting new connections", async () => {
    const b = await login(0, true),
      connection = await connect(b, true),
      stream = await sse(b);
    await echo(connection.socket);
    const oldPid = second.realtime.listenerPid!;
    expect(oldPid).toBeTypeOf("number");
    expect(
      (
        await runtime.pool.query("SELECT pg_terminate_backend($1) AS stopped", [
          oldPid,
        ])
      ).rows[0].stopped,
    ).toBe(true);
    await Promise.all([connection.ended, stream.ended]);
    expect((await b.request("/health/ready")).status).toBe(200);
    expect(second.realtime.listenerPid).not.toBe(oldPid);
    const fresh = await connect(b, true);
    expect(await echo(fresh.socket)).toMatchObject({
      tenant: runtime.fixtures[0]!.tenant,
    });
    fresh.socket.close();
    await fresh.ended;
  });
  it("prevents a delayed exchange/upgrade from retaining a socket after logout", async () => {
    const b = await login(),
      me = await b.me(),
      hash = digest(session(b)),
      gate = runtime.holdNextServiceToken(),
      pending = ws(b);
    let logout: Promise<Response> | undefined;
    try {
      await gate.arrival;
      logout = b.request("/auth/logout", {
        method: "POST",
        headers: { Origin: b.origin, "x-csrf-token": me.csrfToken },
      });
      gate.release();
      expect((await logout).status).toBe(303);
      const status = await pending.opened;
      expect([101, 401, 503]).toContain(status);
      await pending.ended;
    } finally {
      gate.release();
      if (logout) await logout.catch(() => undefined);
      pending.socket.terminate();
    }
    await wait(
      async () =>
        !(
          await runtime.pool.query(
            "SELECT 1 FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
            [runtime.fixtures[0]!.tenant, hash],
          )
        ).rowCount,
    );
  });
  it("closes actual WSS/SSE sockets during graceful shutdown of the compiled HTTPS process", async () => {
    const child = await runtime.startCompiled(),
      b = new Browser(runtime.fetchLoopback, runtime.fixtures[0]!.origin);
    try {
      await b.login(runtime.fixtures[0]!.password);
      const connection = ws(b, { loopback: true });
      expect(await connection.opened).toBe(101);
      const stream = await sse(b);
      expect((await echo(connection.socket)).tenant).toBe(
        runtime.fixtures[0]!.tenant,
      );
      await runtime.stop(child);
      await Promise.all([connection.ended, stream.ended]);
    } finally {
      await runtime.stop(child);
    }
    const logs = runtime.logs.join("");
    for (const secret of runtime.secretValues)
      expect(logs).not.toContain(secret);
  });
});
