import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { buildProductBundle } from "../../deploy/agent/build-product-bundle.mjs";
import { ProductEnvironment } from "../../deploy/agent/product-environment.mjs";
import { ProductReadiness } from "../../deploy/agent/product-readiness.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";

let root;
const bundles = new Map(),
  children = [];
const registry = "/workspace/.suite-runtime/j-groupware/registry/user.npmrc";
const cache = "/workspace/.cloud-setup/cache/npm";
const npmCli =
  "/workspace/.cloud-setup/node22/lib/node_modules/npm/bin/npm-cli.js";
const services = [
  "j-approval",
  "j-messenger",
  "j-talk",
  "j-mail",
  "j-web",
  "j-customer-auth-db",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
before(async () => {
  if (process.env.JGW_AGENT_TEST_RUNTIME !== "isolated-cloud")
    throw new Error("Explicit isolated cold bundle tests required; no skip.");
  root = await mkdtemp(tmpdir() + "/jgw-cold-bundles-");
});
after(async () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit");
      child.kill("SIGTERM");
      await closed;
    }
  if (root) await rm(root, { recursive: true, force: true });
});
async function command(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd,
      shell: false,
      stdio: "ignore",
      env: {
        PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
        HOME: root,
        LANG: "C.UTF-8",
        NPM_CONFIG_USERCONFIG: registry,
        NPM_CONFIG_CACHE: cache,
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:4873",
      },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Cold npm startup failed."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            "Cold npm command failed; no checkout node_modules fallback.",
          ),
        );
    });
  });
}
test("produces six optional product runtime archives with native metadata, pinned lockfiles and required migration/widget/helper assets", async () => {
  for (const service of services) {
    const output = root + "/" + service + ".tar.gz";
    const result = await buildProductBundle({
      service,
      sourceRoot: "/workspace/" + service,
      output,
      npmConfig: registry,
      cache,
      npmCli,
    });
    assert.equal(result.sha256, sha256(await readFile(output)));
    assert(result.sourceFiles > 0 && result.bytes > 0);
    const entries = (await execute("/usr/bin/tar", ["-tzf", output]))
      .trim()
      .split("\n");
    assert(
      entries.every(
        (name) =>
          name.startsWith("./") &&
          !name.includes("..") &&
          !name.includes("node_modules") &&
          !/\.env(?:\/|$)/.test(name) &&
          !name.includes("apps/web") &&
          !name.includes("apps/desktop"),
      ),
    );
    const target = root + "/" + service;
    await mkdir(target);
    await execute("/usr/bin/tar", [
      "-xzf",
      output,
      "--no-same-owner",
      "-C",
      target,
    ]);
    const metadata = JSON.parse(
      await readFile(target + "/jgw-bundle.json", "utf8"),
    );
    assert.equal(metadata.profile, "suite-internal");
    assert.equal(metadata.service, service);
    assert.equal(
      metadata.entrypointSha256,
      sha256(await readFile(target + "/apps/server/dist/main.js")),
    );
    assert.equal(
      metadata.packageLockSha256,
      sha256(await readFile(target + "/package-lock.json")),
    );
    const lock = JSON.parse(
      await readFile(target + "/package-lock.json", "utf8"),
    );
    assert.equal(
      lock.packages["node_modules/@" + service + "/contracts"].link,
      true,
    );
    for (const key of ["apps/server", "packages/contracts", ""])
      assert.equal(lock.packages[key].hasInstallScript, undefined);
    const migrations = await readdir(
      target +
        (service === "j-messenger"
          ? "/deploy/postgres-migrations"
          : "/deploy/migrations"),
    );
    assert(migrations.some((file) => file.endsWith(".sql")));
    if (service === "j-talk")
      assert(
        (await readFile(target + "/apps/widget/dist/widget.min.js")).length <=
          30 * 1024,
      );
    if (service === "j-web")
      assert(
        (await readFile(target + "/deploy/jweb-helper.mjs", "utf8")).includes(
          "remove-all",
        ),
      );
    bundles.set(service, target);
    console.log(
      `Verified ${service} archive and pinned lockfile (${result.sourceFiles} runtime files).`,
    );
  }
});
test("cold npm ci resolves local contracts for all six optional products with lifecycle scripts disabled and no registry publication", async () => {
  for (const service of services) {
    const target = bundles.get(service);
    assert(target);
    await command(
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      target,
    );
    assert.equal(
      JSON.parse(
        await readFile(
          target + "/node_modules/@" + service + "/contracts/package.json",
          "utf8",
        ),
      ).name,
      "@" + service + "/contracts",
    );
    console.log(`Cold npm ci completed for ${service}.`);
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(target + "/apps/server/dist/" + (service === "j-messenger" ? "platform/config/index.js" : "config.js"))});`,
    ]);
    if (!["j-talk", "j-web"].includes(service))
      await rm(target + "/node_modules", { recursive: true });
  }
});
test("boots cold extracted Talk and Web with their actual isolated databases and serves the packaged widget", async () => {
  const auth = parseEnv(
    await readFile("/workspace/.suite-runtime/j-auth/integration.env", "utf8"),
  );
  for (const [service, prefix, port] of [
    ["j-talk", "JT", 55068],
    ["j-web", "JW", 55069],
  ]) {
    const source = parseEnv(
      await readFile(
        "/workspace/.suite-runtime/" + service + "/integration.env",
        "utf8",
      ),
    );
    if (source[prefix + "_TEST_RUNTIME"] !== "isolated-cloud")
      throw new Error("Actual isolated product DB required.");
    const adapter = new ProductEnvironment({
      tenant: "cold-bundle-fixture",
      databasePort: Number(source[prefix + "_DB_PORT"]),
      keycloakOrigin: auth.KC_PUBLIC_URL,
      profiles: {
        [service]: {
          port,
          certificate: source[prefix + "_TLS_CERTIFICATE"],
          key: source[prefix + "_TLS_KEY"],
          ca: source[prefix + "_TLS_CERTIFICATE"],
        },
      },
    });
    const env = adapter.variables(service, {
      databasePassword: source[prefix + "_DB_PASSWORD"],
      notificationKey: randomBytes(32).toString("base64url"),
    });
    const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
      cwd: bundles.get(service),
      env,
      shell: false,
      stdio: "ignore",
    });
    children.push(child);
    const readiness = new ProductReadiness({ environment: adapter });
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null)
        throw new Error("Cold extracted product failed startup.");
      if (await readiness.probe(service)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    if (service === "j-talk") {
      const { request } = await import("node:https");
      const ca = await readFile(source.JT_TLS_CERTIFICATE);
      const body = await new Promise((resolve, reject) => {
        const verified = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/ext/talk/v1/widget.min.js",
            ca,
            agent: false,
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.once("end", () => {
              if (response.statusCode === 200) resolve(Buffer.concat(chunks));
              else reject(new Error("Packaged widget unavailable."));
            });
            response.on("error", reject);
          },
        );
        verified.on("error", reject);
        verified.end();
      });
      assert(
        body.equals(
          await readFile(
            bundles.get(service) + "/apps/widget/dist/widget.min.js",
          ),
        ),
      );
    }
  }
});
test("refuses unimplemented products, existing archive overwrite and symlinked source entries without touching unrelated files", async () => {
  const base = {
    sourceRoot: "/workspace/j-talk",
    output: root + "/j-talk.tar.gz",
    npmConfig: registry,
    cache,
    npmCli,
  };
  await assert.rejects(buildProductBundle({ ...base, service: "j-auth" }), {
    code: "product_adapter_unbound",
  });
  const bytes = await readFile(base.output);
  await assert.rejects(buildProductBundle({ ...base, service: "j-talk" }), {
    code: "EEXIST",
  });
  assert((await readFile(base.output)).equals(bytes));
  const source = root + "/unsafe/j-talk";
  await mkdir(source + "/apps/server/dist", { recursive: true });
  await mkdir(source + "/packages/contracts/dist", { recursive: true });
  await writeFile(
    source + "/apps/server/package.json",
    JSON.stringify({
      name: "@j-talk/server",
      version: "0.1.0",
      type: "module",
      dependencies: { "@j-talk/contracts": "0.1.0" },
    }),
  );
  await writeFile(
    source + "/packages/contracts/package.json",
    JSON.stringify({
      name: "@j-talk/contracts",
      version: "0.1.0",
      type: "module",
    }),
  );
  const preserved = root + "/preserved";
  await writeFile(preserved, "preserve");
  await symlink(preserved, source + "/apps/server/dist/main.js");
  await assert.rejects(
    buildProductBundle({
      ...base,
      sourceRoot: source,
      output: root + "/unsafe.tar.gz",
      service: "j-talk",
    }),
    { code: "unsafe_bundle_input" },
  );
  assert.equal(await readFile(preserved, "utf8"), "preserve");
});
