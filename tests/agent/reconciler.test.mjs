import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
  mkdir,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  AgentReconciler,
  DirectoryLock,
  planActions,
} from "../../deploy/agent/reconciler.mjs";
import { provisionCommand } from "../../deploy/agent/provision-command.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";

const tenant = "agent-fixture";
const moduleUrl = new URL("../../deploy/agent/reconciler.mjs", import.meta.url)
  .href;
const commandUrl = new URL(
  "../../deploy/agent/provision-command.mjs",
  import.meta.url,
).href;
let root, binary;
const helpers = [],
  gates = [],
  controllers = [],
  runs = [];
const json = async (name, value) =>
  writeFile(root + "/" + name, JSON.stringify(value), { mode: 0o600 });
const readJson = async (name) =>
  JSON.parse(await readFile(root + "/" + name, "utf8"));
const audit = async () => {
  try {
    return (await readFile(root + "/audit.ndjson", "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};
async function waitForFile(name) {
  for (let i = 0; i < 150; i++) {
    try {
      await stat(root + "/" + name);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error("fixture_process_readiness_failed");
}
function agent(overrides = {}) {
  return new AgentReconciler({
    tenant,
    lock: new DirectoryLock(root + "/lock"),
    desired: () => readJson("desired.json"),
    inventory: async () => ({
      tenant,
      installed: await readJson("installed.json"),
      incomplete: await readJson("incomplete.json"),
    }),
    provision: provisionCommand(binary, { timeout: 5000, grace: 100 }),
    report: (report) => json("report.json", report),
    ...overrides,
  });
}
function run(instance = agent(), controller = new AbortController()) {
  controllers.push(controller);
  const result = instance.run(controller.signal);
  runs.push(result);
  return result;
}
describe(
  "GW-66 internal reconcile adapters with actual isolated filesystem/processes",
  { concurrency: false },
  () => {
    beforeEach(async () => {
      if (process.env.JGW_AGENT_TEST_RUNTIME !== "isolated-cloud")
        throw new Error(
          "Explicit isolated agent fixture opt-in required; no tests skipped.",
        );
      await mkdir("/workspace/.suite-runtime", { recursive: true });
      root = await mkdtemp("/workspace/.suite-runtime/agent-");
      binary = root + "/provision-service";
      await json("desired.json", { tenant, services: [] });
      await json("installed.json", []);
      await json("incomplete.json", []);
      await json("control.json", {});
      // A test installer only changes files under its private root. No systemctl/DB/key/firewall calls.
      await writeFile(
        binary,
        `#!${process.execPath}\n` +
          `
import { readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = ${JSON.stringify(root)};
const argv = process.argv.slice(2), service = argv[0];
await appendFile(root + '/audit.ndjson', JSON.stringify({ argv }) + '\\n');
const control = JSON.parse(await readFile(root + '/control.json', 'utf8'));
if (control.descendant) {
  spawn(process.execPath, [root + '/descendant.mjs'], { stdio: 'ignore' });
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (control.hang) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
if (control.waitForGate) {
  await writeFile(root + '/provision-running', 'ready');
  for (let i = 0; i < 200; i++) { try { await stat(root + '/gate'); break; } catch { await delay(20); } }
}
let installed = JSON.parse(await readFile(root + '/installed.json', 'utf8'));
let incomplete = JSON.parse(await readFile(root + '/incomplete.json', 'utf8'));
if (control.partialOnce === service) {
  delete control.partialOnce; await writeFile(root + '/control.json', JSON.stringify(control));
  await writeFile(root + '/incomplete.json', JSON.stringify([...new Set([...incomplete, service])]));
  process.exit(3);
}
if (!control.noChange) {
  installed = argv[1] === '--remove' ? installed.filter((s) => s !== service) : [...new Set([...installed, service])];
  await writeFile(root + '/installed.json', JSON.stringify(installed));
  await writeFile(root + '/incomplete.json', JSON.stringify(incomplete.filter((s) => s !== service)));
}
if (control.failOnce === service) {
  delete control.failOnce; await writeFile(root + '/control.json', JSON.stringify(control));
  process.stderr.write('fixture-private-sentinel'); process.exit(3);
}
`,
        { mode: 0o700 },
      );
      await writeFile(
        root + "/descendant.mjs",
        `
import { writeFile } from 'node:fs/promises';
const root = ${JSON.stringify(root)};
process.on('SIGTERM', () => {});
await writeFile(root + '/descendant-started', String(process.pid));
setInterval(() => { void writeFile(root + '/late-write', String(Date.now())); }, 10);
`,
        { mode: 0o600 },
      );
      await writeFile(
        root + "/agent-process.mjs",
        `
import { readFile, writeFile } from 'node:fs/promises';
import { AgentReconciler, DirectoryLock } from ${JSON.stringify(moduleUrl)};
import { provisionCommand } from ${JSON.stringify(commandUrl)};
const root = ${JSON.stringify(root)}, tenant = ${JSON.stringify(tenant)};
const instance = new AgentReconciler({ tenant, lock: new DirectoryLock(root + '/lock'),
desired: async () => JSON.parse(await readFile(root + '/desired.json', 'utf8')),
inventory: async () => ({ tenant, installed: JSON.parse(await readFile(root + '/installed.json', 'utf8')) }),
provision: provisionCommand(root + '/provision-service', { timeout: 5000, grace: 100 }),
report: (body) => writeFile(root + '/child-report.json', JSON.stringify(body)) });
process.stdout.write(JSON.stringify(await instance.run()));
`,
        { mode: 0o600 },
      );
    });
    afterEach(async () => {
      for (const release of gates.splice(0)) release();
      for (const controller of controllers.splice(0)) controller.abort();
      await Promise.allSettled(runs.splice(0));
      for (const child of helpers.splice(0))
        if (child.exitCode === null && child.signalCode === null) {
          const done = once(child, "exit");
          child.kill("SIGTERM");
          await done;
        }
      if (root) await rm(root, { recursive: true, force: true });
    });
    it("plans only catalog services for the bound tenant and rejects cross-tenant/unknown/duplicate states", () => {
      assert.deepEqual(
        planActions(
          tenant,
          { tenant, services: ["j-talk", "j-messenger"] },
          { tenant, installed: ["j-mail"] },
        ),
        [
          { kind: "install", service: "j-messenger" },
          { kind: "install", service: "j-talk" },
          { kind: "remove", service: "j-mail" },
        ],
      );
      for (const wanted of [
        { tenant: "other", services: [] },
        { tenant, services: ["j-auth"] },
        { tenant, services: ["j-groupware"] },
        { tenant, services: ["j-talk", "j-talk"] },
      ])
        assert.throws(
          () => planActions(tenant, wanted, { tenant, installed: [] }),
          { code: "invalid_state" },
        );
    });
    it("runs actual fixed CLI install/remove sequentially, observes real files and is idempotent on the next run", async () => {
      await json("desired.json", {
        tenant,
        services: ["j-talk", "j-messenger"],
      });
      await json("installed.json", ["j-mail"]);
      const first = await run();
      assert.equal(first.outcome, "synchronized");
      assert.equal(first.reported, true);
      assert.deepEqual(first.installed, ["j-messenger", "j-talk"]);
      assert.deepEqual(
        (await audit()).map((a) => a.argv),
        [["j-messenger"], ["j-talk"], ["j-mail", "--remove"]],
      );
      assert.equal((await run()).actions.length, 0);
      assert.equal((await audit()).length, 3);
      assert.deepEqual((await readJson("report.json")).installed, [
        "j-messenger",
        "j-talk",
      ]);
    });
    it("repairs a desired partial installation and removes an undesired partial allocation through actual CLI processes", async () => {
      await json("desired.json", { tenant, services: ["j-talk"] });
      await json("control.json", { partialOnce: "j-talk" });
      const first = await run();
      assert.equal(first.outcome, "failed");
      assert.deepEqual(first.installed, []);
      assert.deepEqual(first.incomplete, ["j-talk"]);
      const repaired = await run();
      assert.equal(repaired.outcome, "synchronized");
      assert.deepEqual(repaired.installed, ["j-talk"]);
      assert.deepEqual(repaired.incomplete, []);
      await json("installed.json", []);
      await json("incomplete.json", ["j-mail"]);
      await json("desired.json", { tenant, services: [] });
      const removed = await run();
      assert.equal(removed.outcome, "synchronized");
      assert.deepEqual(removed.actions, [
        { kind: "remove", service: "j-mail", outcome: "applied" },
      ]);
      assert.deepEqual(removed.incomplete, []);
    });
    it("does not confirm removal while partial allocation remains and rejects contradictory inventory", async () => {
      await json("incomplete.json", ["j-mail"]);
      await json("control.json", { noChange: true });
      assert.equal((await run()).error, "observation_failed");
      assert.deepEqual(await readJson("incomplete.json"), ["j-mail"]);
      assert.throws(
        () =>
          planActions(
            tenant,
            { tenant, services: [] },
            {
              tenant,
              installed: ["j-talk"],
              incomplete: ["j-talk"],
            },
          ),
        { code: "invalid_state" },
      );
      const result = await run(
        agent({
          inventory: async () => ({
            tenant,
            installed: ["j-talk"],
            incomplete: ["j-talk"],
          }),
        }),
      );
      assert.equal(result.error, "invalid_state");
      assert.equal(result.installed, undefined);
    });
    it("reports a real failing installer with observed partial state, stops the batch and retries from fresh facts", async () => {
      await json("desired.json", {
        tenant,
        services: ["j-messenger", "j-talk"],
      });
      await json("control.json", { failOnce: "j-messenger" });
      const first = await run();
      assert.equal(first.outcome, "failed");
      assert.equal(first.error, "provision_failed");
      assert.deepEqual(first.installed, ["j-messenger"]);
      assert.equal((await audit()).length, 1);
      assert.ok(!JSON.stringify(first).includes("fixture-private-sentinel"));
      const retry = await run();
      assert.equal(retry.outcome, "synchronized");
      assert.deepEqual(
        retry.actions.map((a) => a.service),
        ["j-talk"],
      );
      assert.deepEqual(
        (await audit()).map((a) => a.argv),
        [["j-messenger"], ["j-talk"]],
      );
    });
    it("rejects installer exit-zero without actual state change", async () => {
      await json("desired.json", { tenant, services: ["j-talk"] });
      await json("control.json", { noChange: true });
      const result = await run();
      assert.equal(result.outcome, "failed");
      assert.equal(result.error, "observation_failed");
      assert.equal(result.actions[0].outcome, "unconfirmed");
      assert.deepEqual(await readJson("installed.json"), []);
    });
    it("keeps installed facts unknown when the post-install observation fails and retries without duplicate writes", async () => {
      await json("desired.json", { tenant, services: ["j-talk"] });
      let reads = 0;
      const result = await run(
        agent({
          inventory: async () => {
            if (++reads > 1) throw new Error("fixture-private-sentinel");
            return { tenant, installed: await readJson("installed.json") };
          },
        }),
      );
      assert.equal(result.outcome, "failed");
      assert.equal(result.error, "observation_failed");
      assert.equal(result.installed, undefined);
      assert.equal(result.actions[0].outcome, "unconfirmed");
      assert.deepEqual(await readJson("installed.json"), ["j-talk"]);
      const retry = await run();
      assert.equal(retry.outcome, "synchronized");
      assert.deepEqual(retry.actions, []);
      assert.equal((await audit()).length, 1);
    });
    it("refuses invalid desired/inventory before invoking any installer or manufacturing installed facts", async () => {
      await json("desired.json", {
        tenant: "another-tenant",
        services: ["j-talk"],
      });
      let result = await run();
      assert.equal(result.error, "invalid_state");
      assert.equal(result.phase, "desired");
      await json("desired.json", { tenant, services: ["j-talk"] });
      result = await run(
        agent({ inventory: async () => ({ tenant, installed: ["j-auth"] }) }),
      );
      assert.equal(result.error, "invalid_state");
      assert.equal(result.phase, "inventory");
      assert.equal(result.installed, undefined);
      assert.equal((await audit()).length, 0);
    });
    it("bounds a nonresponsive read-only source, releases the lock and consumes its later rejection", async () => {
      let rejectSource;
      const pending = new Promise((_, reject) => {
        rejectSource = reject;
      });
      const result = await run(
        agent({ desired: () => pending, readTimeout: 20 }),
      );
      assert.equal(result.error, "read_timeout");
      assert.equal((await audit()).length, 0);
      rejectSource(new Error("fixture-private-sentinel"));
      await delay(10);
      assert.equal((await run()).outcome, "synchronized");
    });
    it("holds the lock until an uncooperative mutation adapter settles after cancellation", async () => {
      await json("desired.json", { tenant, services: ["j-talk"] });
      let arrive, unblock;
      const entered = new Promise((resolve) => {
        arrive = resolve;
      });
      const pending = new Promise((resolve) => {
        unblock = resolve;
      });
      gates.push(unblock);
      const controller = new AbortController();
      const first = run(
        agent({
          provision: async () => {
            arrive();
            await pending;
          },
        }),
        controller,
      );
      await entered;
      controller.abort();
      assert.equal((await run()).outcome, "busy");
      unblock();
      const cancelled = await first;
      assert.equal(cancelled.error, "cancelled");
      assert.equal(cancelled.installed, undefined);
      assert.equal((await run()).outcome, "synchronized");
    });
    it("keeps mutation success separate from a failed report, then retries reporting without reinstalling", async () => {
      await json("desired.json", { tenant, services: ["j-talk"] });
      const result = await run(
        agent({
          report: async () => {
            throw new Error("fixture-private-sentinel");
          },
        }),
      );
      assert.equal(result.outcome, "synchronized");
      assert.equal(result.reported, false);
      assert.equal(result.reportError, "report_unavailable");
      assert.ok(!JSON.stringify(result).includes("fixture-private-sentinel"));
      const retry = await run();
      assert.equal(retry.reported, true);
      assert.deepEqual(retry.actions, []);
      assert.equal((await audit()).length, 1);
    });
    it("serializes two actual Node agent processes on one lock root", async () => {
      await json("desired.json", { tenant, services: ["j-talk"] });
      await json("control.json", { waitForGate: true });
      const first = spawn(process.execPath, [root + "/agent-process.mjs"], {
        shell: false,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "ignore"],
      });
      helpers.push(first);
      let output = "";
      first.stdout.on("data", (b) => {
        output += b;
      });
      const closed = once(first, "exit");
      await waitForFile("provision-running");
      const second = JSON.parse(
        await execute(process.execPath, [root + "/agent-process.mjs"]),
      );
      assert.equal(second.outcome, "busy");
      assert.equal(second.reported, false);
      await writeFile(root + "/gate", "go");
      assert.equal((await closed)[0], 0);
      assert.equal(JSON.parse(output).outcome, "synchronized");
      assert.equal((await audit()).length, 1);
    });
    it("cancels an actual process group, kills a TERM-ignoring descendant and retains the lock until it stops", async () => {
      await json("desired.json", { tenant, services: ["j-talk"] });
      await json("control.json", { descendant: true });
      const controller = new AbortController();
      const first = run(
        agent({
          provision: provisionCommand(binary, { timeout: 5000, grace: 250 }),
        }),
        controller,
      );
      await waitForFile("descendant-started");
      await waitForFile("late-write");
      controller.abort();
      assert.equal((await run()).outcome, "busy");
      const result = await first;
      assert.equal(result.error, "cancelled");
      assert.equal(result.outcome, "failed");
      const before = await readFile(root + "/late-write", "utf8");
      await delay(80);
      assert.equal(await readFile(root + "/late-write", "utf8"), before);
      await json("control.json", {});
      assert.equal((await run()).outcome, "synchronized");
    });
    it("times out an actual uncooperative installer and can safely retry with observed inventory", async () => {
      await json("desired.json", { tenant, services: ["j-talk"] });
      await json("control.json", { hang: true });
      const result = await run(
        agent({
          provision: provisionCommand(binary, { timeout: 100, grace: 50 }),
        }),
      );
      assert.equal(result.outcome, "failed");
      assert.equal(result.error, "provision_failed");
      assert.deepEqual(result.installed, []);
      await json("control.json", {});
      assert.equal((await run()).outcome, "synchronized");
      assert.equal((await audit()).length, 2);
    });
    it("holds the lock through status reporting so a later run cannot overtake an earlier report", async () => {
      let arrive, unblock;
      const entered = new Promise((resolve) => {
          arrive = resolve;
        }),
        pending = new Promise((resolve) => {
          unblock = resolve;
        });
      gates.push(unblock);
      const first = run(
        agent({
          report: async (result) => {
            arrive();
            await pending;
            await json("report.json", result);
          },
        }),
      );
      await entered;
      assert.equal((await run()).outcome, "busy");
      unblock();
      assert.equal((await first).reported, true);
      assert.equal((await run()).outcome, "synchronized");
    });
    it("does not steal stale locks and refuses symlink executables, unknown actions and purge", async () => {
      const lock = new DirectoryLock(root + "/lock"),
        release = await lock.acquire();
      assert.equal(
        await new DirectoryLock(root + "/lock").acquire(),
        undefined,
      );
      await release();
      await release();
      await symlink(binary, root + "/linked-installer");
      await assert.rejects(
        provisionCommand(root + "/linked-installer")({
          kind: "install",
          service: "j-talk",
        }),
        { code: "invalid_configuration" },
      );
      for (const action of [
        { kind: "purge", service: "j-talk" },
        { kind: "install", service: "j-auth" },
        { kind: "remove", service: "j-groupware" },
      ])
        await assert.rejects(provisionCommand(binary)(action), {
          code: "invalid_state",
        });
      assert.equal((await audit()).length, 0);
      const timer = await readFile(
        fileURLToPath(
          new URL(
            "../../deploy/agent/jgw-provision-agent.timer.example",
            import.meta.url,
          ),
        ),
        "utf8",
      );
      assert.ok(timer.includes("OnUnitActiveSec=60s"));
    });
  },
);
