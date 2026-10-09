import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BaseBootstrap } from "../../deploy/agent/base-bootstrap.mjs";
import { ServiceStateFiles } from "../../deploy/agent/service-lifecycle.mjs";
import { ServiceEnvironment } from "../../deploy/agent/service-environment.mjs";
import { DirectoryLock } from "../../deploy/agent/reconciler.mjs";
import { ProvisionError } from "../../deploy/agent/provision-error.mjs";

// Ordering and durable restart contracts; native OS acceptance is separate.
async function fixture(run) {
  const root = await mkdtemp(tmpdir() + "/jgw-base-coordinator-");
  const events = [],
    state = new ServiceStateFiles(root + "/state", "bootstrap-fixture");
  let failure, saved;
  const record = async (step) => {
    events.push(step);
    if (step === failure) throw new ProvisionError("fixture_failure");
  };
  const options = {
    bootstrap: {
      tenant: "bootstrap-fixture",
      bundles: [
        {
          service: "j-groupware",
          archive: root + "/base.tgz",
          digest: "1".repeat(64),
        },
        {
          service: "j-customer-auth-db",
          archive: root + "/ca.tgz",
          digest: "2".repeat(64),
        },
      ],
    },
    state,
    lock: new DirectoryLock(root + "/lock"),
    preflight: () => record("preflight"),
    bundles: {
      install: async (b) => {
        await record(b.service);
        return { service: b.service, phase: "ready", archiveSha256: b.digest };
      },
    },
    database: {
      prepareBase: () => record("prepareBase"),
      ensure: async (s, p) => {
        assert.equal(s, "j-groupware");
        if (saved) assert.equal(p, saved);
        saved = p;
        await record("ensure");
      },
    },
    environment: new ServiceEnvironment({
      root: root + "/env",
      backups: root + "/backups",
      render: (_s, v) => JSON.stringify(v),
      read: (_s, v) => JSON.parse(v),
    }),
    platform: {
      preflight: () => record("bundlePreflight"),
      install: () => record("unit"),
      start: () => record("start"),
      ready: () => record("ready"),
    },
    gateway: { initialize: () => record("gateway") },
  };
  try {
    await run({
      root,
      options,
      state,
      events,
      fail: (value) => {
        failure = value;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("base preparation resumes a failed gateway with the same private credentials and validates all staged bundles before PG", async () =>
  fixture(async ({ root, options, state, events, fail }) => {
    fail("gateway");
    await assert.rejects(new BaseBootstrap(options).run(), {
      code: "fixture_failure",
    });
    assert.equal((await state.read("j-groupware")).phase, "gateway");
    const before = await readFile(root + "/env/j-groupware.env");
    fail(null);
    events.length = 0;
    assert.deepEqual(await new BaseBootstrap(options).run(), {
      tenant: "bootstrap-fixture",
      phase: "base_ready",
      agentActivation: "pending",
    });
    assert((await readFile(root + "/env/j-groupware.env")).equals(before));
    assert(events.indexOf("j-groupware") < events.indexOf("prepareBase"));
    assert(events.indexOf("ready") < events.indexOf("gateway"));
    const publicState = JSON.stringify(await state.read("j-groupware"));
    for (const v of Object.values(JSON.parse(before)))
      assert(!publicState.includes(v));
  }));
test("unbound prerequisites and changed bundle intent refuse mutation and preserve existing durable intent", async () =>
  fixture(async ({ options, state, events, fail }) => {
    fail("preflight");
    await assert.rejects(new BaseBootstrap(options).run(), {
      code: "fixture_failure",
    });
    assert.equal(await state.read("j-groupware"), null);
    fail(null);
    await new BaseBootstrap(options).run();
    const prior = await state.read("j-groupware");
    events.length = 0;
    await assert.rejects(
      new BaseBootstrap({
        ...options,
        bootstrap: {
          ...options.bootstrap,
          bundles: [
            { ...options.bootstrap.bundles[0], digest: "3".repeat(64) },
          ],
        },
      }).run(),
      { code: "bootstrap_state_conflict" },
    );
    assert.deepEqual(await state.read("j-groupware"), prior);
    assert.deepEqual(events, []);
  }));
test("bundle failure stops before database allocation and does not publish active base", async () =>
  fixture(async ({ options, state, events }) => {
    options.bundles.install = async (b) => ({
      service: b.service,
      phase: "ready",
      archiveSha256: "0".repeat(64),
    });
    await assert.rejects(new BaseBootstrap(options).run(), {
      code: "bundle_not_ready",
    });
    assert.equal((await state.read("j-groupware")).status, "failed");
    assert(!events.includes("prepareBase"));
    assert(!events.includes("gateway"));
  }));
test("cancellation before mutation and held tenant lock stop bootstrap", async () =>
  fixture(async ({ options, state }) => {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(new BaseBootstrap(options).run(aborted.signal), {
      code: "bootstrap_cancelled",
    });
    assert.equal(await state.read("j-groupware"), null);
    const release = await options.lock.acquire();
    try {
      await assert.rejects(new BaseBootstrap(options).run(), { code: "busy" });
    } finally {
      await release();
    }
  }));
