import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildProductBundle } from "../../deploy/agent/build-product-bundle.mjs";
import { BundleInstaller } from "../../deploy/agent/bundle-install.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";

const npmConfig = "/workspace/.suite-runtime/j-groupware/registry/user.npmrc",
  cache = "/workspace/.cloud-setup/cache/npm",
  npmCli = "/workspace/.cloud-setup/node22/lib/node_modules/npm/bin/npm-cli.js";
const digest = (value) => createHash("sha256").update(value).digest("hex");
let root, bundleRoot, installer;
const archives = new Map();
before(async () => {
  if (process.env.JGW_AGENT_TEST_RUNTIME !== "isolated-cloud")
    throw new Error("Explicit isolated unpack tests required; no skip.");
  root = await mkdtemp(tmpdir() + "/jgw-unpack-");
  bundleRoot = root + "/runtime";
  await mkdir(bundleRoot, { mode: 0o755 });
  await chmod(bundleRoot, 0o755);
  installer = new BundleInstaller({
    root: bundleRoot,
    npmConfig,
    cache,
    npmCli,
  });
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("installs base and Talk from fresh runtime archives, npm ci and local workspace links; publishes a ready marker last", async () => {
  for (const service of ["j-groupware", "j-talk"]) {
    const archive = root + "/" + service + ".tar.gz";
    const built = await buildProductBundle({
      service,
      sourceRoot: "/workspace/" + service,
      output: archive,
      npmConfig,
      cache,
      npmCli,
    });
    const input = { service, archive, digest: built.sha256 };
    archives.set(service, input);
    assert.equal((await installer.install(input)).changed, true);
    const target = bundleRoot + "/" + service;
    assert.equal((await stat(target)).mode & 0o777, 0o755);
    const marker = JSON.parse(
      await readFile(target + "/.jgw-install.json", "utf8"),
    );
    const metadata = JSON.parse(
      await readFile(target + "/jgw-bundle.json", "utf8"),
    );
    assert.equal(marker.archiveSha256, built.sha256);
    assert.equal(marker.packageLockSha256, metadata.packageLockSha256);
    assert.equal(marker.phase, "ready");
    assert.equal(
      metadata.entrypointSha256,
      digest(await readFile(target + "/apps/server/dist/main.js")),
    );
    const local = [
      "contracts",
      ...(service === "j-groupware" ? ["permissions", "bff-auth"] : []),
    ];
    for (const name of local)
      assert.equal(
        JSON.parse(
          await readFile(
            target + "/node_modules/@" + service + "/" + name + "/package.json",
            "utf8",
          ),
        ).name,
        "@" + service + "/" + name,
      );
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(target + "/apps/server/dist/config.js")});`,
    ]);
    if (service === "j-groupware")
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(target + "/deploy/agent/bundle-install.mjs")}); await import(${JSON.stringify(target + "/deploy/agent/base-environment.mjs")}); await import(${JSON.stringify(target + "/deploy/agent/notification-worker.mjs")}); await import(${JSON.stringify(target + "/deploy/agent/tls-credentials.mjs")}); await import(${JSON.stringify(target + "/deploy/agent/launch-service.mjs")});`,
      ]);
    assert(
      (await readdir(target + "/deploy/migrations")).some((name) =>
        name.endsWith(".sql"),
      ),
    );
    assert.equal(
      (await readdir(bundleRoot)).some((name) => name.startsWith(".install-")),
      false,
    );
  }
});
test("same archive retry is idempotent; altered installed source and user-owned empty destinations are preserved", async () => {
  const input = archives.get("j-talk"),
    target = bundleRoot + "/j-talk";
  const before = await stat(target + "/.jgw-install.json");
  assert.equal((await installer.install(input)).changed, false);
  assert.equal(
    (await stat(target + "/.jgw-install.json")).mtimeMs,
    before.mtimeMs,
  );
  const entry = target + "/apps/server/dist/main.js",
    original = await readFile(entry);
  await writeFile(entry, "// preserved alteration\n");
  await assert.rejects(installer.install(input), { code: "bundle_conflict" });
  assert.equal(await readFile(entry, "utf8"), "// preserved alteration\n");
  await writeFile(entry, original);
  const other = root + "/unmanaged";
  await mkdir(other, { mode: 0o755 });
  await chmod(other, 0o755);
  await mkdir(other + "/j-talk", { mode: 0o755 });
  const preserved = new BundleInstaller({
    root: other,
    npmConfig,
    cache,
    npmCli,
  });
  await assert.rejects(preserved.install(input), {
    code: "unmanaged_bundle_destination",
  });
  assert.deepEqual(await readdir(other + "/j-talk"), []);
});

test("rejects corrupt digests and unsafe roots before publishing or overwriting any bundle", async () => {
  const safe = root + "/digest-runtime";
  await mkdir(safe, { mode: 0o755 });
  await chmod(safe, 0o755);
  const one = new BundleInstaller({ root: safe, npmConfig, cache, npmCli });
  await assert.rejects(
    one.install({ ...archives.get("j-talk"), digest: "0".repeat(64) }),
    { code: "bundle_digest_mismatch" },
  );
  assert.deepEqual(await readdir(safe), []);
  const link = root + "/link";
  await symlink(safe, link);
  const two = new BundleInstaller({ root: link, npmConfig, cache, npmCli });
  await assert.rejects(two.install(archives.get("j-talk")), {
    code: "unsafe_bundle_root",
  });
  await chmod(safe, 0o777);
  await assert.rejects(one.install(archives.get("j-talk")), {
    code: "unsafe_bundle_root",
  });
  await chmod(safe, 0o755);
});

// Python's standard tar writer is independent from both the producer and parser.
// Deliberately malformed checksums/truncation are patched after serialization.
const adversarial = `import sys,io,tarfile,gzip,os
kind,target=sys.argv[1:]
raw=io.BytesIO()
fmt=tarfile.PAX_FORMAT if kind=='pax' else tarfile.USTAR_FORMAT
with tarfile.open(fileobj=raw,mode='w',format=fmt) as tar:
 info=tarfile.TarInfo('../outside' if kind=='traversal' else '/outside' if kind=='absolute' else './file')
 info.mode=0o4755 if kind=='setuid' else 0o666 if kind=='writable' else 0o644
 body=b'x'
 if kind=='oversize': body=b'x'*(4*1024*1024+1)
 if kind in ['symlink','hardlink']:
  info.type=tarfile.SYMTYPE if kind=='symlink' else tarfile.LNKTYPE
  info.linkname='../outside'
 elif kind=='device': info.type=tarfile.CHRTYPE
 elif kind=='pax': info.pax_headers={'comment':'reject extension'}
 else: info.size=len(body)
 tar.addfile(info,io.BytesIO(body) if info.isfile() else None)
 if kind=='duplicate': tar.addfile(info,io.BytesIO(body))
 data=None
data=raw.getvalue()
if kind=='checksum': data=b'Z'+data[1:]
if kind=='truncated': data=data[:512]
if kind=='trailer': data=data+b'not-zero'
if kind=='expanded': data=b'\\0'*(80*1024*1024+1)
with open(target,'xb') as f: f.write(gzip.compress(data))
os.chmod(target,0o600)
`;
for (const kind of [
  "traversal",
  "absolute",
  "symlink",
  "hardlink",
  "device",
  "setuid",
  "writable",
  "oversize",
  "pax",
  "duplicate",
  "checksum",
  "truncated",
  "trailer",
  "expanded",
]) {
  test(
    "rejects " +
      kind +
      " archive and releases its own stage/lock without dependency execution",
    async () => {
      const archive = root + "/bad-" + kind + ".tgz";
      await execute("/usr/bin/python3", ["-c", adversarial, kind, archive]);
      const noDependencies = root + "/npm-must-not-run.mjs";
      await writeFile(
        noDependencies,
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(root + "/npm-ran")}, 'ran');`,
        { mode: 0o600 },
      );
      const one = new BundleInstaller({
        root: bundleRoot,
        npmConfig,
        cache,
        npmCli: noDependencies,
      });
      await assert.rejects(
        one.install({
          service: "j-talk",
          archive,
          digest: digest(await readFile(archive)),
        }),
      );
      assert.equal((await readdir(root)).includes("npm-ran"), false);
      assert.equal((await readdir(root)).includes("outside"), false);
      assert.equal(
        (await readdir(bundleRoot)).some(
          (name) => name.startsWith(".install-") || name === ".run.lock",
        ),
        false,
      );
      assert.equal(
        JSON.parse(
          await readFile(bundleRoot + "/j-talk/.jgw-install.json", "utf8"),
        ).phase,
        "ready",
      );
    },
  );
}
test("dependency command failure removes only its stage and leaves no ready bundle or lock", async () => {
  const target = root + "/failed-npm";
  await mkdir(target);
  await chmod(target, 0o755);
  const binary = root + "/fail-npm.mjs";
  await writeFile(binary, "process.exit(13);\n", { mode: 0o600 });
  const one = new BundleInstaller({
    root: target,
    npmConfig,
    cache,
    npmCli: binary,
  });
  await assert.rejects(one.install(archives.get("j-talk")), {
    code: "bundle_dependency_install_failed",
  });
  assert.deepEqual(await readdir(target), []);
});
test("cancellation stops the dependency process before releasing the stage and lock", async () => {
  const target = root + "/cancel-npm";
  await mkdir(target);
  await chmod(target, 0o755);
  const binary = root + "/wait-npm.mjs",
    started = root + "/npm-started.json";
  await writeFile(
    binary,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)}, JSON.stringify({pid: process.pid})); setInterval(()=>{},1000);\n`,
    { mode: 0o600 },
  );
  const one = new BundleInstaller({
    root: target,
    npmConfig,
    cache,
    npmCli: binary,
  });
  const controller = new AbortController();
  const running = one.install(archives.get("j-talk"), controller.signal);
  let began = false;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await stat(started);
        began = true;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(began, true);
  } finally {
    controller.abort();
  }
  await assert.rejects(running, { code: "cancelled" });
  const { pid } = JSON.parse(await readFile(started, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(await readdir(target), []);
});
