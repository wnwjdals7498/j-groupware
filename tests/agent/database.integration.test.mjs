import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { PostgresServiceDatabase } from "../../deploy/agent/service-database.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";
const password = randomBytes(32).toString("base64url"),
  talkPassword = randomBytes(32).toString("base64url"),
  webPassword = randomBytes(32).toString("base64url");
const name = "jgw-provision-db-" + randomUUID().slice(0, 8);
let root, admin, db, port, passfile, talk, web;
const pool = (database, secret) => {
  const value = new Pool({
    host: "127.0.0.1",
    port,
    database,
    user: database,
    password: secret,
    max: 2,
    connectionTimeoutMillis: 3000,
  });
  value.on("error", () => {});
  return value;
};
before(async () => {
  root = await mkdtemp(tmpdir() + "/jgw-provision-");
  await writeFile(
    root + "/postgres.env",
    "POSTGRES_PASSWORD=" + password + "\n",
    { mode: 0o600 },
  );
  await execute("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--env-file",
    root + "/postgres.env",
    "--tmpfs",
    "/var/lib/postgresql:rw,size=256m",
    "--publish",
    "127.0.0.1:55056:5432",
    "postgres:18.6",
  ]);
  port = Number(
    (await execute("docker", ["port", name, "5432/tcp"]))
      .trim()
      .split(":")
      .at(-1),
  );
  if (port === 3001) throw new Error("Reserved port allocated.");
  admin = new Pool({
    host: "127.0.0.1",
    port,
    database: "postgres",
    user: "postgres",
    password,
    max: 4,
    connectionTimeoutMillis: 1000,
  });
  admin.on("error", () => {});
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      await admin.query("SELECT 1");
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(ready);
  passfile = root + "/pgpass";
  await writeFile(passfile, `127.0.0.1:${port}:*:postgres:${password}\n`, {
    mode: 0o600,
  });
  await mkdir(root + "/backups", { mode: 0o700 });
  db = new PostgresServiceDatabase({
    admin,
    tenant: "agent-fixture",
    connection: () => ({ host: "127.0.0.1", port }),
    dumpBinary: "/workspace/.cloud-setup/pg18/bin/pg_dump",
    dumpEnv: {
      PGHOST: "127.0.0.1",
      PGPORT: String(port),
      PGUSER: "postgres",
      PGPASSFILE: passfile,
    },
  });
});
after(async () => {
  await talk?.end();
  await web?.end();
  await admin?.end();
  await execute("docker", ["rm", "--force", "--volumes", name]);
  await rm(root, { recursive: true, force: true });
});
test("requires prepared base, creates isolated nonsuperuser databases and preserves repeated-install credentials", async () => {
  await assert.rejects(db.ensure("j-talk", talkPassword), {
    code: "base_database_not_prepared",
  });
  await db.prepareBase();
  await db.ensure("j-talk", talkPassword);
  await db.ensure("j-web", webPassword);
  await db.ensure("j-talk", talkPassword);
  talk = pool("jgw_talk", talkPassword);
  web = pool("jgw_web", webPassword);
  const role = (
    await talk.query(
      "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert(Object.values(role).every((value) => value === false));
  await talk.query(
    "CREATE TABLE fixture_data(tenant_id text NOT NULL, value text NOT NULL)",
  );
  await talk.query(
    "INSERT INTO fixture_data VALUES ('agent-fixture','dump-byte-proof')",
  );
  await web.query("CREATE TABLE preserved(value text NOT NULL)");
  await web.query("INSERT INTO preserved VALUES ('other-service-preserved')");
  for (const database of ["postgres", "jgw_web"]) {
    const denied = pool(database, talkPassword);
    denied.options.user = "jgw_talk";
    try {
      await assert.rejects(denied.query("SELECT 1"), { code: "42501" });
    } finally {
      await denied.end();
    }
  }
  await assert.rejects(
    db.ensure("j-talk", randomBytes(32).toString("base64url")),
    { code: "service_database_login_failed" },
  );
  assert.equal(
    (await talk.query("SELECT value FROM fixture_data")).rows[0].value,
    "dump-byte-proof",
  );
});
test("does not adopt another database/role or execute injected service names", async () => {
  await admin.query("CREATE ROLE jgw_mail LOGIN");
  await assert.rejects(db.ensure("j-mail", talkPassword), {
    code: "unmanaged_role",
  });
  await assert.rejects(
    db.ensure("j-talk;DROP DATABASE jgw_web", talkPassword),
    { code: "invalid_service" },
  );
  assert.equal(
    (await web.query("SELECT value FROM preserved")).rows[0].value,
    "other-service-preserved",
  );
});
test("actual pg_dump restores committed bytes; NOLOGIN terminates owned connections and preserves another service", async () => {
  const destination = root + "/backups/talk.dump";
  await db.dump("j-talk", destination);
  assert.equal((await stat(destination)).mode & 0o077, 0);
  await admin.query("CREATE DATABASE provision_restore");
  await execute(
    "/workspace/.cloud-setup/pg18/bin/pg_restore",
    ["--no-owner", "--no-acl", "--dbname=provision_restore", destination],
    {
      env: {
        PATH: "/usr/bin:/bin",
        PGHOST: "127.0.0.1",
        PGPORT: String(port),
        PGUSER: "postgres",
        PGPASSFILE: passfile,
      },
    },
  );
  const restored = new Pool({
    ...admin.options,
    database: "provision_restore",
    password,
  });
  try {
    assert.equal(
      (await restored.query("SELECT value FROM fixture_data")).rows[0].value,
      "dump-byte-proof",
    );
  } finally {
    await restored.end();
  }
  assert(
    (await readFile(destination)).subarray(0, 5).equals(Buffer.from("PGDMP")),
  );
  await db.disable("j-talk");
  await db.disable("j-talk");
  const denied = pool("jgw_talk", talkPassword);
  try {
    await assert.rejects(denied.query("SELECT 1"));
  } finally {
    await denied.end();
  }
  assert.equal(
    (
      await admin.query(
        "SELECT rolcanlogin FROM pg_roles WHERE rolname='jgw_talk'",
      )
    ).rows[0].rolcanlogin,
    false,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='jgw_talk'",
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (await web.query("SELECT value FROM preserved")).rows[0].value,
    "other-service-preserved",
  );
  await assert.rejects(db.ensure("j-talk", talkPassword), {
    code: "disabled_database_requires_review",
  });
});
