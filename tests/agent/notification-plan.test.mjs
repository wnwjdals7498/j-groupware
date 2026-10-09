import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execute } from "../../deploy/gateway/gateway.mjs";
import { renderNotificationPlan } from "../../deploy/agent/notification-plan.mjs";

const profile = JSON.parse(
  await readFile(
    new URL(
      "../../deploy/agent/notification-plan.example.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
test("explicit owner/account/topology render inert control and units with no credentials", () => {
  const plan = renderNotificationPlan(profile);
  assert.equal(plan.acceptance_complete, false);
  assert.equal(plan.activation, "pending");
  assert.equal(plan.ownerId, profile.ownerId);
  assert.equal(plan.topology, "customer-local");
  assert.equal(
    JSON.parse(plan.control).credentialsFile,
    profile.credentialsFile,
  );
  assert.match(plan.service, /User=replace_with_executor\n/);
  assert.match(plan.service, /ProtectSystem=strict\n/);
  assert.match(plan.timer, /OnUnitInactiveSec=20s\n/);
  assert.equal(plan.not_run_list.length, 5);
  for (const text of [plan.control, plan.service, plan.timer]) {
    assert.doesNotMatch(
      text,
      /Bearer |client_secret|password=|systemctl (?:enable|start)/,
    );
  }
});
test("owner and accounts must be supplied without guessing or unsafe unit interpolation", () => {
  for (const [key, value] of [
    ["ownerId", ""],
    ["executionUser", ""],
    ["executionGroup", ""],
    ["executionUser", "root\nExecStart=evil"],
    ["ownerId", "owner@example.com"],
  ])
    assert.throws(
      () => renderNotificationPlan({ ...profile, [key]: value }),
      /invalid_notification_plan/,
    );
  const missing = { ...profile };
  delete missing.ownerId;
  assert.throws(
    () => renderNotificationPlan(missing),
    /invalid_notification_plan/,
  );
});
test("unsupported topology and credential fields fail before any runtime is built", () => {
  for (const patch of [
    { topology: "control-plane-remote-db" },
    { topology: "" },
    { bearer: "secret" },
    { password: "secret" },
    { activation: "enabled" },
    { version: 2 },
  ])
    assert.throws(
      () => renderNotificationPlan({ ...profile, ...patch }),
      /invalid_notification_plan/,
    );
});
test("paths and HTTPS auth origins cannot introduce traversal, shell syntax or port 3001", () => {
  for (const patch of [
    { controlFile: "/tmp/../etc/control" },
    { manifestRoot: "/var/lib/jgw;evil" },
    { authOrigin: "http://jauth.jgw.test" },
    { authOrigin: "https://jauth.jgw.test:3001" },
    { authOrigin: "https://user:pass@jauth.jgw.test" },
    { authOrigin: "https://jauth.jgw.test/path" },
  ])
    assert.throws(
      () => renderNotificationPlan({ ...profile, ...patch }),
      /invalid_notification_plan/,
    );
});
test("input controls cannot overlap the writable manifest or deployed bundle", () => {
  for (const patch of [
    { controlFile: profile.manifestRoot + "/control.json" },
    { credentialsFile: profile.bundleRoot + "/secret.json" },
    { credentialsFile: profile.caFile },
  ])
    assert.throws(
      () => renderNotificationPlan({ ...profile, ...patch }),
      /invalid_notification_plan/,
    );
});
test("private canonical CLI input renders reviewable units and leaves every runtime inactive", async () => {
  const root = await mkdtemp(tmpdir() + "/notification-plan-cli-");
  try {
    const file = root + "/profile.json";
    await writeFile(file, JSON.stringify(profile) + "\n", { mode: 0o600 });
    const result = JSON.parse(
      await execute(process.execPath, [
        "deploy/agent/notification-plan.mjs",
        "--profile",
        file,
        "--print-plan",
      ]),
    );
    assert.equal(result.ownerId, profile.ownerId);
    assert.equal(result.activation, "pending");
    assert.equal(result.acceptance_complete, false);
    assert.equal(result.service, renderNotificationPlan(profile).service);
    const validated = JSON.parse(
      await execute(process.execPath, [
        "deploy/agent/notification-plan.mjs",
        "--profile",
        file,
        "--validate-only",
      ]),
    );
    assert.equal(validated.phase, "notification_plan_validated");
    assert.equal(await readFile(file, "utf8"), JSON.stringify(profile) + "\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
