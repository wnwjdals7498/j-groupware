import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { execute } from "../../deploy/gateway/gateway.mjs";
const invoke = promisify(execFile),
  suffix = randomUUID().slice(0, 8);
const controller = "jgw-storage-controller-" + suffix,
  pg = "jgw-storage-pg-" + suffix;
const tenant = "storage-" + suffix,
  mailName = "jgw-mailpit-" + tenant;
let base,
  smtp,
  http,
  controllerOwned = false,
  pgOwned = false,
  mailId;
const docker = async (args, options = {}) =>
  (
    await invoke("docker", args, {
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    })
  ).stdout;
async function available() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.notEqual(port, 3001);
  return port;
}
const fixture = (mode, user = "root") =>
  docker([
    "exec",
    "--user",
    user,
    controller,
    "/usr/local/bin/node",
    "/opt/jgw/test-agent/tests/agent/storage-fixture.mjs",
    mode,
    base,
    tenant,
    String(smtp),
    String(http),
  ]);
before(async () => {
  if (process.env.JGW_AGENT_TEST_RUNTIME !== "isolated-cloud")
    throw new Error("Explicit isolated container required; no skip.");
  base = await mkdtemp(tmpdir() + "/jgw-storage-");
  smtp = await available();
  http = await available();
  const source = fileURLToPath(new URL("../../", import.meta.url));
  await docker([
    "run",
    "--detach",
    "--name",
    controller,
    "--network",
    "host",
    "--mount",
    "type=bind,src=" + source + ",dst=/code,readonly",
    "--mount",
    "type=bind,src=" + process.execPath + ",dst=/test-node/node,readonly",
    "--mount",
    "type=bind,src=/usr/local/bin/docker,dst=/test-docker/docker,readonly",
    "--mount",
    "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    "--mount",
    "type=bind,src=" + base + ",dst=" + base,
    "--tmpfs",
    "/opt/jgw:rw,size=24m,mode=0755",
    "--entrypoint",
    "/bin/sleep",
    "jweb-isolated-hosting:20261008",
    "900",
  ]);
  controllerOwned = true;
  await docker([
    "exec",
    controller,
    "/test-node/node",
    "--input-type=module",
    "-e",
    "import {copyFile,chmod,mkdir,cp} from 'node:fs/promises';await copyFile('/test-node/node','/usr/local/bin/node');await chmod('/usr/local/bin/node',0o555);await copyFile('/test-docker/docker','/usr/bin/docker');await chmod('/usr/bin/docker',0o555);await mkdir('/opt/jgw/test-agent/tests/agent',{recursive:true});await cp('/code/deploy','/opt/jgw/test-agent/deploy',{recursive:true});await cp('/code/tests/agent/storage-fixture.mjs','/opt/jgw/test-agent/tests/agent/storage-fixture.mjs');await mkdir('/opt/jgw/test-agent/node_modules/@j-auth',{recursive:true});await mkdir('/opt/jgw/test-agent/node_modules/@j-mail',{recursive:true});await cp('/code/node_modules/@j-auth/contracts','/opt/jgw/test-agent/node_modules/@j-auth/contracts',{recursive:true});await cp('/code/node_modules/@j-mail/contracts','/opt/jgw/test-agent/node_modules/@j-mail/contracts',{recursive:true});for(const p of ['pg','pg-pool','pg-protocol','pg-types','pg-int8','pg-connection-string','pgpass','split2','postgres-array','postgres-bytea','postgres-date','postgres-interval','xtend','pg-cloudflare'])await cp('/code/node_modules/'+p,'/opt/jgw/test-agent/node_modules/'+p,{recursive:true});",
  ]);
  await docker([
    "exec",
    controller,
    "/usr/bin/chmod",
    "-R",
    "a+rX",
    "/opt/jgw/test-agent",
  ]);
  for (const service of ["messenger", "mail"])
    await docker([
      "exec",
      controller,
      "/usr/sbin/useradd",
      "--system",
      "--user-group",
      "--no-create-home",
      "--home-dir",
      "/var/lib/jgw-" + service,
      "--shell",
      "/usr/sbin/nologin",
      "jgw-" + service,
    ]);
  await fixture("prepare");
  await docker([
    "run",
    "--detach",
    "--user",
    "0:0",
    "--name",
    pg,
    "--env",
    "POSTGRES_PASSWORD=" + randomUUID(),
    "--tmpfs",
    "/var/lib/postgresql:rw,size=128m,mode=0755",
    "postgres:18.6",
  ]);
  pgOwned = true;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      await docker([
        "exec",
        "--user",
        "postgres",
        pg,
        "pg_isready",
        "-U",
        "postgres",
      ]);
      if (
        (await docker(["exec", pg, "/bin/cat", "/proc/1/comm"])).trim() !==
        "postgres"
      )
        throw new Error("PG initialization still running");
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) {
    const logs = await invoke("docker", ["logs", pg]);
    throw new Error(
      "Owned isolated PG failed: " +
        logs.stdout.slice(-1000) +
        logs.stderr.slice(-3000) +
        (await docker(["inspect", pg, "--format", "{{json .State}}"])),
    );
  }
  await docker([
    "exec",
    "--user",
    "postgres",
    pg,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "CREATE TABLE fixture_storage(value text NOT NULL); INSERT INTO fixture_storage VALUES('real PG archive restore');",
  ]);
  const dump = await docker(
    [
      "exec",
      "--user",
      "postgres",
      pg,
      "pg_dump",
      "-U",
      "postgres",
      "-Fc",
      "postgres",
    ],
    { encoding: "buffer" },
  );
  await execute(
    "docker",
    [
      "exec",
      "-i",
      controller,
      "/usr/local/bin/node",
      "--input-type=module",
      "-e",
      "import {writeFile} from 'node:fs/promises';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);await writeFile(" +
        JSON.stringify(base + "/database.dump") +
        ",Buffer.concat(chunks),{mode:0o600});",
    ],
    { input: dump },
  );
});
after(async () => {
  // Cleanup only containers this test created or whose exact ID it observed.
  if (mailId) await docker(["rm", "--force", mailId]);
  if (pgOwned) await docker(["rm", "--force", "--volumes", pg]);
  if (controllerOwned) {
    await docker([
      "exec",
      controller,
      "/usr/bin/chown",
      "-R",
      process.getuid() + ":" + process.getgid(),
      base,
    ]);
    await docker(["rm", "--force", "--volumes", controller]);
  }
  if (base) await rm(base, { recursive: true, force: true });
});
test("dedicated users write only owned storage; marker and foreign files remain private", async () => {
  assert.equal(
    await fixture("messenger-permissions", "jgw-messenger"),
    "isolated\n",
  );
  assert.equal(await fixture("mail-permissions", "jgw-mail"), "isolated\n");
});
test("concrete native control and factory are inert; unsupported owners, secret modes and CLI extensions fail before mutation", async () => {
  assert.equal(await fixture("native-control"), "native-inert-and-guarded\n");
  assert.equal(
    await fixture("native-denied", "jgw-mail"),
    "native-root-required\n",
  );
});
test("real stopped writer, PG archive and pinned Mailpit volume produce verified retryable private snapshots", async () => {
  let result;
  try {
    result = JSON.parse(await fixture("snapshot"));
  } catch (error) {
    const observed = (
      await docker([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--quiet",
        "--filter",
        "name=^/" + mailName + "$",
      ])
    ).trim();
    if (observed) {
      const v = JSON.parse(await docker(["inspect", observed]))[0];
      console.error(
        JSON.stringify({
          fixtureMailpit: {
            Config: v.Config,
            HostConfig: v.HostConfig,
            Mounts: v.Mounts,
            Path: v.Path,
            Args: v.Args,
            Image: v.Image,
          },
        }),
      );
    }
    throw error;
  } finally {
    mailId =
      (
        await docker([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--quiet",
          "--filter",
          "name=^/" + mailName + "$",
        ])
      ).trim() || undefined;
  }
  assert.equal(result.ms.files, 1);
  assert(result.mail.files >= 1);
  assert(mailId);
  assert.equal(
    await fixture("retained-permissions", "jgw-messenger"),
    "retained-private\n",
  );
  const dump = await docker(
    [
      "exec",
      controller,
      "/bin/cat",
      result.ms.storageBackup + "/database.dump",
    ],
    { encoding: "buffer" },
  );
  await docker([
    "exec",
    "--user",
    "postgres",
    pg,
    "createdb",
    "-U",
    "postgres",
    "fixture_restore",
  ]);
  await execute(
    "docker",
    [
      "exec",
      "--user",
      "postgres",
      "-i",
      pg,
      "pg_restore",
      "-U",
      "postgres",
      "--exit-on-error",
      "--no-owner",
      "--dbname=fixture_restore",
    ],
    { input: dump },
  );
  assert.equal(
    (
      await docker([
        "exec",
        "--user",
        "postgres",
        pg,
        "psql",
        "-U",
        "postgres",
        "-d",
        "fixture_restore",
        "-At",
        "-c",
        "SELECT value FROM fixture_storage;",
      ])
    ).trim(),
    "real PG archive restore",
  );
});
test("saved Mailpit database restores the same captured identity and body with retained Messenger bytes", async () => {
  assert(mailId);
  await docker(["rm", mailId]);
  mailId = undefined;
  try {
    assert.equal(await fixture("restore"), "sqlite-and-files-restored\n");
  } finally {
    mailId =
      (
        await docker([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--quiet",
          "--filter",
          "name=^/" + mailName + "$",
        ])
      ).trim() || undefined;
  }
});
test("an unmarked container with the tenant name is refused and preserved", async () => {
  assert(mailId);
  await docker(["rm", mailId]);
  mailId = undefined;
  mailId = (
    await docker([
      "create",
      "--name",
      mailName,
      "--entrypoint",
      "/bin/sleep",
      "jweb-isolated-hosting:20261008",
      "60",
    ])
  ).trim();
  assert.equal(await fixture("foreign"), "foreign-preserved\n");
  assert.equal(
    (await docker(["inspect", mailId, "--format", "{{.State.Status}}"])).trim(),
    "created",
  );
});
