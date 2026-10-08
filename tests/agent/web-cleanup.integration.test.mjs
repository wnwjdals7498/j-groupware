import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hostingRuntime } from "/workspace/j-web/tests/hosting/runtime.mjs";
import { WebServiceCleanup } from "../../deploy/agent/web-cleanup.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";

let fixture;
const id = randomUUID(),
  account = "jw-" + randomBytes(6).toString("hex"),
  password = randomBytes(24).toString("base64url");
before(async () => {
  if (process.env.JGW_AGENT_TEST_RUNTIME !== "isolated-cloud")
    throw new Error("Explicit isolated root helper test required; no skip.");
  fixture = await hostingRuntime("agent-web-cleanup");
  await execute("docker", [
    "cp",
    "/workspace/j-groupware/deploy/agent/provision-error.mjs",
    fixture.container + ":/run/provision-error.mjs",
  ]);
  await execute("docker", [
    "cp",
    "/workspace/j-groupware/deploy/agent/web-cleanup.mjs",
    fixture.container + ":/run/web-cleanup.mjs",
  ]);
  await fixture.exec([
    "chown",
    "root:root",
    "/run/provision-error.mjs",
    "/run/web-cleanup.mjs",
  ]);
  await fixture.exec([
    "chmod",
    "0600",
    "/run/provision-error.mjs",
    "/run/web-cleanup.mjs",
  ]);
});
after(async () => {
  await fixture?.close();
});
const run = async () =>
  JSON.parse(
    (
      await fixture.exec([
        "/usr/bin/node",
        "--input-type=module",
        "-e",
        "import {WebServiceCleanup} from '/run/web-cleanup.mjs'; process.env.NODE_OPTIONS='--import=/run/malicious.mjs'; process.stdout.write(JSON.stringify(await new WebServiceCleanup().run('j-web')));",
      ])
    ).output,
  );
test("requires root and a fixed managed Web helper and refuses unrelated cleanup before OS work", async () => {
  await assert.rejects(new WebServiceCleanup().run("j-mail"), {
    code: "cleanup_adapter_unbound",
  });
  await assert.rejects(new WebServiceCleanup().run("j-web"), {
    code: "root_required",
  });
  await fixture.exec(["chmod", "0777", "/usr/local/sbin/jweb-helper"]);
  try {
    const result = await fixture.exec([
      "/usr/bin/node",
      "--input-type=module",
      "-e",
      "import {WebServiceCleanup} from '/run/web-cleanup.mjs'; try {await new WebServiceCleanup().run('j-web'); process.exit(1);} catch(e) {process.stdout.write(e.code);}",
    ]);
    assert.equal(result.output, "unsafe_web_helper");
  } finally {
    await fixture.exec(["chmod", "0555", "/usr/local/sbin/jweb-helper"]);
  }
});
test("removes real fixture accounts and site routes through the installer adapter, preserves manual files in private backups, gateway and idempotence", async () => {
  assert.equal(
    (
      await fixture.helper("site-create", {
        siteId: id,
        domain: "agent-cleanup.jgw.test",
      })
    ).ok,
    true,
  );
  assert.equal(
    (await fixture.helper("account-create", { siteId: id, account, password }))
      .ok,
    true,
  );
  assert.equal((await fixture.helper("nginx-apply", { siteId: id })).ok, true);
  await fixture.protocols({
    action: "ftps-upload",
    account,
    password,
    name: "manual.txt",
    data: "manual-upload-backup-proof",
  });
  await fixture.exec([
    "/usr/bin/node",
    "-e",
    "require('fs').writeFileSync('/run/malicious.mjs',\"import {writeFileSync} from 'node:fs'; writeFileSync('/run/loader-injected','unsafe');\")",
  ]);
  assert.deepEqual(await run(), { service: "j-web", removed: 1 });
  const state = JSON.parse(
    (await fixture.exec(["cat", "/var/lib/jweb/" + id + ".json"])).output,
  );
  assert.equal(
    (
      await fixture.exec([
        "cat",
        "/srv/jweb/backups/" + state.backupId + "/site/public/manual.txt",
      ])
    ).output,
    "manual-upload-backup-proof",
  );
  await fixture.protocols({ action: "ftps-deny", account, password });
  await fixture.protocols({
    action: "https",
    domain: "fixture.jgw.test",
    target: "/",
    data: "gateway-preserved",
  });
  assert.notEqual(
    (await fixture.exec(["test", "-e", "/run/loader-injected"], "", true)).code,
    0,
  );
  assert.deepEqual(await run(), { service: "j-web", removed: 0 });
});
