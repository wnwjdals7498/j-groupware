import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  symlink,
  lstat,
  rm,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { integrationRuntime, required } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { digest } from "../../apps/server/src/security.js";
import { NotificationStore } from "../../apps/server/src/db/notifications.js";
import { createNotificationReceiver } from "../../apps/server/src/notification-receiver.js";
import {
  createNotificationRuntime,
  loadNotificationControl,
} from "../../deploy/agent/notification-worker.mjs";
import { loadNotificationInstallerBinding } from "../../deploy/agent/notification-binding.mjs";
import { FileSubscriptionCredentials } from "../../deploy/agent/subscription-credentials.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";

describe("explicit notification worker with external ephemeral credentials, actual auth/PG and one-shot CLI", () => {
  let rt: Runtime,
    root: string,
    token: string,
    credentialsFile: string,
    controlFile: string,
    receiverOrigin: string,
    worker: ReturnType<typeof createNotificationRuntime>,
    receiver: ReturnType<typeof createNotificationReceiver>;
  const key = randomBytes(32).toString("base64url");
  const writeCredentials = async (bearer = token) =>
    writeFile(
      credentialsFile,
      JSON.stringify({
        bearer,
        serviceKey: required("JAUTH_CONSOLE_SERVICE_KEY"),
      }) + "\n",
      { mode: 0o600 },
    );
  const state = async () =>
    (
      await rt.pool.query(
        "SELECT active,key_hashes,projection_expires_at FROM notification_services WHERE tenant_id=$1 AND service='j-mail'",
        [rt.fixtures[0]!.tenant],
      )
    ).rows[0] as {
      active: boolean;
      key_hashes: string[];
      projection_expires_at: Date;
    };
  const receive = () =>
    rt.fetchLoopback(receiverOrigin + "/internal/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-JGW-Internal-Key": key,
      },
      body: JSON.stringify({
        tenant: rt.fixtures[0]!.tenant,
        service: "j-mail",
        type: "mail.new",
        usernames: ["recipient"],
        title: "Worker fixture",
        body: "",
        link: "/mail/messages/fixture",
        dedupKey: randomUUID(),
      }),
    });
  beforeAll(async () => {
    rt = await integrationRuntime();
    root = await mkdtemp(tmpdir() + "/jgw-notification-worker-");
    const response = await rt.fetch(
      required("KC_PUBLIC_URL") +
        "/realms/operator/protocol/openid-connect/token",
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: "j-console",
          client_secret: required("JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET"),
          grant_type: "password",
          username: "op-admin",
          password: required("JGW_OPERATOR_OP_ADMIN_PASSWORD"),
          scope: "openid",
        }),
      },
    );
    if (!response.ok) throw new Error("Actual isolated operator login failed.");
    token = ((await response.json()) as { access_token: string }).access_token;
    rt.secretValues.add(token);
    rt.secretValues.add(key);
    credentialsFile = root + "/credentials.json";
    await writeCredentials();
    const databaseFile = root + "/database.json";
    await writeFile(
      databaseFile,
      JSON.stringify({
        tenant: rt.fixtures[0]!.tenant,
        port: Number(required("JGW_DB_PORT")),
        password: required("JGW_DB_PASSWORD"),
      }) + "\n",
      { mode: 0o600 },
    );
    controlFile = root + "/control.json";
    await writeFile(
      controlFile,
      JSON.stringify({
        tenant: rt.fixtures[0]!.tenant,
        authOrigin: "https://jauth.jgw.test:54231",
        caFile: required("JAUTH_TLS_CERTIFICATE"),
        credentialsFile,
        databaseFile,
        manifestRoot: root + "/manifest",
      }) + "\n",
      { mode: 0o600 },
    );
    worker = createNotificationRuntime({
      tenant: rt.fixtures[0]!.tenant,
      pool: rt.pool,
      authOrigin: "https://jauth.jgw.test:54231",
      credentialsFile,
      manifestRoot: root + "/manifest",
      fetch: rt.fetch,
    });
    receiver = createNotificationReceiver(
      new NotificationStore(rt.pool, rt.fixtures[0]!.tenant),
    );
    await receiver.listen({ host: "127.0.0.1", port: 0 });
    const address = receiver.server.address();
    if (!address || typeof address === "string" || address.port === 3001)
      throw new Error("Isolated receiver address required.");
    receiverOrigin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (receiver) await receiver.close();
    if (rt) await rt.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("construction is inert and supplied control credentials are read from a private file without caching or issuing credentials", async () => {
    expect(await worker.manifest.read()).toBeNull();
    expect(
      (
        await rt.pool.query(
          "SELECT count(*)::integer n FROM notification_projection_state WHERE tenant_id=$1",
          [rt.fixtures[0]!.tenant],
        )
      ).rows[0].n,
    ).toBe(0);
    const value = await new FileSubscriptionCredentials(credentialsFile).read();
    expect(digest(value.bearer)).toBe(digest(token));
    expect(digest(value.serviceKey)).toBe(
      digest(required("JAUTH_CONSOLE_SERVICE_KEY")),
    );
    expect((await lstat(credentialsFile)).mode & 0o777).toBe(0o600);
    expect(
      (await loadNotificationControl(controlFile)).connection,
    ).toMatchObject({
      host: "127.0.0.1",
      database: "jgw_groupware",
      user: "jgw_groupware",
    });
  });
  it("binds the existing private worker to matching BFF DB inputs and verifies actual subscriptions before installer mutation", async () => {
    const baseEnvironmentFile = root + "/base.env",
      tenant = rt.fixtures[0]!.tenant,
      port = Number(required("JGW_DB_PORT"));
    await writeFile(
      baseEnvironmentFile,
      `JGW_TENANT=${tenant}\nJAUTH_PUBLIC_URL=https://jauth.jgw.test:54231\nJGW_DB_HOST=127.0.0.1\nJGW_DB_PORT=${port}\nJGW_DB_NAME=jgw_groupware\nJGW_DB_USER=jgw_groupware\nJGW_DB_PASSWORD=${required("JGW_DB_PASSWORD")}\n`,
      { mode: 0o600 },
    );
    const input = {
      controlFile,
      tenant,
      databasePort: port,
      baseEnvironmentFile,
      authOrigin: "https://jauth.jgw.test:54231",
      fetch: rt.fetch,
    };
    await expect(
      loadNotificationInstallerBinding({
        ...input,
        tenant: rt.fixtures[1]!.tenant,
      }),
    ).rejects.toMatchObject({ code: "notification_binding_mismatch" });
    const binding = await loadNotificationInstallerBinding(input);
    try {
      expect(await worker.manifest.read()).toBeNull();
      await expect(binding.preflight("j-mail")).rejects.toMatchObject({
        code: "notification_service_inactive",
      });
      expect(await worker.manifest.read()).toBeNull();
      expect((await rt.subscribe(0, "j-mail")).status).toBe(200);
      await binding.preflight("j-mail");
      await binding.manifest.register("j-mail", key);
      expect(await state()).toMatchObject({
        active: true,
        key_hashes: [digest(key)],
      });
      expect((await receive()).status).toBe(200);
      await chmod(baseEnvironmentFile, 0o644);
      await expect(binding.preflight("j-mail")).rejects.toMatchObject({
        code: "unsafe_control_file",
      });
      await chmod(baseEnvironmentFile, 0o600);
    } finally {
      await binding.close();
    }
  });
  it("projects an actual j-auth subscription with installer hashes and accepts the real private HTTP receiver", async () => {
    expect((await rt.subscribe(0, "j-mail")).status).toBe(200);
    await worker.manifest.register("j-mail", key);
    expect(await state()).toMatchObject({
      active: true,
      key_hashes: [digest(key)],
    });
    expect((await state()).projection_expires_at.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect((await receive()).status).toBe(200);
    const text = await readFile(
      root + "/manifest/notification-keys.json",
      "utf8",
    );
    expect(
      text.includes(key) ||
        text.includes(token) ||
        text.includes(required("JAUTH_CONSOLE_SERVICE_KEY")),
    ).toBe(false);
  });
  it("expired credentials immediately deactivate the actual projection, preserve key generation and recover on a file replacement", async () => {
    const revision = (await worker.manifest.read())!.revision;
    const parts = token.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 }),
    ).toString("base64url");
    await writeCredentials(parts.join("."));
    try {
      await expect(worker.runOnce()).rejects.toThrow(
        "notification_projection_failed",
      );
      expect((await state()).active).toBe(false);
      expect((await receive()).status).toBe(403);
      expect((await worker.manifest.read())!.revision).toBe(revision);
    } finally {
      await writeCredentials();
    }
    await worker.runOnce();
    expect((await state()).active).toBe(true);
    expect((await receive()).status).toBe(200);
  });
  async function cli(args: string[]) {
    return new Promise<{ code: number | null; output: string; error: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            fileURLToPath(
              new URL("./resolve-worker-test-hosts.mjs", import.meta.url),
            ),
            fileURLToPath(
              new URL(
                "../../deploy/agent/notification-worker.mjs",
                import.meta.url,
              ),
            ),
            ...args,
          ],
          {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            shell: false,
            env: { JGW_TEST_RUNTIME: "isolated-cloud", PATH: "/usr/bin:/bin" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "",
          error = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.stdout.on("data", (bytes: Buffer) => {
          output += bytes.toString();
        });
        child.stderr.on("data", (bytes: Buffer) => {
          error += bytes.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, output, error });
        });
      },
    );
  }
  it("runs the real one-shot CLI against owned auth/PG without passing secrets in argv or inherited env", async () => {
    const result = await cli(["--config", controlFile, "--once"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      tenant: rt.fixtures[0]!.tenant,
      revision: (await worker.manifest.read())!.revision,
    });
    expect(
      [
        token,
        key,
        required("JAUTH_CONSOLE_SERVICE_KEY"),
        required("JGW_DB_PASSWORD"),
      ].some((secret) => (result.output + result.error).includes(secret)),
    ).toBe(false);
    expect((await state()).active).toBe(true);
    const denied = await cli(["--activate"]);
    expect(denied.code).toBe(1);
    expect(denied.error).toBe("invalid_notification_arguments\n");
  });
  it("refuses readable/symlinked/duplicate credential files and unrelated database configuration without creating missing parents", async () => {
    await chmod(credentialsFile, 0o644);
    await expect(
      new FileSubscriptionCredentials(credentialsFile).read(),
    ).rejects.toThrow();
    await chmod(credentialsFile, 0o600);
    const link = root + "/linked.json";
    await symlink(credentialsFile, link);
    await expect(
      new FileSubscriptionCredentials(link).read(),
    ).rejects.toThrow();
    await expect(
      new FileSubscriptionCredentials(
        root + "/missing/credentials.json",
      ).read(),
    ).rejects.toThrow();
    await expect(lstat(root + "/missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const original = await readFile(credentialsFile, "utf8");
    await writeFile(
      credentialsFile,
      original.trim().slice(0, -1) +
        ',"serviceKey":"' +
        required("JAUTH_CONSOLE_SERVICE_KEY") +
        '"}\n',
    );
    await expect(
      new FileSubscriptionCredentials(credentialsFile).read(),
    ).rejects.toThrow();
    await writeCredentials();
    const config = JSON.parse(await readFile(controlFile, "utf8")) as {
      databaseFile: string;
    };
    const dbOriginal = await readFile(config.databaseFile, "utf8");
    const db = JSON.parse(dbOriginal) as { tenant: string; port: number };
    await writeFile(
      config.databaseFile,
      JSON.stringify({ ...db, tenant: rt.fixtures[1]!.tenant }) + "\n",
    );
    await expect(loadNotificationControl(controlFile)).rejects.toThrow(
      "invalid_notification_database",
    );
    await writeFile(config.databaseFile, dbOriginal);
  });
  it("checks inactive source unit/timer syntax with the existing Node binary and never registers a timer", async () => {
    const repository = fileURLToPath(
      new URL("../../deploy/agent/", import.meta.url),
    );
    const service = (
      await readFile(
        repository + "jgw-notification-refresh.service.example",
        "utf8",
      )
    ).replace(
      "ExecStart=/usr/bin/node ",
      "ExecStart=" + process.execPath + " ",
    );
    const timer = await readFile(
      repository + "jgw-notification-refresh.timer.example",
      "utf8",
    );
    expect(timer).toContain("OnUnitInactiveSec=20s");
    expect(service).toContain("NoNewPrivileges=true");
    await writeFile(root + "/jgw-notification-refresh.service", service);
    await writeFile(root + "/jgw-notification-refresh.timer", timer);
    await execute("/usr/bin/systemd-analyze", [
      "verify",
      root + "/jgw-notification-refresh.service",
      root + "/jgw-notification-refresh.timer",
    ]);
  });
});
