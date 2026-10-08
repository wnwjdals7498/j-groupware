import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { Browser, integrationRuntime, required } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { BootstrapFiles } from "../../deploy/agent/bootstrap-files.mjs";
import {
  readPreparedBootstrap,
  BaseEnvironment,
} from "../../deploy/agent/base-environment.mjs";
import type { PreparedBootstrap } from "../../deploy/agent/base-environment.mjs";
import { buildProductBundle } from "../../deploy/agent/build-product-bundle.mjs";
import { BundleInstaller } from "../../deploy/agent/bundle-install.mjs";
import { ProductReadiness } from "../../deploy/agent/product-readiness.mjs";

describe("actual sealed bootstrap → safe unpack → cold HTTPS BFF with Keycloak and PostgreSQL", () => {
  let runtime: Runtime,
    root: string,
    bootstrap: PreparedBootstrap,
    environment: BaseEnvironment,
    child: ReturnType<typeof spawn>,
    browser: Browser;
  const npmConfig = "/workspace/.suite-runtime/j-groupware/registry/user.npmrc",
    cache = "/workspace/.cloud-setup/cache/npm",
    npmCli =
      "/workspace/.cloud-setup/node22/lib/node_modules/npm/bin/npm-cli.js";
  beforeAll(async () => {
    if (required("JGW_TEST_BIND_IP") === "127.0.0.1")
      throw new Error("Isolated bridge fixture required.");
    root = await mkdtemp(tmpdir() + "/jgw-base-bootstrap-");
    runtime = await integrationRuntime();
    const fixture = runtime.fixtures[0]!;
    const archive = root + "/j-groupware.tar.gz";
    const built = await buildProductBundle({
      service: "j-groupware",
      sourceRoot: fileURLToPath(new URL("../../", import.meta.url)).replace(
        /\/$/,
        "",
      ),
      output: archive,
      npmConfig,
      cache,
      npmCli,
    });
    const prepare = new BootstrapFiles(root + "/sealed");
    await prepare.prepare({
      tenant: fixture.tenant,
      clientSecret: fixture.secrets.clientSecret,
      serviceKey: fixture.secrets.serviceKey,
      agentKey: randomBytes(32).toString("base64url"),
      authOrigin: fixture.config.keycloakOrigin,
      consoleOrigin: "https://console.jgw.test:55054",
      localCa: await readFile(required("JAUTH_TLS_CERTIFICATE"), "utf8"),
      bundles: [{ service: "j-groupware", archive, digest: built.sha256 }],
    });
    bootstrap = await readPreparedBootstrap(root + "/sealed");
    const bundles = root + "/runtime";
    await mkdir(bundles, { mode: 0o755 });
    await chmod(bundles, 0o755);
    const installer = new BundleInstaller({
      root: bundles,
      npmConfig,
      cache,
      npmCli,
    });
    await installer.install(bootstrap.bundles[0]!);
    environment = new BaseEnvironment({
      bootstrap,
      databasePort: Number(required("JGW_DB_PORT")),
      port: 54233,
      publicOrigin: fixture.origin,
      authApiOrigin: fixture.memberAuth.origin,
      certificate: required("JGW_TLS_CERTIFICATE"),
      key: required("JGW_TLS_KEY"),
    });
    const secrets = {
      databasePassword: required("JGW_DB_PASSWORD"),
      notificationKey: randomBytes(32).toString("base64url"),
    };
    const text = environment.render("j-groupware", secrets);
    await writeFile(root + "/groupware.env", text, { mode: 0o600 });
    environment.read("j-groupware", text);
    const occupied = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: 54233 });
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(500, () => done(false));
    });
    if (occupied) throw new Error("Existing loopback process preserved.");
    // Only the test DNS/CA transport is loaded from the checkout. The BFF and
    // all four runtime workspaces resolve from the installed cold bundle.
    child = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(
          new URL("./resolve-messenger-test-hosts.mjs", import.meta.url),
        ),
        "apps/server/dist/main.js",
      ],
      {
        cwd: bundles + "/j-groupware",
        shell: false,
        stdio: "ignore",
        env: {
          ...parseEnv(text),
          JGW_TEST_RUNTIME: "isolated-cloud",
          JAUTH_TLS_CERTIFICATE: required("JAUTH_TLS_CERTIFICATE"),
        },
      },
    );
    const readiness = new ProductReadiness({ environment });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Cold BFF failed startup.");
      if (await readiness.probe("j-groupware")) {
        browser = new Browser(runtime.fetchLoopback, fixture.origin);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Cold BFF did not become TLS/Host verified ready.");
  });
  afterAll(async () => {
    if (child && runtime) await runtime.stop(child);
    if (runtime) await runtime.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("reads only sealed canonical private configuration and excludes agent/operator credentials from BFF env", async () => {
    const text = await readFile(root + "/groupware.env", "utf8");
    expect((await stat(root + "/groupware.env")).mode & 0o777).toBe(0o600);
    expect(text).not.toContain(bootstrap.agentKey);
    expect(text).not.toContain("JGW_AGENT_KEY");
    expect(text).not.toContain("JGW_CONSOLE_ORIGIN");
    expect(() =>
      environment.read("j-groupware", text + "NODE_OPTIONS=--inspect\n"),
    ).toThrow();
    expect(() =>
      environment.read(
        "j-groupware",
        text.replace("JGW_DB_HOST=127.0.0.1", "JGW_DB_HOST=other"),
      ),
    ).toThrow();
    const marker = JSON.parse(
      await readFile(root + "/runtime/j-groupware/.jgw-install.json", "utf8"),
    ) as { phase: string };
    expect(marker.phase).toBe("ready");
  });
  it("performs real Authorization Code login and creates/reads board data through the cold bundle", async () => {
    expect((await browser.request("/api/me")).status).toBe(401);
    await browser.login(runtime.fixtures[0]!.password);
    const me = await browser.me();
    expect(me.tenant).toBe(bootstrap.tenant);
    const created = await browser.change("/api/board/posts", {
      title: "Cold bootstrap",
      body: "Actual isolated PostgreSQL",
    });
    expect(created.status).toBe(201);
    const post = (await created.json()) as { id: string };
    expect((await browser.request("/api/board/posts/" + post.id)).status).toBe(
      200,
    );
    const other = new Browser(runtime.fetch, runtime.fixtures[1]!.origin);
    await other.login(runtime.fixtures[1]!.password);
    expect((await other.request("/api/board/posts/" + post.id)).status).toBe(
      404,
    );
  });
  it("retains CSRF, exact Host checks and opaque-cookie logout after unpacked startup", async () => {
    expect(
      (
        await browser.request("/api/board/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Denied", body: "Missing CSRF" }),
        })
      ).status,
    ).toBe(403);
    const ca = await readFile(required("JGW_TLS_CERTIFICATE"));
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: 54233,
          path: "/health/ready",
          ca,
          servername: new URL(browser.origin).hostname,
          agent: false,
          headers: { Host: "gw.other.jgw.test" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(hostStatus).toBe(400);
    expect(
      (await browser.request("/auth/logout", { method: "POST" })).status,
    ).toBe(403);
    const me = await browser.me();
    expect(
      (
        await browser.request("/auth/logout", {
          method: "POST",
          headers: { Origin: browser.origin, "x-csrf-token": me.csrfToken },
        })
      ).status,
    ).toBe(303);
    expect((await browser.request("/api/me")).status).toBe(401);
  });
  it("refuses tampered bootstrap files and unsafe listener ports without changing sealed secrets", async () => {
    const file = root + "/sealed/bootstrap.env",
      original = await readFile(file, "utf8");
    await writeFile(file, original + "JGW_TENANT=other\n");
    await expect(readPreparedBootstrap(root + "/sealed")).rejects.toThrow();
    await writeFile(file, original);
    expect((await readPreparedBootstrap(root + "/sealed")).tenant).toBe(
      bootstrap.tenant,
    );
    expect(
      () =>
        new BaseEnvironment({
          bootstrap,
          databasePort: 54232,
          port: 3001,
          publicOrigin: browser.origin,
          authApiOrigin: "https://jauth.jgw.test:54231",
          certificate: required("JGW_TLS_CERTIFICATE"),
          key: required("JGW_TLS_KEY"),
        }),
    ).toThrow();
  });
});
