import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import {
  applyGateway,
  execute,
  loadGatewayProfile,
  renderGateway,
} from "../../deploy/gateway/gateway.mjs";

// Exact locally available official image. There is no skip or fallback to a mock nginx.
const image =
  "nginx@sha256:9bf97bd7714f5e24c1ccd545ecb9eb5435cb6d109c97cebb15e7e455e0239edb";
const tenant = "gateway-fixture-a";
const hostname = `gw.${tenant}.jgw.test`;
let root,
  env,
  ca,
  container,
  running = false;
const servers = [],
  sockets = new Set();
const requests = { bff: [], customer: [], talk: [] };
const dockerIdentity = ["--user", `${process.getuid()}:${process.getgid()}`];
const substitute = (input, variables) =>
  execute(
    "docker",
    [
      "run",
      "-i",
      "--rm",
      "--network",
      "none",
      "--read-only",
      ...dockerIdentity,
      ...Object.entries(variables).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      "--entrypoint",
      "/usr/bin/envsubst",
      image,
      Object.keys(variables)
        .map((k) => "$" + k)
        .join(" "),
    ],
    { input },
  );
async function availablePort() {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  if (port === 3001) return availablePort();
  return port;
}
const dockerRun = () => [
  "run",
  "--rm",
  "--network",
  "host",
  "--read-only",
  ...dockerIdentity,
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--mount",
  `type=bind,source=${root},target=${root}`,
  "--entrypoint",
  "/usr/sbin/nginx",
  image,
];
const commands = {
  validate: async () => {
    const args = running
      ? ["exec", container, "nginx", "-t", "-c", root + "/nginx.conf"]
      : [...dockerRun(), "-t", "-c", root + "/nginx.conf"];
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 15000,
    });
    if (result.status !== 0) {
      await writeFile(
        "/workspace/.suite-runtime/j-groupware/gateway-nginx-diagnostic.log",
        result.stderr ?? "",
        { mode: 0o600 },
      );
      throw new Error("fixture_nginx_validation_failed");
    }
  },
  reload: () =>
    execute("docker", [
      "exec",
      container,
      "nginx",
      "-s",
      "reload",
      "-c",
      root + "/nginx.conf",
    ]),
};
const filesFor = (overrides = {}) =>
  renderGateway({ ...env, ...overrides }, root, substitute);
const apply = async (overrides = {}) => {
  const files = await filesFor(overrides);
  const result = await applyGateway(root, files, commands, { reload: running });
  env = { ...env, ...overrides };
  return result;
};
function request(
  route,
  { host = hostname, headers = {}, http = false, body } = {},
) {
  return new Promise((resolve, reject) => {
    const req = (http ? httpRequest : httpsRequest)(
      {
        hostname: "127.0.0.1",
        port: Number(
          http ? env.JGW_GATEWAY_HTTP_PORT : env.JGW_GATEWAY_HTTPS_PORT,
        ),
        servername: host,
        ca,
        path: route,
        method: body === undefined ? "GET" : "POST",
        headers: {
          Host: `${host}:${http ? env.JGW_GATEWAY_HTTP_PORT : env.JGW_GATEWAY_HTTPS_PORT}`,
          ...headers,
          ...(body === undefined ? {} : { "Content-Length": body.length }),
        },
        timeout: 3000,
        rejectUnauthorized: true,
      },
      (response) => {
        const parts = [];
        response.on("data", (chunk) => parts.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(parts).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("gateway_request_timeout")));
    req.end(body);
  });
}
async function waitFor(route, expected, options) {
  for (let i = 0; i < 300; i++) {
    try {
      const result = await request(route, options);
      if (expected(result)) return result;
    } catch {
      /* bounded readiness/reload */
    }
    await delay(30);
  }
  throw new Error("Gateway did not reach expected response.");
}
async function websocket(route, headers = {}) {
  const socket = new WebSocket(
    `wss://127.0.0.1:${env.JGW_GATEWAY_HTTPS_PORT}${route}`,
    {
      ca,
      servername: hostname,
      headers: {
        Host: `${hostname}:${env.JGW_GATEWAY_HTTPS_PORT}`,
        ...headers,
      },
      handshakeTimeout: 3000,
    },
  );
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  await once(socket, "open");
  return socket;
}
describe(
  "GW-T16 actual isolated nginx HTTPS/WSS/config rollback",
  { concurrency: false },
  () => {
    before(async () => {
      if (process.env.JGW_GATEWAY_TEST_RUNTIME !== "isolated-cloud")
        throw new Error(
          "Explicit isolated cloud gateway runtime required; no tests skipped.",
        );
      await mkdir("/workspace/.suite-runtime", { recursive: true });
      root = await mkdtemp("/workspace/.suite-runtime/gateway-");
      container = "jgw-gateway-test-" + path.basename(root);
      await mkdir(root + "/tls");
      await execute("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=isolated-gateway-test",
        "-addext",
        `subjectAltName=DNS:${hostname},DNS:gw.gateway-fixture-b.jgw.test,DNS:unknown.jgw.test`,
        "-keyout",
        root + "/tls/key.pem",
        "-out",
        root + "/tls/cert.pem",
      ]);
      ca = await readFile(root + "/tls/cert.pem");
      const tls = { cert: ca, key: await readFile(root + "/tls/key.pem") };
      const makeServer = async (name, https = false) => {
        const handler = (req, res) => {
          const observed = { path: req.url, headers: req.headers, bytes: 0 };
          requests[name].push(observed);
          req.on("data", (chunk) => {
            observed.bytes += chunk.length;
          });
          req.on("end", () => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                service: name,
                path: req.url,
                ...(req.method === "POST" ? { bytes: observed.bytes } : {}),
              }),
            );
          });
        };
        const server = https
          ? createHttpsServer(tls, handler)
          : createServer(handler);
        const ws = new WebSocketServer({ noServer: true });
        server.on("upgrade", (req, socket, head) => {
          requests[name].push({ path: req.url, headers: req.headers });
          ws.handleUpgrade(req, socket, head, (connection) => {
            connection.on("message", (data, binary) =>
              connection.send(data, { binary }),
            );
          });
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        servers.push({ server, ws });
        return server.address().port;
      };
      const bff = await makeServer("bff", true),
        customer = await makeServer("customer"),
        talk = await makeServer("talk");
      env = {
        JGW_TENANT: tenant,
        JGW_GATEWAY_ALLOWED_TENANTS: tenant,
        JGW_GATEWAY_SERVICES: "j-talk,j-customer-auth-db",
        JGW_GATEWAY_BIND: "127.0.0.1",
        JGW_GATEWAY_HTTP_PORT: String(await availablePort()),
        JGW_GATEWAY_HTTPS_PORT: String(await availablePort()),
        JGW_PORT: String(bff),
        JCADB_INTERNAL_PORT: String(customer),
        JTALK_INTERNAL_PORT: String(talk),
        JGW_TLS_CERTIFICATE: root + "/tls/cert.pem",
        JGW_TLS_KEY: root + "/tls/key.pem",
        JGW_GATEWAY_UPSTREAM_CA: root + "/tls/cert.pem",
      };
      await apply();
      await execute("docker", [
        "run",
        "-d",
        "--name",
        container,
        "--network",
        "host",
        "--read-only",
        ...dockerIdentity,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        `type=bind,source=${root},target=${root}`,
        "--entrypoint",
        "/usr/sbin/nginx",
        image,
        "-c",
        root + "/nginx.conf",
        "-g",
        "daemon off;",
      ]);
      running = true;
      await waitFor("/api/fixture", (r) => r.status === 200);
    });
    after(async () => {
      for (const socket of sockets) socket.terminate();
      if (running) await execute("docker", ["rm", "-f", container]);
      for (const { server, ws } of servers) {
        for (const client of ws.clients) client.terminate();
        await new Promise((resolve) => ws.close(resolve));
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      if (root) await rm(root, { recursive: true, force: true });
    });
    it("uses actual envsubst with an explicit whitelist and actual nginx -t", async () => {
      const base = await readFile(root + "/nginx.conf", "utf8"),
        rendered = await readFile(root + `/jgw.d/gw.${tenant}.conf`, "utf8");
      assert.ok(base.includes(`include ${root}/jweb.d/*.conf;`));
      assert.ok(base.includes("$http_upgrade $connection_upgrade"));
      for (const variable of [
        "$http_host",
        "$remote_addr",
        "$request_uri",
        "$binary_remote_addr",
      ])
        assert.ok(rendered.includes(variable));
      assert.ok(!rendered.includes("${GW_"));
      assert.equal(loadGatewayProfile(env).rate, 10);
      assert.equal(loadGatewayProfile(env).burst, 20);
      assert.equal(loadGatewayProfile(env).connections, 20);
      await commands.validate();
    });
    it("redirects only the configured host and verifies TLS, HTTPS upstream, headers and private path denial", async () => {
      const redirect = await request("/api/fixture?x=1", { http: true });
      assert.equal(redirect.status, 308);
      assert.equal(
        redirect.headers.location,
        `https://${hostname}:${env.JGW_GATEWAY_HTTPS_PORT}/api/fixture?x=1`,
      );
      assert.equal(
        (await request("/", { host: "unknown.jgw.test", http: true })).status,
        404,
      );
      assert.equal(
        (await request("/", { host: "unknown.jgw.test" })).status,
        404,
      );
      assert.equal(
        (
          await request("/api/fixture", {
            headers: {
              Cookie: "fixture=cookie",
              "X-Forwarded-For": "198.51.100.1",
            },
          })
        ).status,
        200,
      );
      const last = requests.bff.at(-1);
      assert.equal(last.headers.cookie, "fixture=cookie");
      assert.equal(last.headers["x-forwarded-for"], "127.0.0.1");
      assert.equal(last.headers["x-forwarded-proto"], "https");
      const count = requests.bff.length;
      for (const route of [
        "/internal",
        "/internal/notifications",
        "/internal%2fnotifications",
      ])
        assert.equal((await request(route)).status, 404);
      assert.equal(requests.bff.length, count);
    });
    it("admits bounded messenger uploads and preserves lower limits on other BFF routes", async () => {
      const allowed = await request(
        "/api/messenger/api/v1/conversations/1/files",
        {
          body: Buffer.alloc(5000100, 0x61),
          headers: { "Content-Type": "multipart/form-data; boundary=fixture" },
        },
      );
      assert.equal(allowed.status, 200);
      assert.equal(JSON.parse(allowed.body).bytes, 5000100);
      const oversized = await request(
        "/api/messenger/api/v1/conversations/1/files",
        { body: Buffer.alloc(5065537, 0x61) },
      );
      assert.equal(oversized.status, 413);
      const unrelated = await request("/api/board", {
        body: Buffer.alloc(1048577, 0x61),
      });
      assert.equal(unrelated.status, 413);
    });
    it("routes only subscribed ext namespaces, preserves URI, and never exposes service management at root", async () => {
      const customer = await request("/ext/customer-auth/v1/guests?limit=2"),
        talk = await request("/ext/talk/v1/visitor");
      assert.deepEqual(JSON.parse(customer.body), {
        service: "customer",
        path: "/ext/customer-auth/v1/guests?limit=2",
      });
      assert.equal(JSON.parse(talk.body).service, "talk");
      const count = requests.talk.length + requests.customer.length;
      assert.equal((await request("/ext/unregistered/v1/private")).status, 404);
      assert.equal(
        JSON.parse((await request("/api/v1/private")).body).service,
        "bff",
      );
      assert.equal(requests.talk.length + requests.customer.length, count);
    });
    it("proxies actual WSS echo in the public talk namespace and BFF namespace", async () => {
      for (const route of ["/ext/talk/v1/ws", "/api/messenger/ws"]) {
        const socket = await websocket(route);
        const message = once(socket, "message");
        socket.send("한글 gateway echo");
        assert.equal((await message)[0].toString(), "한글 gateway echo");
        const closed = once(socket, "close");
        socket.close();
        await closed;
      }
    });
    it("removes ext routes and serves empty cacheable JavaScript after unsubscription", async () => {
      await apply({ JGW_GATEWAY_SERVICES: "" });
      await waitFor(
        "/ext/talk/v1/widget.min.js",
        (r) => r.status === 200 && r.body === "",
      );
      const widget = await request("/ext/talk/v1/widget.min.js");
      assert.match(widget.headers["content-type"], /^application\/javascript/);
      assert.equal(widget.headers["cache-control"], "max-age=300");
      assert.ok(widget.headers.etag);
      const counts = requests.customer.length + requests.talk.length;
      assert.equal((await request("/ext/talk/v1/visitor")).status, 404);
      assert.equal((await request("/ext/customer-auth/v1/guests")).status, 404);
      assert.equal(requests.customer.length + requests.talk.length, counts);
    });
    it("enforces actual per-IP request 429 on the empty widget too, with env-controlled limits", async () => {
      await apply({ JGW_EXT_RATE: "1", JGW_EXT_BURST: "1" });
      await delay(1200);
      // The real shared quota survives reload; wait for its earlier debt to drain.
      await waitFor("/ext/talk/v1/widget.min.js", (r) => r.status === 200);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => request("/ext/talk/v1/widget.min.js")),
      );
      assert.ok(results.filter((r) => r.status === 429).length >= 15);
      assert.equal((await request("/api/fixture")).status, 200);
    });
    it("counts real WSS connections and ignores forged forwarding IPs for connection 429", async () => {
      await apply({
        JGW_GATEWAY_SERVICES: "j-talk,j-customer-auth-db",
        JGW_EXT_RATE: "10000",
        JGW_EXT_BURST: "10000",
        JGW_EXT_CONNECTIONS: "1",
      });
      await delay(150);
      const first = await websocket("/ext/talk/v1/ws", {
        "X-Forwarded-For": "198.51.100.10",
      });
      const rejected = new WebSocket(
        `wss://127.0.0.1:${env.JGW_GATEWAY_HTTPS_PORT}/ext/talk/v1/ws`,
        {
          ca,
          servername: hostname,
          headers: { Host: hostname, "X-Forwarded-For": "198.51.100.11" },
          handshakeTimeout: 3000,
        },
      );
      rejected.on("error", () => {});
      const [req, response] = await once(rejected, "unexpected-response");
      assert.equal(response.statusCode, 429);
      response.resume();
      req.destroy();
      rejected.terminate();
      const closed = once(first, "close");
      first.close();
      await closed;
      await delay(50);
      const next = await websocket("/ext/talk/v1/ws");
      const nextClosed = once(next, "close");
      next.close();
      await nextClosed;
    });
    it("restores files on an actual nginx -t rejection and preserves j-web-owned files", async () => {
      await writeFile(root + "/jweb.d/owned.conf", "# j-web owns this file\n");
      const filename = `jgw.d/gw.${tenant}.conf`,
        previous = await readFile(root + "/" + filename);
      const files = await filesFor();
      files.set(
        filename,
        files.get(filename) + "\nunknown_invalid_directive yes;\n",
      );
      await assert.rejects(applyGateway(root, files, commands), {
        code: "validation_failed_restored",
      });
      assert.deepEqual(await readFile(root + "/" + filename), previous);
      assert.equal(
        await readFile(root + "/jweb.d/owned.conf", "utf8"),
        "# j-web owns this file\n",
      );
      await commands.validate();
      assert.equal((await request("/ext/talk/v1/visitor")).status, 200);
    });
    it("restores and actually reloads the previous routes when a reload result fails", async () => {
      const files = await filesFor({ JGW_GATEWAY_SERVICES: "" });
      let calls = 0;
      await assert.rejects(
        applyGateway(root, files, {
          validate: commands.validate,
          reload: async () => {
            await commands.reload();
            if (++calls === 1) throw new Error("injected_reload_result");
          },
        }),
        { code: "reload_failed_restored" },
      );
      assert.equal(calls, 2);
      await waitFor("/ext/talk/v1/visitor", (r) => r.status === 200);
    });
    it("detects a real master reload bind failure even when nginx signal returns zero", async () => {
      const occupied = createTcpServer();
      await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
      try {
        const files = await filesFor({
          JGW_GATEWAY_HTTP_PORT: String(occupied.address().port),
        });
        let acknowledged = false;
        await assert.rejects(
          applyGateway(root, files, {
            validate: commands.validate,
            reload: async () => {
              await commands.reload();
              acknowledged = true;
            },
          }),
          { code: "reload_failed_restored" },
        );
        assert.equal(acknowledged, true);
        assert.equal((await request("/api/fixture")).status, 200);
        assert.equal(
          (await request("/api/fixture", { http: true })).status,
          308,
        );
      } finally {
        await new Promise((resolve) => occupied.close(resolve));
      }
    });
    it("serializes concurrent configuration writers and avoids reload on identical state", async () => {
      let unblock, arrived;
      const pending = new Promise((resolve) => {
        unblock = resolve;
      });
      const entered = new Promise((resolve) => {
        arrived = resolve;
      });
      const files = await filesFor({ JGW_EXT_CONNECTIONS: "2" });
      const first = applyGateway(root, files, {
        validate: async () => {
          arrived();
          await pending;
          await commands.validate();
        },
        reload: commands.reload,
      });
      await entered;
      await assert.rejects(applyGateway(root, files, commands), {
        code: "gateway_busy",
      });
      unblock();
      await first;
      assert.deepEqual(await applyGateway(root, files, commands), {
        changed: false,
        reloaded: false,
      });
      env.JGW_EXT_CONNECTIONS = "2";
    });
    it("rejects profile injection, forbidden ports, unregistered tenant/services and symlink targets before commands", async () => {
      let substitutions = 0;
      for (const bad of [
        { JGW_TENANT: "invalid\nserver" },
        { JGW_GATEWAY_ALLOWED_TENANTS: "other-tenant" },
        { JGW_GATEWAY_SERVICES: "j-auth" },
        { JGW_GATEWAY_SERVICES: "j-talk,j-talk" },
        { JGW_PORT: "3001" },
        { JTALK_INTERNAL_PORT: "80;" },
        { JGW_EXT_RATE: "1r/s;" },
        { JGW_TLS_KEY: root + "/../key" },
        { JGW_GATEWAY_BIND: "127.0.0.1;" },
        { JTALK_INTERNAL_PROTOCOL: "ftp" },
      ]) {
        await assert.rejects(
          renderGateway({ ...env, ...bad }, root, () => {
            substitutions++;
          }),
          { code: "invalid_profile" },
        );
      }
      assert.equal(substitutions, 0);
      const unsafe = await mkdtemp("/workspace/.suite-runtime/gateway-unsafe-");
      try {
        await writeFile(unsafe + "/untouched", "preserve");
        await symlink(unsafe + "/untouched", unsafe + "/nginx.conf");
        await assert.rejects(
          applyGateway(unsafe, new Map([["nginx.conf", "invalid"]]), {
            validate: () => {
              throw new Error("must_not_run");
            },
          }),
          { code: "unsafe_target" },
        );
        assert.equal(await readFile(unsafe + "/untouched", "utf8"), "preserve");
      } finally {
        await rm(unsafe, { recursive: true, force: true });
      }
    });
    it("runs the checked-in CLI with external env and actual envsubst/nginx, without leaking URL credentials into access logs", async () => {
      await mkdir(root + "/bin");
      const docker = (await execute("which", ["docker"])).trim();
      // Docker inherits only these fixed names, without shell interpolation of env contents.
      const variables = [
        "ROOT",
        "BIND",
        "HTTP_PORT",
        "HTTPS_PORT",
        "PUBLIC_PORT",
        "TENANT",
        "ZONE",
        "RATE",
        "BURST",
        "CONNECTIONS",
        "CERT",
        "KEY",
        "UPSTREAM_CA",
        "BFF_PORT",
        "EXT_ROUTES",
        "GENERATION",
      ];
      await writeFile(
        root + "/bin/envsubst",
        `#!/bin/sh\nexec ${docker} run -i --rm --network none --read-only ${variables.map((v) => `--env GW_${v}`).join(" ")} --entrypoint /usr/bin/envsubst ${image} "$@"\n`,
        { mode: 0o700 },
      );
      await writeFile(
        root + "/bin/nginx",
        `#!/bin/sh\nexec ${docker} exec ${container} nginx "$@"\n`,
        { mode: 0o700 },
      );
      const envFile = root + "/profile.env";
      await writeFile(
        envFile,
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
        { mode: 0o600 },
      );
      const cli = fileURLToPath(
        new URL("../../deploy/gateway/cli.mjs", import.meta.url),
      );
      const output = await execute(
        process.execPath,
        [cli, "validate", envFile, root],
        { env: { ...process.env, PATH: root + "/bin:" + process.env.PATH } },
      );
      assert.deepEqual(JSON.parse(output), { changed: false, reloaded: false });
      await request("/ext/talk/v1/visitor?token=fixture-sensitive-query", {
        headers: {
          Authorization: "Bearer fixture-sensitive-bearer",
          Cookie: "fixture-sensitive-cookie=yes",
        },
      });
      const log = await readFile(root + "/access.log", "utf8");
      for (const value of [
        "fixture-sensitive-query",
        "fixture-sensitive-bearer",
        "fixture-sensitive-cookie",
        "/ext/talk/",
      ])
        assert.ok(!log.includes(value));
    });
  },
);
