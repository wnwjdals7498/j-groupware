import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  rm,
  readdir,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const auth = path.resolve(repo, "../j-auth/packages/contracts");
const image = "verdaccio/verdaccio:6.10.5";
const origin = "http://127.0.0.1:4878/";
async function run(command, args, options = {}) {
  try {
    return await execute(command, args, {
      cwd: repo,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const safe = new Error(
      `${command} failed (${error.code ?? "spawn"}); captured output withheld`,
    );
    safe.cause = error.code;
    throw safe;
  }
}
test(
  "real Compose registry publishes and consumes exact auth contracts with immutable versions",
  { timeout: 240000 },
  async () => {
    assert.equal(process.env.JGW_REGISTRY_TEST_RUNTIME, "isolated-cloud");
    const root = await mkdtemp(path.join(tmpdir(), "jgw-compose-registry-"));
    const project = "jgw-registry-test-" + randomBytes(8).toString("hex");
    const runtime = path.join(root, "runtime"),
      stage = path.join(root, "contracts"),
      consumer = path.join(root, "consumer");
    const npmrc = path.join(root, "user.npmrc"),
      empty = path.join(root, "empty.npmrc");
    const env = {
      ...process.env,
      COMPOSE_PROJECT_NAME: project,
      VERDACCIO_RUNTIME_DIR: runtime,
      VERDACCIO_HOST_PORT: "4878",
      VERDACCIO_UID: String(process.getuid()),
      VERDACCIO_GID: String(process.getgid()),
      NPM_CONFIG_CACHE: path.join(root, "cache"),
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
    };
    let started = false;
    try {
      await Promise.all([
        mkdir(runtime, { mode: 0o700 }),
        mkdir(stage),
        mkdir(consumer),
      ]);
      await writeFile(empty, "", { mode: 0o600 });
      await run("docker", ["image", "inspect", image]);
      started = true;
      await run(
        process.execPath,
        ["tools/registry/scripts/compose.mjs", "up"],
        { env },
      );
      let ready = false;
      for (let i = 0; i < 120; i++) {
        try {
          ready = (
            await fetch(origin + "-/ping", {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(ready, true, "actual Compose server must become ready");
      const raw = await run("docker", ["inspect", project + "-verdaccio-1"]);
      const [info] = JSON.parse(raw.stdout);
      assert.equal(info.Config.User, `${process.getuid()}:${process.getgid()}`);
      const bindings = info.HostConfig.PortBindings["4873/tcp"];
      assert.deepEqual(bindings, [{ HostIp: "127.0.0.1", HostPort: "4878" }]);
      const configBefore = await readFile(
        path.join(repo, "tools/registry/config.yaml"),
      );
      const username = "fixture-" + randomBytes(8).toString("hex"),
        password = randomBytes(32).toString("base64url");
      const registered = await fetch(
        origin + "-/user/org.couchdb.user:" + username,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: username,
            password,
            email: "fixture@registry.invalid",
            type: "user",
            roles: [],
          }),
        },
      );
      assert.equal(registered.status, 201);
      const credential = await registered.json();
      assert.equal(typeof credential.token, "string");
      await writeFile(
        npmrc,
        `registry=${origin}\n@j-auth:registry=${origin}\n//127.0.0.1:4878/:_authToken=${credential.token}\n`,
        { mode: 0o600 },
      );
      for (const file of ["package.json", "README.md", "CHANGELOG.md"])
        await cp(path.join(auth, file), path.join(stage, file));
      await cp(path.join(auth, "dist"), path.join(stage, "dist"), {
        recursive: true,
      });
      const npm = [
        "--userconfig",
        npmrc,
        "--cache",
        path.join(root, "cache"),
        "--registry",
        origin,
        "--workspaces=false",
        "--ignore-scripts",
      ];
      const unauth = await execute(
        "npm",
        [
          "publish",
          stage,
          "--userconfig",
          empty,
          "--registry",
          origin,
          "--workspaces=false",
          "--ignore-scripts",
        ],
        { cwd: root, env, timeout: 60000 },
      ).then(
        () => 0,
        () => 1,
      );
      assert.equal(unauth, 1);
      await run(
        process.execPath,
        [
          "scripts/registry-publish.mjs",
          "--package",
          stage,
          "--registry",
          origin,
          "--npmrc",
          npmrc,
        ],
        { env },
      );
      const metadataResponse = await fetch(
        origin + "@j-auth%2fcontracts/0.1.0",
      );
      assert.equal(metadataResponse.status, 200);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.version, "0.1.0");
      const tar = Buffer.from(
        await (await fetch(metadata.dist.tarball)).arrayBuffer(),
      );
      assert.equal(
        metadata.dist.integrity,
        "sha512-" + createHash("sha512").update(tar).digest("base64"),
      );
      await writeFile(
        path.join(consumer, "package.json"),
        JSON.stringify({
          name: "actual-auth-consumer",
          private: true,
          type: "module",
        }) + "\n",
      );
      await run("npm", ["install", "@j-auth/contracts@0.1.0", ...npm], {
        cwd: consumer,
        env,
      });
      const installed = path.join(consumer, "node_modules/@j-auth/contracts");
      assert.equal(
        JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"))
          .version,
        "0.1.0",
      );
      const lock = JSON.parse(
        await readFile(path.join(consumer, "package-lock.json"), "utf8"),
      ).packages["node_modules/@j-auth/contracts"];
      assert.equal(lock.integrity, metadata.dist.integrity);
      assert.equal(lock.resolved.startsWith(origin), true);
      const compare = async (dir) => {
        for (const entry of await readdir(path.join(auth, dir), {
          withFileTypes: true,
        })) {
          const rel = path.join(dir, entry.name);
          if (entry.isDirectory()) await compare(rel);
          else
            assert.deepEqual(
              await readFile(path.join(installed, rel)),
              await readFile(path.join(auth, rel)),
            );
        }
      };
      await compare("dist");
      const use = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import { TOKEN_POLICY, SERVICE_CATALOG } from '@j-auth/contracts'; if(TOKEN_POLICY.accessTokenTtlSeconds!==300||!SERVICE_CATALOG.some(x=>x.serviceId==='j-talk')) process.exit(1);",
        ],
        { cwd: consumer, env },
      );
      assert.equal(use.stderr, "");
      const duplicate = await execute(
        process.execPath,
        [
          path.join(repo, "scripts/registry-publish.mjs"),
          "--package",
          stage,
          "--registry",
          origin,
          "--npmrc",
          npmrc,
        ],
        { cwd: repo, env, timeout: 60000 },
      ).then(
        () => false,
        () => true,
      );
      assert.equal(duplicate, true);
      const denied = await execute(
        "npm",
        ["unpublish", "@j-auth/contracts@0.1.0", "--force", ...npm],
        { cwd: consumer, env, timeout: 60000 },
      ).then(
        () => false,
        () => true,
      );
      assert.equal(denied, true);
      assert.equal(
        (await fetch(origin + "@j-auth%2fcontracts/0.1.0")).status,
        200,
      );
      assert.deepEqual(
        await readFile(path.join(repo, "tools/registry/config.yaml")),
        configBefore,
      );
    } finally {
      if (started)
        await run(
          process.execPath,
          ["tools/registry/scripts/compose.mjs", "down"],
          { env },
        );
      await rm(root, { recursive: true, force: true });
    }
  },
);
