import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:https";
import { ProductEnvironment } from "../../deploy/agent/product-environment.mjs";
import {
  ProductReadiness,
  ServiceInventory,
} from "../../deploy/agent/product-readiness.mjs";
import { ServiceEnvironment } from "../../deploy/agent/service-environment.mjs";
import { ServiceStateFiles } from "../../deploy/agent/service-lifecycle.mjs";
import { planActions } from "../../deploy/agent/reconciler.mjs";

const tenant = "installer-products-fixture",
  secret = () => randomBytes(32).toString("base64url");
const children = [],
  logs = [];
let root, talk, web, adapter, environment, readiness, server, tls;
let responseMode = "ready";
before(async () => {
  if (process.env.JGW_AGENT_TEST_RUNTIME !== "isolated-cloud")
    throw new Error("Explicit actual product fixture required; no skip.");
  root = await mkdtemp(tmpdir() + "/jgw-products-");
  talk = parseEnv(
    await readFile("/workspace/.suite-runtime/j-talk/integration.env", "utf8"),
  );
  web = parseEnv(
    await readFile("/workspace/.suite-runtime/j-web/integration.env", "utf8"),
  );
  const auth = parseEnv(
    await readFile("/workspace/.suite-runtime/j-auth/integration.env", "utf8"),
  );
  talk.KC_PUBLIC_URL = auth.KC_PUBLIC_URL;
  web.KC_PUBLIC_URL = auth.KC_PUBLIC_URL;
  if (
    talk.JT_TEST_RUNTIME !== "isolated-cloud" ||
    web.JW_TEST_RUNTIME !== "isolated-cloud"
  )
    throw new Error("Require actual isolated product DBs.");
  tls = {
    cert: await readFile(talk.JT_TLS_CERTIFICATE),
    key: await readFile(talk.JT_TLS_KEY),
  };
  const profile = (port) => ({
    port,
    certificate: talk.JT_TLS_CERTIFICATE,
    key: talk.JT_TLS_KEY,
    ca: talk.JT_TLS_CERTIFICATE,
  });
  adapter = new ProductEnvironment({
    tenant,
    databasePort: Number(talk.JT_DB_PORT),
    keycloakOrigin: talk.KC_PUBLIC_URL,
    notificationOrigin: "https://127.0.0.1:54233",
    profiles: {
      "j-talk": profile(55060),
      "j-web": { ...profile(55061), customerAddress: "192.0.2.10" },
      "j-approval": profile(55064),
      "j-mail": { ...profile(55065), mailpitOrigin: "http://127.0.0.1:55067" },
      "j-messenger": { ...profile(55066), dataRoot: root + "/messenger-data" },
    },
  });
  environment = new ServiceEnvironment({
    root: root + "/env",
    backups: root + "/backups",
    render: adapter.render.bind(adapter),
    read: adapter.read.bind(adapter),
  });
  readiness = new ProductReadiness({ environment: adapter, timeout: 1000 });
  server = createServer(tls, (_req, res) => {
    if (responseMode === "hang") return;
    res.writeHead(
      responseMode === "redirect"
        ? 302
        : responseMode === "unready"
          ? 503
          : 200,
      {
        "Content-Type": "application/json",
        ...(responseMode === "redirect"
          ? { Location: "https://external.example/health/ready" }
          : {}),
      },
    );
    res.end(
      responseMode === "large"
        ? "x".repeat(4097)
        : responseMode === "messenger"
          ? '{"data":{"ready":true}}'
          : '{"status":"ok"}',
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(55062, "127.0.0.1", resolve);
  });
});
after(async () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit");
      child.kill("SIGTERM");
      await closed;
    }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (root) await rm(root, { recursive: true, force: true });
});
test("renders five fixed product env files consumed by the actual compiled config loaders with independent Messenger cursor credentials", async () => {
  for (const service of [
    "j-approval",
    "j-talk",
    "j-mail",
    "j-web",
    "j-messenger",
  ]) {
    const secrets = {
      databasePassword: secret(),
      notificationKey: secret(),
      ...(service === "j-messenger" ? { cursorSigningKey: secret() } : {}),
    };
    assert.deepEqual(
      await environment.prepare(service, () => secrets),
      secrets,
    );
    const text = await readFile(root + "/env/" + service + ".env", "utf8"),
      env = parseEnv(text);
    const file =
      service === "j-messenger" ? "platform/config/index.js" : "config.js";
    const { loadConfig } = await import(
      `/workspace/${service}/apps/server/dist/${file}`
    );
    const config = loadConfig(env);
    if (service === "j-messenger") {
      assert.equal(config.authMode, "j-auth");
      assert.equal(config.jAuth.tenantId, tenant);
      assert.equal(new URL(config.databaseUrl).pathname, "/jgw_messenger");
      assert.notEqual(secrets.cursorSigningKey, secrets.databasePassword);
    } else {
      assert.equal(config.tenant, tenant);
      assert.equal(
        config.database.database,
        service.replace("j-", "jgw_").replace("-", "_"),
      );
      assert.equal(config.database.password, secrets.databasePassword);
    }
    assert.deepEqual(
      await environment.prepare(service, () => {
        throw new Error("Must reuse credentials.");
      }),
      secrets,
    );
    assert.equal(
      (await lstat(root + "/env/" + service + ".env")).mode & 0o077,
      0,
    );
    for (const changed of [
      text + "NODE_OPTIONS=--import=bad\n",
      text + "KC_PUBLIC_URL=https://foreign.jgw.test\n",
      text.replace(tenant, "wrong-tenant"),
    ])
      assert.throws(() => adapter.read(service, changed));
  }
  assert.throws(() => adapter.profile("j-customer-auth-db"), {
    code: "product_adapter_unbound",
  });
});
test("rejects reserved/nonloopback origins, unbound products, shared service ports and invalid Messenger credentials before writing env", async () => {
  const p = {
    port: 55060,
    certificate: talk.JT_TLS_CERTIFICATE,
    key: talk.JT_TLS_KEY,
    ca: talk.JT_TLS_CERTIFICATE,
  };
  const base = {
    tenant,
    databasePort: Number(talk.JT_DB_PORT),
    keycloakOrigin: talk.KC_PUBLIC_URL,
    profiles: { "j-talk": p },
  };
  for (const changed of [
    { keycloakOrigin: "https://keycloak.jgw.test:3001" },
    { profiles: { "j-talk": { ...p, port: 3001 } } },
    { profiles: { "j-talk": p, "j-web": p } },
    { profiles: { "j-auth": p } },
    {
      profiles: {
        "j-mail": { ...p, mailpitOrigin: "http://external.example:55067" },
      },
    },
    {
      profiles: { "j-approval": p },
      notificationOrigin: "https://external.example:54333",
    },
    { profiles: { "j-talk": { ...p, NODE_OPTIONS: "--import=bad" } } },
  ])
    assert.throws(() => new ProductEnvironment({ ...base, ...changed }));
  const clean = new ServiceEnvironment({
    root: root + "/invalid-env",
    backups: root + "/backups",
    render: adapter.render.bind(adapter),
    read: adapter.read.bind(adapter),
  });
  await assert.rejects(
    clean.prepare("j-messenger", () => ({
      databasePassword: secret(),
      notificationKey: secret(),
    })),
    { code: "invalid_environment_secrets" },
  );
  await assert.rejects(lstat(root + "/invalid-env/j-messenger.env"), {
    code: "ENOENT",
  });
});
test("starts the actual compiled Talk and Web servers from generated env and probes committed PostgreSQL readiness over verified TLS", async () => {
  for (const [service, source, prefix] of [
    ["j-talk", talk, "JT"],
    ["j-web", web, "JW"],
  ]) {
    // The two existing isolated product DBs intentionally use separate ports.
    // Render each trusted product profile against that real DB, without exposing its password.
    const bound = new ProductEnvironment({
      tenant,
      databasePort: Number(source[prefix + "_DB_PORT"]),
      keycloakOrigin: source.KC_PUBLIC_URL,
      profiles: { [service]: adapter.profile(service) },
    });
    const env = bound.variables(service, {
      databasePassword: source[prefix + "_DB_PASSWORD"],
      notificationKey: secret(),
    });
    const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
      cwd: "/workspace/" + service,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.on("data", (b) => logs.push(String(b)));
    child.stderr.on("data", (b) => logs.push(String(b)));
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null)
        throw new Error(
          "Actual compiled service failed startup; private child log retained in memory.",
        );
      if (await readiness.probe(service)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
  }
});
test("rejects redirects, oversized receipts, hanging probes, untrusted certificates and the wrong product readiness shape", async () => {
  const probe = new ProductReadiness({
    environment: {
      profile: () => ({ ...adapter.profile("j-talk"), port: 55062 }),
    },
    timeout: 100,
  });
  for (const mode of ["redirect", "large", "hang", "unready", "messenger"]) {
    responseMode = mode;
    assert.equal(await probe.probe("j-talk"), false);
  }
  responseMode = "messenger";
  assert.equal(await probe.probe("j-messenger"), true);
  responseMode = "ready";
  assert.equal(await probe.probe("j-talk"), true);
  const invalidCa = new ProductReadiness({
    environment: {
      profile: () => ({
        port: 55062,
        ca: "/workspace/.suite-runtime/j-groupware/tls/server.crt",
      }),
    },
  });
  assert.equal(await invalidCa.probe("j-talk"), false);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await probe.probe("j-talk", aborted.signal), false);
});
test("classifies durable active services using actual probes and keeps failed/unready allocations visible for repair/removal", async () => {
  const state = new ServiceStateFiles(root + "/state", tenant);
  await state.write("j-talk", { status: "active", phase: "active" });
  await state.write("j-web", {
    status: "failed",
    phase: "gateway",
    action: "install",
  });
  await state.write("j-mail", { status: "removed", phase: "removed" });
  const inventory = new ServiceInventory({ tenant, state, readiness });
  assert.deepEqual(await inventory.read(), {
    tenant,
    installed: ["j-talk"],
    incomplete: ["j-web"],
  });
  assert.deepEqual(
    planActions(
      tenant,
      { tenant, services: ["j-web"] },
      await inventory.read(),
    ),
    [
      { kind: "install", service: "j-web" },
      { kind: "remove", service: "j-talk" },
    ],
  );
  const child = children[0],
    closed = once(child, "exit");
  child.kill("SIGTERM");
  await closed;
  assert.deepEqual(await inventory.read(), {
    tenant,
    installed: [],
    incomplete: ["j-talk", "j-web"],
  });
  await state.write("j-customer-auth-db", {
    status: "active",
    phase: "active",
  });
  await assert.rejects(inventory.read(), { code: "product_adapter_unbound" });
});
