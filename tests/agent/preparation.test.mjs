import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  lstat,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { BootstrapFiles } from "../../deploy/agent/bootstrap-files.mjs";
import { ServiceEnvironment } from "../../deploy/agent/service-environment.mjs";
import {
  ServiceLifecycle,
  ServiceStateFiles,
} from "../../deploy/agent/service-lifecycle.mjs";
import {
  NativeSystemdPlatform,
  renderServiceUnit,
  parseUnitObservation,
} from "../../deploy/agent/native-platform.mjs";
import { ProductCleanup } from "../../deploy/agent/product-cleanup.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";
let root, input;
const secret = () => randomBytes(32).toString("base64url");
before(async () => {
  root = await mkdtemp(tmpdir() + "/jgw-preparation-");
  await execute("/usr/bin/openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=Isolated bootstrap fixture CA",
    "-days",
    "1",
    "-keyout",
    root + "/ca.key",
    "-out",
    root + "/ca.crt",
  ]);
  const archive = root + "/source.tgz";
  await writeFile(archive, "fixture-staged-archive-not-an-installed-bundle", {
    mode: 0o600,
  });
  input = {
    tenant: "agent-fixture",
    clientSecret: secret(),
    serviceKey: secret(),
    agentKey: secret(),
    authOrigin: "https://auth.jgw.test:58443",
    consoleOrigin: "https://console.jgw.test",
    localCa: await readFile(root + "/ca.crt", "utf8"),
    bundles: [
      {
        service: "j-groupware",
        archive,
        digest: createHash("sha256")
          .update(await readFile(archive))
          .digest("hex"),
      },
    ],
  };
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
test("seals one-time bootstrap secrets and verifies staging digests without activating a service or installing trust", async () => {
  const target = root + "/prepared",
    preparation = new BootstrapFiles(target),
    result = await preparation.prepare(input);
  assert.equal(result.phase, "prepared");
  assert.equal((await lstat(target + "/bootstrap.env")).mode & 0o077, 0);
  const publicState = await readFile(target + "/bootstrap.json", "utf8");
  for (const key of ["clientSecret", "serviceKey", "agentKey"])
    assert(!publicState.includes(input[key]));
  const original = await readFile(target + "/bootstrap.env");
  await assert.rejects(preparation.prepare({ ...input, agentKey: secret() }), {
    code: "bootstrap_already_prepared",
  });
  assert((await readFile(target + "/bootstrap.env")).equals(original));
  const bad = new BootstrapFiles(root + "/bad-digest");
  await assert.rejects(
    bad.prepare({
      ...input,
      bundles: [{ ...input.bundles[0], digest: "0".repeat(64) }],
    }),
    { code: "bundle_digest_mismatch" },
  );
  await assert.rejects(lstat(root + "/bad-digest/bootstrap.env"), {
    code: "ENOENT",
  });
});
test("rejects env injection, foreign origins, symlinked roots and unmanaged archives before writing secrets", async () => {
  for (const override of [
    { clientSecret: "wrong\nNODE_OPTIONS=--import=bad" },
    { authOrigin: "https://external.example" },
    { consoleOrigin: "https://console.jgw.test:3001" },
    { bundles: [{ ...input.bundles[0], service: "j-talk;command" }] },
  ])
    await assert.rejects(
      new BootstrapFiles(root + "/invalid").prepare({ ...input, ...override }),
    );
  await symlink(root + "/prepared", root + "/linked");
  await assert.rejects(
    new BootstrapFiles(root + "/linked/subdir").prepare(input),
  );
  await assert.rejects(lstat(root + "/prepared/subdir"), { code: "ENOENT" });
});
test("private service env preserves generated credentials across retry and remains after failed removal stages", async () => {
  const environment = new ServiceEnvironment({
      root: root + "/environment",
      backups: root + "/backups",
      render: (_service, value) => JSON.stringify(value),
      read: (_service, text) => JSON.parse(text),
    }),
    state = new ServiceStateFiles(root + "/state", "agent-fixture");
  const first = await environment.prepare("j-talk", () => ({
    databasePassword: secret(),
    notificationKey: secret(),
  }));
  const second = await environment.prepare("j-talk", () => {
    throw new Error("Secret generator must not run twice.");
  });
  assert.deepEqual(first, second);
  const events = [];
  let gatewayFailure = true,
    backupFailure = false,
    dumps = 0;
  // Explicit test ports: ordering/failure/secret durability here, actual PG in
  // database.integration.test.mjs. No fake systemd result is called VM acceptance.
  const lifecycle = new ServiceLifecycle({
    tenant: "agent-fixture",
    state,
    environment,
    database: {
      ensure: async () => events.push("database"),
      inspect: async () => ({ role: true, database: true, login: true }),
      dump: async (_service, file) => {
        if (backupFailure) throw new Error();
        dumps++;
        await writeFile(file, "actual-file-backed-test-backup", {
          mode: 0o600,
        });
      },
      disable: async () => events.push("disable"),
    },
    platform: {
      preflight: async () => {},
      install: async () => events.push("unit"),
      start: async () => {},
      ready: async () => events.push("ready"),
      stop: async () => events.push("stop"),
    },
    gateway: {
      set: async (_service, installed) => {
        if (!installed && gatewayFailure) throw new Error();
        events.push("gateway");
      },
    },
    notifications: {
      register: async () => events.push("notification"),
      remove: async () => events.push("notification_remove"),
    },
    cleanup: { run: async () => events.push("cleanup") },
  });
  await lifecycle.run("j-talk");
  assert(events.indexOf("ready") < events.indexOf("notification"));
  assert(events.indexOf("notification") < events.indexOf("gateway"));
  await lifecycle.run("j-customer-auth-db");
  const customerSecrets = JSON.parse(
    await readFile(root + "/environment/j-customer-auth-db.env", "utf8"),
  );
  assert.match(customerSecrets.cursorSigningKey, /^[A-Za-z0-9_-]{43}$/);
  await lifecycle.run("j-customer-auth-db");
  assert.deepEqual(
    JSON.parse(
      await readFile(root + "/environment/j-customer-auth-db.env", "utf8"),
    ),
    customerSecrets,
  );
  for (const value of Object.values(customerSecrets))
    assert(
      !(
        await readFile(root + "/state/j-customer-auth-db.json", "utf8")
      ).includes(value),
    );
  const file = root + "/environment/j-talk.env",
    bytes = await readFile(file);
  for (const key of Object.values(first))
    assert(
      !(await readFile(root + "/state/j-talk.json", "utf8")).includes(key),
    );
  await assert.rejects(lifecycle.run("j-talk", "remove"));
  assert((await readFile(file)).equals(bytes));
  assert.equal((await state.read("j-talk")).phase, "gateway");
  assert.equal(dumps, 1);
  gatewayFailure = false;
  await lifecycle.run("j-talk", "remove");
  assert.equal(dumps, 1);
  await assert.rejects(lstat(file), { code: "ENOENT" });
  assert.equal((await state.read("j-talk")).status, "removed");
  await lifecycle.run("j-talk", "remove");
  await assert.rejects(lifecycle.run("j-talk"), {
    code: "removed_database_requires_review",
  });
  await lifecycle.run("j-web");
  backupFailure = true;
  events.length = 0;
  await assert.rejects(lifecycle.run("j-web", "remove"));
  assert(!events.includes("disable"));
  assert(!events.includes("cleanup"));
  await lstat(root + "/environment/j-web.env");
});
test("unbound or foreign storage fails before database allocation or service stop", async () => {
  const events = [];
  const state = new ServiceStateFiles(
    root + "/storage-guard-state",
    "agent-fixture",
  );
  const call = async () => events.push("mutation");
  const environment = new ServiceEnvironment({
    root: root + "/storage-guard-env",
    backups: root + "/storage-guard-backups",
    render: (_service, value) => JSON.stringify(value),
    read: (_service, text) => JSON.parse(text),
  });
  const ports = {
    tenant: "agent-fixture",
    state,
    environment,
    database: {
      ensure: call,
      inspect: async () => ({ role: true, database: true }),
      dump: call,
      disable: call,
    },
    platform: {
      preflight: call,
      install: call,
      start: call,
      ready: call,
      stop: call,
    },
    gateway: { set: call },
  };
  const unbound = new ServiceLifecycle({ ...ports, cleanup: { run: call } });
  await assert.rejects(unbound.run("j-messenger"), {
    code: "storage_adapter_unbound",
  });
  await assert.rejects(unbound.run("j-messenger", "remove"), {
    code: "storage_adapter_unbound",
  });
  assert.deepEqual(events, []);
  const foreign = new ServiceLifecycle({
    ...ports,
    cleanup: {
      preflight: async () => {
        throw Object.assign(new Error("unmanaged_product_storage"), {
          code: "unmanaged_product_storage",
        });
      },
      prepare: call,
      run: call,
    },
  });
  await assert.rejects(foreign.run("j-messenger", "remove"));
  assert.deepEqual(events, []);
  await assert.rejects(lstat(root + "/storage-guard-env/j-messenger.env"), {
    code: "ENOENT",
  });
});
test("native units carry fixed entrypoints, separate users and web helper privilege; host activation is refused", async () => {
  const bundleRoot = root + "/bundles",
    environmentRoot = root + "/environment";
  await mkdir(bundleRoot + "/j-talk", { recursive: true });
  assert.deepEqual(await new ProductCleanup().run("j-customer-auth-db"), {
    service: "j-customer-auth-db",
    storage: "postgres",
    data: "retained",
  });
  const unit = renderServiceUnit("j-talk", bundleRoot, environmentRoot);
  assert(unit.includes("LoadCredential=tls-key:"));
  assert(unit.includes("LoadCredential=ca-certificate:"));
  assert(unit.includes("/usr/bin/env -u NODE_EXTRA_CA_CERTS -- /usr/bin/node"));
  assert(unit.includes("User=jgw-talk"));
  assert(unit.includes("NoNewPrivileges=true"));
  assert(
    renderServiceUnit("j-web", bundleRoot, environmentRoot).includes(
      "User=jweb",
    ),
  );
  const file = root + "/jgw-talk.service";
  // The cloud runtime has no /usr/bin/node. Validate the unit syntax with this
  // test process's existing binary; the production renderer remains fixed.
  await writeFile(
    file,
    unit.replace("/usr/bin/node ", process.execPath + " "),
    { mode: 0o600 },
  );
  await execute("/usr/bin/systemd-analyze", ["verify", file]);
  const platform = new NativeSystemdPlatform({
    bundleRoot,
    environmentRoot,
    unitRoot: root,
    ready: async () => true,
  });
  await assert.rejects(platform.preflight("j-talk"), { code: "root_required" });
  assert.throws(() =>
    renderServiceUnit("j-talk;id", bundleRoot, environmentRoot),
  );
  assert.deepEqual(
    parseUnitObservation(
      "LoadState=not-found\nFragmentPath=\nActiveState=inactive\n",
    ),
    { LoadState: "not-found", FragmentPath: "", ActiveState: "inactive" },
  );
  for (const observed of [
    "LoadState=not-found\nActiveState=inactive\n",
    "LoadState=loaded\nFragmentPath=/foreign\nActiveState=active\nLoadState=not-found\n",
    "LoadState=error\nFragmentPath=\nActiveState=inactive\n",
  ])
    assert.throws(() => parseUnitObservation(observed));
});

test("native account removal retry verifies retained cleanup after an ambiguous environment-delete failure", async () => {
  const dir = root + "/account-retry";
  await mkdir(dir, { mode: 0o700 });
  const state = new ServiceStateFiles(dir + "/state", "agent-fixture"),
    environment = new ServiceEnvironment({
      root: dir + "/environment",
      backups: dir + "/backups",
      render: (_service, value) => JSON.stringify(value),
      read: (_service, text) => JSON.parse(text),
    });
  let clean = 0,
    verify = 0,
    accounts = 0,
    envFail = true,
    verifyFail = false;
  const remove = environment.remove.bind(environment);
  environment.remove = async (service) => {
    if (envFail) throw new Error("private fault");
    return remove(service);
  };
  const lifecycle = new ServiceLifecycle({
    tenant: "agent-fixture",
    state,
    environment,
    database: {
      ensure: async () => {},
      inspect: async () => ({ role: true, database: true }),
      dump: async (_s, file) =>
        writeFile(file, "retained real file", { mode: 0o600 }),
      disable: async () => {},
    },
    platform: {
      preflight: async () => {},
      install: async () => {},
      start: async () => {},
      ready: async () => {},
      stop: async () => {},
      removeAccount: async () => {
        accounts++;
      },
    },
    gateway: { set: async () => {} },
    cleanup: {
      preflight: async () => {},
      run: async () => {
        clean++;
        return { storageBackup: dir + "/retained" };
      },
      verifyRetained: async () => {
        verify++;
        if (verifyFail) throw new Error("backup corrupt");
        return { storageBackup: dir + "/retained" };
      },
    },
  });
  await lifecycle.run("j-customer-auth-db");
  await assert.rejects(lifecycle.run("j-customer-auth-db", "remove"));
  const saved = await state.read("j-customer-auth-db");
  assert.equal(saved.phase, "environment_remove");
  assert.equal(saved.cleanupComplete, true);
  assert.equal(clean, 1);
  assert.equal(accounts, 1);
  envFail = false;
  verifyFail = true;
  await assert.rejects(lifecycle.run("j-customer-auth-db", "remove"));
  assert.equal(accounts, 1);
  assert.equal((await state.read("j-customer-auth-db")).phase, "cleanup");
  verifyFail = false;
  await lifecycle.run("j-customer-auth-db", "remove");
  assert.equal(clean, 1);
  assert.equal(verify, 2);
  assert.equal(accounts, 2);
  assert.equal((await state.read("j-customer-auth-db")).status, "removed");
  assert.equal(await readFile(saved.backup, "utf8"), "retained real file");
});
