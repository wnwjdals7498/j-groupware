// Executed only inside the explicit root container by storage.integration.
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  readFile,
  lstat,
  chmod,
  chown,
  cp,
  rm,
  symlink,
  link,
  readdir,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { NativeServiceAccounts } from "../../deploy/agent/native-accounts.mjs";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createConnection } from "node:net";
import {
  ProductStorage,
  storageAccount,
} from "../../deploy/agent/product-storage.mjs";
import { MailpitPlatform } from "../../deploy/agent/mailpit-platform.mjs";
import {
  loadProvisionServiceControl,
  createProvisionServiceRuntime,
  parseProvisionServiceArguments,
} from "../../deploy/agent/provision-service.mjs";
import {
  loadBootstrapRuntimeControl,
  createBootstrapRuntime,
  runBootstrapCli,
} from "../../deploy/agent/bootstrap-runtime.mjs";
const [mode, base, tenant, smtpText, httpText] = process.argv.slice(2);
const smtp = Number(smtpText),
  http = Number(httpText);
const mailpit = new MailpitPlatform({
  tenant,
  dataRoot: base + "/allocated/mail/data",
  environmentRoot: base + "/control/mailpit",
  smtpPort: smtp,
  httpPort: http,
});
async function stopped(service) {
  if (service === "j-mail") return (await mailpit.inspect())?.running !== true;
  try {
    const pid = (await readFile(base + "/control/writer", "utf8")).trim();
    return (
      (await readFile("/proc/" + pid + "/stat", "utf8")).split(" ")[2] === "Z"
    );
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return true;
    throw error;
  }
}
const profiles = {
  "j-messenger": {
    root: base + "/allocated/messenger",
    maxBytes: 8 * 1024 * 1024,
    maxEntries: 100,
  },
  "j-mail": {
    root: base + "/allocated/mail",
    maxBytes: 8 * 1024 * 1024,
    maxEntries: 100,
  },
};
const storage = new ProductStorage({
  tenant,
  stateRoot: base + "/control/storage",
  backupRoot: base + "/backups",
  profiles,
  stopped,
  mailpit,
});
async function send() {
  const socket = createConnection({ host: "127.0.0.1", port: smtp });
  let buffer = "",
    pending,
    rejectWaiting;
  const lines = [];
  socket.on("data", (data) => {
    buffer += data;
    let position;
    while ((position = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, position).trimEnd();
      buffer = buffer.slice(position + 1);
      if (pending) {
        const resolve = pending;
        pending = undefined;
        rejectWaiting = undefined;
        resolve(line);
      } else lines.push(line);
    }
  });
  socket.on("error", (error) => rejectWaiting?.(error));
  const next = () =>
    lines.length
      ? Promise.resolve(lines.shift())
      : new Promise((resolve, reject) => {
          pending = resolve;
          rejectWaiting = reject;
        });
  const reply = async () => {
    let line;
    do {
      line = await next();
    } while (line[3] === "-");
    return Number(line.slice(0, 3));
  };
  const command = (text) => {
    socket.write(text + "\r\n");
    return reply();
  };
  const timer = setTimeout(() => {
    rejectWaiting?.(new Error("SMTP timeout"));
    socket.destroy();
  }, 5000);
  try {
    assert.equal(await reply(), 220);
    assert.equal(await command("EHLO isolated-storage"), 250);
    assert.equal(
      await command("MAIL FROM:<sender@" + tenant + ".jgw.test>"),
      250,
    );
    assert.equal(
      await command("RCPT TO:<member@" + tenant + ".jgw.test>"),
      250,
    );
    assert.equal(await command("DATA"), 354);
    socket.write(
      "From: sender@" +
        tenant +
        ".jgw.test\r\nTo: member@" +
        tenant +
        ".jgw.test\r\nSubject: storage snapshot\r\n\r\nisolated durable body\r\n.\r\n",
    );
    assert.equal(await reply(), 250);
    assert.equal(await command("QUIT"), 221);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
async function api(route) {
  const response = await fetch("http://127.0.0.1:" + http + route, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function seed(file, value) {
  const actor = await storageAccount("j-messenger");
  await writeFile(file, value, { mode: 0o600 });
  await chown(file, actor.uid, actor.gid);
}
if (mode === "prepare") {
  await chown(base, 0, 0);
  await chmod(base, 0o711);
  await mkdir(base + "/allocated", { mode: 0o755 });
  for (const service of ["j-messenger", "j-mail"]) {
    assert.equal(await storage.preflight(service), null);
    assert.equal((await storage.prepare(service)).changed, true);
    assert.equal((await storage.prepare(service)).changed, false);
  }
  await seed(
    profiles["j-messenger"].root + "/files/attachment.bin",
    "real attachment fixture",
  );
  console.log("prepared");
} else if (mode === "messenger-permissions") {
  await writeFile(
    profiles["j-messenger"].root + "/tmp/service.tmp",
    "service writable",
    { mode: 0o600 },
  );
  await assert.rejects(
    writeFile(profiles["j-messenger"].root + "/foreign", "no"),
  );
  await assert.rejects(readFile(profiles["j-mail"].root + "/data/mailpit.db"));
  await assert.rejects(
    readFile(base + "/control/storage/j-messenger.storage.json"),
  );
  console.log("isolated");
} else if (mode === "mail-permissions") {
  await assert.rejects(
    readFile(profiles["j-messenger"].root + "/files/attachment.bin"),
  );
  await assert.rejects(storage.prepare("j-mail"), { code: "root_required" });
  console.log("isolated");
} else if (mode === "mailpit-compose") {
  const root = base + "/compose-volume";
  await mkdir(root, { mode: 0o755 });
  await chmod(root, 0o755);
  await mkdir(root + "/data", { mode: 0o700 });
  const actor = await storageAccount("j-mail");
  await chown(root + "/data", actor.uid, actor.gid);
  const composed = new MailpitPlatform({
    tenant: tenant + "-compose",
    dataRoot: root + "/data",
    environmentRoot: base + "/control/mailpit-compose",
    smtpPort: smtp,
    httpPort: http,
    compose: true,
  });
  let id;
  try {
    assert.equal((await composed.start()).changed, true);
    id = (await composed.inspect()).id;
    assert.equal((await composed.start()).changed, false);
    await composed.stop();
    assert.equal((await composed.inspect()).running, false);
    assert.equal((await composed.start()).changed, true);
    assert.equal((await composed.inspect()).id, id);
    await composed.stop();
    const marker = await readFile(composed.composeFile, "utf8");
    await writeFile(composed.composeFile, "changed");
    await assert.rejects(composed.inspect(), {
      code: "mailpit_environment_conflict",
    });
    await writeFile(composed.composeFile, marker);
    assert.equal((await composed.inspect()).id, id);
    assert((await lstat(root + "/data/mailpit.db")).isFile());
    console.log("compose-owned-capture-retained");
  } finally {
    const observed = await composed.inspect();
    if (observed) {
      await composed.stop();
      await composed.command(["container", "rm", observed.id]);
    }
  }
} else if (mode === "snapshot") {
  const actor = await storageAccount("j-messenger");
  const writer = spawn(
    "/usr/local/bin/node",
    ["-e", "setInterval(()=>{},1000)"],
    { uid: actor.uid, gid: actor.gid, detached: true, stdio: "ignore" },
  );
  writer.unref();
  await writeFile(base + "/control/writer", String(writer.pid), {
    mode: 0o600,
  });
  await assert.rejects(
    storage.run("j-messenger", { databaseBackup: base + "/database.dump" }),
    { code: "storage_writer_active" },
  );
  process.kill(writer.pid, "SIGTERM");
  for (let i = 0; i < 50 && !(await stopped("j-messenger")); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await stopped("j-messenger"), true);
  const file = profiles["j-messenger"].root + "/files/attachment.bin";
  await symlink(file, profiles["j-messenger"].root + "/files/link");
  await assert.rejects(storage.run("j-messenger"), {
    code: "unsafe_storage_file",
  });
  await rm(profiles["j-messenger"].root + "/files/link");
  await link(file, profiles["j-messenger"].root + "/files/hard");
  await assert.rejects(storage.run("j-messenger"), {
    code: "unsafe_storage_file",
  });
  await rm(profiles["j-messenger"].root + "/files/hard");
  const constrained = new ProductStorage({
    tenant,
    stateRoot: base + "/control/storage",
    backupRoot: base + "/backups",
    stopped,
    profiles: { "j-messenger": { ...profiles["j-messenger"], maxBytes: 1 } },
  });
  await assert.rejects(constrained.run("j-messenger"));
  assert.equal((await readdir(base + "/backups")).length, 0);
  const ms = await storage.run("j-messenger", {
    databaseBackup: base + "/database.dump",
  });
  assert.equal(ms.data, "retained");
  assert.equal(ms.files, 1);
  assert.equal((await lstat(profiles["j-messenger"].root)).mode & 0o777, 0o700);
  assert.equal(
    (
      await storage.run("j-messenger", {
        databaseBackup: base + "/database.dump",
      })
    ).storageBackup,
    ms.storageBackup,
  );
  await assert.rejects(storage.prepare("j-messenger"), {
    code: "retained_storage_requires_review",
  });
  const saved = ms.storageBackup + "/files/files/attachment.bin";
  const original = await readFile(saved);
  await writeFile(saved, "tamper");
  await assert.rejects(
    storage.verify("j-messenger", ms.storageBackup, base + "/database.dump"),
    { code: "storage_backup_corrupt" },
  );
  await writeFile(saved, original);
  await writeFile(ms.storageBackup + "/foreign", "preserve");
  await assert.rejects(
    storage.run("j-messenger", { databaseBackup: base + "/database.dump" }),
  );
  assert.equal(
    await readFile(ms.storageBackup + "/foreign", "utf8"),
    "preserve",
  );
  await rm(ms.storageBackup + "/foreign");
  await storage.verify(
    "j-messenger",
    ms.storageBackup,
    base + "/database.dump",
  );
  assert.equal((await mailpit.start()).changed, true);
  assert.equal((await mailpit.start()).changed, false);
  await send();
  const list = await api("/api/v1/messages");
  assert.equal(list.total, 1);
  const mail = await api("/api/v1/message/" + list.messages[0].ID);
  const captured = { id: mail.ID, subject: mail.Subject, text: mail.Text };
  const restarted = new ProductStorage({
    tenant,
    stateRoot: base + "/control/storage",
    backupRoot: base + "/backups",
    profiles,
    mailpit,
    stopped: async () => {
      await mailpit.start();
      return true;
    },
  });
  await assert.rejects(
    restarted.run("j-mail", { databaseBackup: base + "/database.dump" }),
    { code: "mailpit_writer_active" },
  );
  const snap = await storage.run("j-mail", {
    databaseBackup: base + "/database.dump",
  });
  assert.equal((await mailpit.inspect()).running, false);
  assert.equal(snap.data, "retained");
  assert(snap.files >= 1);
  assert.equal(
    (await storage.run("j-mail", { databaseBackup: base + "/database.dump" }))
      .storageBackup,
    snap.storageBackup,
  );
  await writeFile(
    base + "/control/captured.json",
    JSON.stringify(captured) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    base + "/control/results.json",
    JSON.stringify({ ms, mail: snap }) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ ms, mail: snap }));
} else if (mode === "retained-permissions") {
  await assert.rejects(
    readFile(profiles["j-messenger"].root + "/files/attachment.bin"),
  );
  await assert.rejects(readFile(profiles["j-mail"].root + "/data/mailpit.db"));
  await assert.rejects(readFile(base + "/database.dump"));
  console.log("retained-private");
} else if (mode === "restore") {
  const result = JSON.parse(
    await readFile(base + "/control/results.json", "utf8"),
  );
  const saved = JSON.parse(
    await readFile(base + "/control/captured.json", "utf8"),
  );
  const actor = await storageAccount("j-mail");
  await mkdir(base + "/restore", { mode: 0o711 });
  await cp(result.mail.storageBackup + "/files/data", base + "/restore/data", {
    recursive: true,
  });
  execFileSync("/usr/bin/chown", [
    "-R",
    actor.uid + ":" + actor.gid,
    base + "/restore/data",
  ]);
  const restored = new MailpitPlatform({
    tenant,
    dataRoot: base + "/restore/data",
    environmentRoot: base + "/control/mailpit",
    smtpPort: smtp,
    httpPort: http,
  });
  await restored.start();
  const mail = await api("/api/v1/message/" + saved.id);
  assert.equal(mail.ID, saved.id);
  assert.equal(mail.Subject, saved.subject);
  assert.equal(mail.Text, saved.text);
  await restored.stop();
  assert.equal(
    await readFile(
      result.ms.storageBackup + "/files/files/attachment.bin",
      "utf8",
    ),
    "real attachment fixture",
  );
  console.log("sqlite-and-files-restored");
} else if (mode === "native-control") {
  const json = (file, value) =>
    writeFile(file, JSON.stringify(value) + "\n", { mode: 0o600 });
  const bootstrapRoot = base + "/bootstrap";
  await mkdir(bootstrapRoot, { mode: 0o700 });
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      bootstrapRoot + "/fixture-ca.key",
      "-out",
      bootstrapRoot + "/auth-ca.crt",
      "-subj",
      "/CN=Isolated Native Fixture",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  await chmod(bootstrapRoot + "/fixture-ca.key", 0o600);
  await chmod(bootstrapRoot + "/auth-ca.crt", 0o600);
  const ca = new X509Certificate(
    await readFile(bootstrapRoot + "/auth-ca.crt"),
  );
  const credential = () => randomBytes(32).toString("base64url");
  const token = credential();
  await writeFile(
    bootstrapRoot + "/bootstrap.env",
    "JGW_TENANT=" +
      tenant +
      "\nKC_PUBLIC_URL=https://auth.jgw.test\nJGW_CONSOLE_ORIGIN=https://console.jgw.test\nJGW_OIDC_CLIENT_SECRET=" +
      credential() +
      "\nJGW_AUTH_SERVICE_KEY=" +
      credential() +
      "\nJGW_AGENT_KEY=" +
      credential() +
      "\n",
    { mode: 0o600 },
  );
  await mkdir(bootstrapRoot + "/bundles", { mode: 0o700 });
  await writeFile(
    bootstrapRoot + "/bundles/j-groupware.tgz",
    "inert fixture archive",
    { mode: 0o600 },
  );
  await json(bootstrapRoot + "/bootstrap.json", {
    tenant,
    phase: "prepared",
    caFingerprint: ca.fingerprint256,
    bundles: [
      {
        service: "j-groupware",
        digest: createHash("sha256")
          .update("inert fixture archive")
          .digest("hex"),
      },
    ],
  });
  const certificate = bootstrapRoot + "/auth-ca.crt",
    key = bootstrapRoot + "/fixture-ca.key";
  const roots = {
    bundleRoot: base + "/native/bundles",
    environmentRoot: base + "/native/environment",
    unitRoot: base + "/native/units",
    stateRoot: base + "/native/state",
    lockRoot: base + "/native/lock",
    databaseBackupRoot: base + "/native/pg-backups",
    storageStateRoot: base + "/control/storage",
    storageBackupRoot: base + "/backups",
    gatewayRoot: base + "/native/gateway",
  };
  const productProfileFile = base + "/control/products.json",
    postgresFile = base + "/control/postgres.json";
  const passFile = base + "/control/pgpass",
    gatewayProfileFile = base + "/control/gateway.json",
    controlFile = base + "/control/native.json";
  await json(productProfileFile, {
    databasePort: 5432,
    profiles: {
      "j-messenger": {
        port: 55013,
        certificate,
        key,
        ca: certificate,
        dataRoot: profiles["j-messenger"].root,
      },
      "j-customer-auth-db": {
        port: 55012,
        certificate,
        key,
        ca: certificate,
        guestSigningKey: base + "/guest.key",
        publicOrigin: "https://gw." + tenant + ".jgw.test",
      },
    },
  });
  await writeFile(passFile, "127.0.0.1:5432:*:postgres:" + token + "\n", {
    mode: 0o600,
  });
  await json(postgresFile, {
    host: "127.0.0.1",
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: token,
    passFile,
  });
  await json(gatewayProfileFile, {
    JGW_TENANT: tenant,
    JGW_GATEWAY_ALLOWED_TENANTS: tenant,
    JGW_TLS_CERTIFICATE: certificate,
    JGW_TLS_KEY: key,
    JGW_GATEWAY_UPSTREAM_CA: certificate,
    JGW_PORT: "55011",
    JCADB_INTERNAL_PORT: "55012",
    JCADB_INTERNAL_PROTOCOL: "https",
  });
  const control = {
    bootstrapRoot,
    productProfileFile,
    postgresFile,
    gatewayProfileFile,
    roots,
    storageProfiles: { "j-messenger": profiles["j-messenger"] },
  };
  await json(controlFile, control);
  const configuredGateway = JSON.parse(
    await readFile(gatewayProfileFile, "utf8"),
  );
  await json(gatewayProfileFile, {
    ...configuredGateway,
    JCADB_INTERNAL_PORT: "55099",
  });
  await assert.rejects(loadProvisionServiceControl(controlFile), {
    code: "invalid_installer_profile",
  });
  await json(gatewayProfileFile, configuredGateway);
  const config = await loadProvisionServiceControl(controlFile);
  const baseProfileFile = base + "/control/base-profile.json",
    bundleInstallFile = base + "/control/bundle-install.json",
    bootstrapControlFile = base + "/control/bootstrap-control.json";
  await json(baseProfileFile, {
    port: Number(configuredGateway.JGW_PORT),
    publicOrigin: `https://gw.${tenant}.jgw.test`,
    authApiOrigin: "https://jauth.jgw.test:55012",
    certificate: configuredGateway.JGW_GATEWAY_UPSTREAM_CA,
    key: configuredGateway.JGW_TLS_KEY,
  });
  await writeFile(
    base + "/control/npmrc",
    "registry=http://127.0.0.1:4873/\n",
    { mode: 0o600 },
  );
  await writeFile(
    base + "/control/npm-cli.js",
    "// inert fixture for private control validation only\n",
    { mode: 0o644 },
  );
  await json(bundleInstallFile, {
    npmConfig: base + "/control/npmrc",
    cache: base + "/npm-cache",
    npmCli: base + "/control/npm-cli.js",
  });
  await json(bootstrapControlFile, {
    installerControlFile: controlFile,
    baseProfileFile,
    bundleInstallFile,
  });
  const bootstrapConfig =
    await loadBootstrapRuntimeControl(bootstrapControlFile);
  const baseRuntime = createBootstrapRuntime(bootstrapConfig);
  await baseRuntime.close();
  await assert.rejects(runBootstrapCli(["--config", bootstrapControlFile]), {
    code: "invalid_bootstrap_arguments",
  });
  await json(bootstrapControlFile, {
    installerControlFile: controlFile,
    baseProfileFile,
    bundleInstallFile,
    enableTimer: true,
  });
  await assert.rejects(loadBootstrapRuntimeControl(bootstrapControlFile), {
    code: "invalid_bootstrap_control",
  });
  assert.throws(
    () =>
      createProvisionServiceRuntime(config, {
        notificationBinding: { tenant, root: base + "/foreign-manifest" },
      }),
    { code: "invalid_notification_binding" },
  );
  const runtime = createProvisionServiceRuntime(config);
  try {
    for (const service of ["j-talk", "j-mail", "j-approval"])
      await assert.rejects(runtime.run(service), {
        code: "notification_operating_owner_unbound",
      });
    await assert.rejects(runtime.run("j-web"), {
      code: "web_native_installation_unbound",
    });
    await assert.rejects(lstat(roots.stateRoot), { code: "ENOENT" });
    await assert.rejects(lstat(roots.lockRoot), { code: "ENOENT" });
    await assert.rejects(lstat(roots.environmentRoot), { code: "ENOENT" });
    await assert.rejects(lstat(roots.gatewayRoot), { code: "ENOENT" });
    assert.throws(() =>
      parseProvisionServiceArguments(["j-talk", "--remove", "--purge"]),
    );
    assert.throws(() => parseProvisionServiceArguments(["j-groupware"]));
    assert.deepEqual(
      parseProvisionServiceArguments(["j-messenger", "--remove"]),
      { service: "j-messenger", kind: "remove" },
    );
  } finally {
    await runtime.close();
  }
  await chmod(controlFile, 0o644);
  await assert.rejects(loadProvisionServiceControl(controlFile), {
    code: "unsafe_control_file",
  });
  await chmod(controlFile, 0o600);
  await json(controlFile, { ...control, arbitraryInstaller: "/untrusted" });
  await assert.rejects(loadProvisionServiceControl(controlFile), {
    code: "invalid_installer_control",
  });
  await json(controlFile, control);
  assert.throws(
    () =>
      execFileSync(
        "/usr/local/bin/node",
        ["/opt/jgw/test-agent/deploy/agent/provision-service.mjs", "j-talk"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    (error) =>
      error.status === 1 &&
      error.stderr === "notification_operating_owner_unbound\n",
  );
  await mkdir("/opt/jgw/bundles", { recursive: true, mode: 0o755 });
  await cp("/opt/jgw/test-agent", "/opt/jgw/bundles/j-groupware", {
    recursive: true,
  });
  assert.throws(
    () =>
      execFileSync(
        "/usr/local/bin/node",
        ["/opt/jgw/bundles/j-groupware/deploy/provision-service", "j-mail"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    (error) =>
      error.status === 1 &&
      error.stderr === "notification_operating_owner_unbound\n",
  );
  assert.throws(
    () =>
      execFileSync(
        "/usr/local/bin/node",
        ["/opt/jgw/bundles/j-groupware/deploy/bootstrap", "--extra"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    (error) =>
      error.status === 1 && error.stderr === "invalid_bootstrap_arguments\n",
  );
  const { prepareProvisionAgent, activatePreparedProvisionAgent } =
    await import("../../deploy/agent/agent-install.mjs");
  const agentOptions = {
    bootstrapRoot: control.bootstrapRoot,
    productProfileFile: control.productProfileFile,
    bundleRoot: roots.bundleRoot,
    stateRoot: roots.stateRoot,
    lockRoot: roots.lockRoot,
    controlRoot: base + "/control/agent",
    unitRoot: roots.unitRoot,
  };
  process.umask(0o077);
  const prepared = await prepareProvisionAgent(agentOptions);
  assert.equal(prepared.phase, "agent_prepared");
  assert.equal(
    JSON.parse(
      await readFile(agentOptions.controlRoot + "/control.json", "utf8"),
    ).lockRoot,
    roots.lockRoot + "-agent",
  );
  assert.equal(prepared.activation, "pending");
  assert.equal(
    (await prepareProvisionAgent(agentOptions)).phase,
    "agent_prepared",
  );
  const timer = await readFile(
    roots.unitRoot + "/jgw-provision-agent.timer",
    "utf8",
  );
  assert(timer.includes("OnUnitActiveSec=60s"));
  assert.equal(
    (await lstat(agentOptions.controlRoot + "/control.json")).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    activatePreparedProvisionAgent(agentOptions.controlRoot),
    { code: "invalid_agent_installation" },
  );
  const { OsBootstrap, OS_REQUIRED_PACKAGES } =
    await import("../../deploy/agent/os-bootstrap.mjs");
  const { installationDigest } =
    await import("../../deploy/agent/install-files.mjs");
  const packages = [];
  for (const name of OS_REQUIRED_PACKAGES) {
    const packageRoot = base + "/deb-fixture/" + name;
    await mkdir(packageRoot + "/DEBIAN", { recursive: true, mode: 0o755 });
    await writeFile(
      packageRoot + "/DEBIAN/control",
      "Package: " +
        name +
        "\nVersion: 0.0.1\nArchitecture: all\nMaintainer: Isolated Fixture <fixture@example.invalid>\nDescription: Metadata validation fixture only; never installed.\n",
      { mode: 0o644 },
    );
    await chmod(packageRoot + "/DEBIAN", 0o755);
    await chmod(packageRoot + "/DEBIAN/control", 0o644);
    const file = base + "/deb-fixture/" + name + ".deb";
    execFileSync("/usr/bin/dpkg-deb", ["--build", packageRoot, file], {
      stdio: "ignore",
    });
    packages.push({
      name,
      version: "0.0.1",
      architecture: "all",
      sha256: installationDigest(await readFile(file)),
      file,
    });
  }
  const passwordFile = base + "/control/postgres-password";
  await writeFile(passwordFile, "A".repeat(43) + "\n", { mode: 0o600 });
  const osProfile = {
    packages,
    node: {
      file: "/usr/local/bin/node",
      version: process.version,
      sha256: installationDigest(await readFile("/usr/local/bin/node")),
    },
    caFile: config.bootstrap.ca,
    postgres: {
      image: "postgres:18.6-bookworm@sha256:" + "1".repeat(64),
      dataRoot: base + "/os-data",
      port: 55177,
      passwordFile,
    },
  };
  const osOptions = {
    tenant,
    profile: osProfile,
    stateRoot: base + "/os-state",
    unitRoot: base + "/os-units",
  };
  await assert.rejects(
    new OsBootstrap({
      ...osOptions,
      profile: {
        ...osProfile,
        packages: packages.map((row, index) =>
          index ? row : { ...row, sha256: "0".repeat(64) },
        ),
      },
    }).prepare(),
    { code: "os_artifact_mismatch" },
  );
  await assert.rejects(lstat(osOptions.stateRoot), { code: "ENOENT" });
  const osAdapter = new OsBootstrap(osOptions);
  assert.equal((await osAdapter.prepare()).phase, "os_prepared");
  await osAdapter.requirePrepared();
  assert.equal((await osAdapter.prepare()).activation, "pending");
  const pgUnit = await readFile(
    osOptions.unitRoot + "/jgw-postgres.service",
    "utf8",
  );
  assert(
    pgUnit.includes("--pull never") &&
      !pgUnit.includes("down") &&
      !pgUnit.includes("--volumes"),
  );
  assert.equal(
    (await lstat(osOptions.stateRoot + "/compose.json")).mode & 0o777,
    0o600,
  );
  await assert.rejects(osAdapter.applyPackages(), {
    code: "invalid_activation_target",
  });
  await assert.rejects(osAdapter.startPostgres(), {
    code: "invalid_activation_target",
  });
  const originalProducts = JSON.parse(
    await readFile(productProfileFile, "utf8"),
  );
  const nativeBindingsFile = base + "/control/native-bindings.json";
  const mailProducts = {
    ...originalProducts,
    profiles: {
      ...originalProducts.profiles,
      "j-mail": {
        port: 55173,
        certificate,
        key,
        ca: certificate,
        dataRoot: profiles["j-mail"].root,
        mailpitOrigin: "http://127.0.0.1:" + http,
      },
    },
  };
  await json(productProfileFile, mailProducts);
  await json(nativeBindingsFile, {
    mailpit: { smtpPort: smtp, httpPort: http },
  });
  await json(controlFile, {
    ...control,
    nativeBindingsFile,
    storageProfiles: profiles,
  });
  const configuredMail = await loadProvisionServiceControl(controlFile);
  const mailRuntime = createProvisionServiceRuntime(configuredMail);
  try {
    await assert.rejects(mailRuntime.run("j-mail"), {
      code: "notification_operating_owner_unbound",
    });
  } finally {
    await mailRuntime.close();
  }
  await assert.rejects(lstat(roots.environmentRoot), { code: "ENOENT" });
  await json(nativeBindingsFile, {
    mailpit: { smtpPort: 3001, httpPort: http },
  });
  await assert.rejects(loadProvisionServiceControl(controlFile), {
    code: "invalid_mailpit_profile",
  });
  await json(productProfileFile, originalProducts);
  await json(controlFile, control);
  console.log("native-inert-and-guarded");
} else if (mode === "native-denied") {
  await assert.rejects(
    loadProvisionServiceControl(base + "/control/native.json"),
    { code: "root_required" },
  );
  console.log("native-root-required");
} else if (mode === "accounts") {
  const root = base + "/control/accounts";
  await mkdir(root, { mode: 0o700 });
  let isStopped = false;
  const accounts = new NativeServiceAccounts({
    root,
    stopped: async () => isStopped,
  });
  await assert.rejects(lstat(root + "/j-customer-auth-db.account.json"), {
    code: "ENOENT",
  });
  const identity = await accounts.ensure("j-customer-auth-db");
  assert.deepEqual(await accounts.ensure("j-customer-auth-db"), identity);
  const retained = base + "/control/account-retained.bin";
  await writeFile(retained, "private retained bytes", { mode: 0o600 });
  await chown(retained, identity.uid, identity.gid);
  await assert.rejects(accounts.remove("j-customer-auth-db"), {
    code: "account_writer_active",
  });
  isStopped = true;
  const child = spawn(
    "/usr/sbin/runuser",
    ["-u", "jgw-customer-auth-db", "--", "/bin/sleep", "30"],
    { detached: true, stdio: "ignore" },
  );
  try {
    let active = false;
    for (let i = 0; i < 50; i++) {
      try {
        execFileSync("/usr/bin/pgrep", ["-u", String(identity.uid)], {
          stdio: "ignore",
        });
        active = true;
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(active);
    await assert.rejects(accounts.remove("j-customer-auth-db"), {
      code: "account_processes_active",
    });
  } finally {
    // Kill the service child first so runuser reaps it; a sleep PID1 does not reap orphan zombies.
    const ended = once(child, "exit");
    for (const pid of execFileSync(
      "/usr/bin/pgrep",
      ["-u", String(identity.uid)],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n"))
      process.kill(Number(pid), "SIGTERM");
    await ended;
  }
  execFileSync("/usr/sbin/usermod", [
    "--home",
    "/foreign",
    "jgw-customer-auth-db",
  ]);
  await assert.rejects(accounts.remove("j-customer-auth-db"), {
    code: "unmanaged_service_account",
  });
  execFileSync("/usr/sbin/usermod", [
    "--home",
    "/var/lib/jgw-customer-auth-db",
    "jgw-customer-auth-db",
  ]);
  execFileSync("/usr/sbin/useradd", [
    "--system",
    "--non-unique",
    "--uid",
    String(identity.uid),
    "--gid",
    String(identity.gid),
    "--no-create-home",
    "--shell",
    "/usr/sbin/nologin",
    "jgw-test-alias",
  ]);
  await assert.rejects(accounts.remove("j-customer-auth-db"), {
    code: "shared_service_identity",
  });
  execFileSync("/usr/sbin/userdel", ["--", "jgw-test-alias"]);
  const receipt = await accounts.read("j-customer-auth-db");
  await accounts.write("j-customer-auth-db", { ...receipt, phase: "removing" });
  execFileSync("/usr/sbin/userdel", ["--", "jgw-customer-auth-db"]);
  assert.deepEqual(await accounts.remove("j-customer-auth-db"), {
    account: "removed",
  });
  assert.deepEqual(await accounts.remove("j-customer-auth-db"), {
    account: "removed",
  });
  assert.equal(await readFile(retained, "utf8"), "private retained bytes");
  assert.equal((await lstat(retained)).uid, identity.uid);
  await assert.rejects(accounts.ensure("j-customer-auth-db"), {
    code: "removed_account_requires_review",
  });
  const approval = await accounts.ensure("j-approval");
  assert.deepEqual(await accounts.remove("j-approval"), { account: "removed" });
  assert(approval.uid > 0);
  assert.throws(() =>
    execFileSync("/usr/bin/getent", ["passwd", "jgw-approval"], {
      stdio: "ignore",
    }),
  );
  execFileSync("/usr/sbin/useradd", [
    "--system",
    "--user-group",
    "--no-create-home",
    "--home-dir",
    "/var/lib/jgw-talk",
    "--shell",
    "/usr/sbin/nologin",
    "jgw-talk",
  ]);
  await assert.rejects(accounts.ensure("j-talk"), {
    code: "unmanaged_service_account",
  });
  await assert.rejects(accounts.remove("j-talk"), {
    code: "unmanaged_service_account",
  });
  assert(
    execFileSync("/usr/bin/getent", ["passwd", "jgw-talk"], {
      encoding: "utf8",
    }).startsWith("jgw-talk:"),
  );
  await chmod(accounts.file("j-approval"), 0o644);
  await assert.rejects(accounts.remove("j-approval"), {
    code: "unsafe_control_file",
  });
  await chmod(accounts.file("j-approval"), 0o600);
  // Retained storage verification does not depend on the now absent writer account.
  const m = await storage.record("j-messenger");
  execFileSync("/usr/sbin/userdel", ["--", "jgw-messenger"]);
  const proof = await storage.verifyRetained("j-messenger", {
    storageBackup: m.backup,
    databaseBackup: base + "/database.dump",
  });
  assert.equal(proof.storageBackup, m.backup);
  console.log("owned-account-retry-and-retention");
} else if (mode === "foreign") {
  await assert.rejects(mailpit.stop(), { code: "unmanaged_mailpit" });
  console.log("foreign-preserved");
} else throw new Error("Unknown isolated fixture mode");
