import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_SERVICES } from "./product-environment.mjs";
import { OS_REQUIRED_PACKAGES } from "./os-bootstrap.mjs";
import { externalPath, execute } from "../gateway/gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";

const fail = (code = "invalid_bootstrap_kit") => {
  throw new ProvisionError(code);
};
const hash = async (file) => {
  const value = createHash("sha256");
  for await (const bytes of createReadStream(file)) value.update(bytes);
  return value.digest("hex");
};
async function source(file, directory = false) {
  const info = await lstat(file);
  if (
    info.isSymbolicLink() ||
    info.mode & 0o022 ||
    ![0, process.getuid()].includes(info.uid) ||
    (await realpath(file)) !== file ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  )
    fail("unsafe_kit_source");
  return info;
}
const relative = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\\\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail();
  return value;
};
// Assembles an existing verified runtime and all customer archives. Never reads
// sealed credentials, .env, npmrc, TLS private keys or service data into a kit.
export async function buildBootstrapKit({
  runtimeRoot,
  nodeFile,
  nodeSha256,
  npmRoot,
  archives,
  osPackages,
  output,
}) {
  [runtimeRoot, nodeFile, npmRoot, output].forEach(externalPath);
  if (
    [
      runtimeRoot,
      npmRoot,
      nodeFile,
      ...(archives ?? []).map((row) => row.archive),
      ...(osPackages ?? []).map((row) => row.file),
    ].some(
      (input) =>
        input === output ||
        input.startsWith(output + "/") ||
        output.startsWith(input + "/"),
    )
  )
    fail("overlapping_kit_paths");
  await source(runtimeRoot, true);
  await source(npmRoot, true);
  await source(nodeFile);
  if (
    !/^[a-f0-9]{64}$/.test(nodeSha256) ||
    (await hash(nodeFile)) !== nodeSha256 ||
    !Array.isArray(archives) ||
    archives.length !== BUNDLE_SERVICES.length ||
    new Set(archives.map((row) => row.service)).size !==
      BUNDLE_SERVICES.length ||
    !Array.isArray(osPackages) ||
    osPackages.length > 300 ||
    new Set(osPackages.map((pkg) => pkg.name)).size !== osPackages.length ||
    OS_REQUIRED_PACKAGES.some(
      (name) => !osPackages.some((pkg) => pkg.name === name),
    )
  )
    fail();
  const marker = JSON.parse(
      await readFile(runtimeRoot + "/.jgw-install.json", "utf8"),
    ),
    inventory = JSON.parse(
      await readFile(runtimeRoot + "/jgw-bundle-files.json", "utf8"),
    );
  if (
    marker.service !== "j-groupware" ||
    marker.phase !== "ready" ||
    !/^[a-f0-9]{64}$/.test(marker.archiveSha256) ||
    marker.packageLockSha256 !==
      (await hash(runtimeRoot + "/package-lock.json")) ||
    inventory.service !== "j-groupware" ||
    !Array.isArray(inventory.sourceFiles)
  )
    fail("kit_runtime_not_ready");
  for (const row of inventory.sourceFiles) {
    relative(row.path);
    await source(runtimeRoot + "/" + row.path);
    if ((await hash(runtimeRoot + "/" + row.path)) !== row.sha256)
      fail("kit_runtime_not_ready");
  }
  // Existing output is not replaced. Caller chooses a new reviewable destination.
  await source(path.dirname(output), true);
  await mkdir(output, { mode: 0o700 });
  const identity = await lstat(output),
    rows = [],
    budget = { entries: 0, bytes: 0 };
  try {
    const copy = async (input, name, boundary, ancestors = new Set()) => {
      relative(name);
      const resolved = await realpath(input);
      if (resolved !== boundary && !resolved.startsWith(boundary + "/"))
        fail("kit_dependency_escape");
      const info = await source(
        resolved,
        (await lstat(resolved)).isDirectory(),
      );
      if (++budget.entries > 40000 || info.size > 150 * 1024 * 1024)
        fail("kit_size_limit");
      if (info.isDirectory()) {
        if (ancestors.has(resolved)) fail("kit_dependency_cycle");
        const next = new Set([...ancestors, resolved]);
        await mkdir(output + "/" + name, { recursive: true, mode: 0o755 });
        for (const child of (await readdir(resolved)).sort()) {
          if (child === ".npmrc") continue; // Never read or copy local npm credentials.
          if (
            [".env", ".aws", ".git"].includes(child) ||
            /\.(?:key|pem|p12)$/.test(child)
          )
            fail("kit_secret_source_refused");
          await copy(
            resolved + "/" + child,
            name + "/" + child,
            boundary,
            next,
          );
        }
      } else {
        budget.bytes += info.size;
        if (budget.bytes > 768 * 1024 * 1024) fail("kit_size_limit");
        await mkdir(path.dirname(output + "/" + name), {
          recursive: true,
          mode: 0o755,
        });
        await copyFile(resolved, output + "/" + name, 1);
        const mode = info.mode & 0o111 ? 0o555 : 0o444;
        await chmod(output + "/" + name, mode);
        const sha256 = await hash(output + "/" + name);
        if (
          (await hash(resolved)) !== sha256 ||
          (await lstat(resolved)).size !== info.size
        )
          fail("kit_source_changed");
        rows.push({ path: name, mode, bytes: info.size, sha256 });
      }
    };
    for (const name of [
      "apps",
      "packages",
      "deploy",
      "node_modules",
      "package.json",
      "package-lock.json",
      "jgw-bundle.json",
      "jgw-bundle-files.json",
      ".jgw-install.json",
    ])
      await copy(runtimeRoot + "/" + name, "runtime/" + name, runtimeRoot);
    await copy(nodeFile, "bin/node", path.dirname(nodeFile));
    await chmod(output + "/bin/node", 0o555);
    rows.find((row) => row.path === "bin/node").mode = 0o555;
    await copy(npmRoot, "npm", npmRoot);
    for (const archive of archives) {
      if (
        !BUNDLE_SERVICES.includes(archive.service) ||
        !/^[a-f0-9]{64}$/.test(archive.digest)
      )
        fail();
      externalPath(archive.archive);
      await source(archive.archive);
      if ((await hash(archive.archive)) !== archive.digest)
        fail("kit_archive_mismatch");
      await copy(
        archive.archive,
        "archives/" + archive.service + ".tgz",
        path.dirname(archive.archive),
      );
    }
    for (let i = 0; i < osPackages.length; i++) {
      const pkg = osPackages[i];
      if (
        Object.keys(pkg).sort().join() !==
          "architecture,file,name,sha256,version" ||
        !/^[a-z0-9][a-z0-9+.-]+$/.test(pkg.name) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9:+.~-]{0,127}$/.test(pkg.version) ||
        !["all", "amd64", "arm64"].includes(pkg.architecture)
      )
        fail("kit_os_artifact_mismatch");
      if (
        (await execute(
          "/usr/bin/dpkg-deb",
          ["--field", pkg.file, "Package", "Version", "Architecture"],
          { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
        )) !==
        `Package: ${pkg.name}\nVersion: ${pkg.version}\nArchitecture: ${pkg.architecture}\n`
      )
        fail("kit_os_artifact_mismatch");

      externalPath(pkg.file);
      await source(pkg.file);
      if (
        !/^[a-f0-9]{64}$/.test(pkg.sha256) ||
        (await hash(pkg.file)) !== pkg.sha256
      )
        fail("kit_os_artifact_mismatch");
      await copy(pkg.file, "os/" + i + ".deb", path.dirname(pkg.file));
    }
    const entry =
      '#!/bin/sh\nset -eu\nkit=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\n[ "$(id -u)" = 0 ] || exit 1\nancestor=$kit\nwhile [ "$ancestor" != / ]; do\n  [ ! -L "$ancestor" ] && [ "$(stat -c %u "$ancestor")" = 0 ] || exit 1\n  [ -z "$(find "$ancestor" -maxdepth 0 -perm /022 -print)" ] || exit 1\n  ancestor=$(dirname -- "$ancestor")\ndone\n[ -z "$(find "$kit" -xdev \\( -type l -o ! -user root -o -perm /022 \\) -print -quit)" ] || exit 1\ncd -- "$kit"\nsha256sum --strict --check SHA256SUMS >/dev/null\nexec "$kit/bin/node" "$kit/runtime/deploy/agent/full-bootstrap.mjs" "$kit" "$@"\n';
    await writeFile(output + "/bootstrap", entry, { flag: "wx", mode: 0o555 });
    await chmod(output + "/bootstrap", 0o555);
    rows.push({
      path: "bootstrap",
      mode: 0o555,
      bytes: Buffer.byteLength(entry),
      sha256: createHash("sha256").update(entry).digest("hex"),
    });
    rows.sort((a, b) => a.path.localeCompare(b.path));
    const manifest =
      JSON.stringify({
        format: 1,
        runtimeArchiveSha256: marker.archiveSha256,
        files: rows,
      }) + "\n";
    await writeFile(output + "/manifest.json", manifest, {
      flag: "wx",
      mode: 0o444,
    });
    await chmod(output + "/manifest.json", 0o444);
    const sums =
      rows.map((row) => row.sha256 + "  " + row.path).join("\n") +
      "\n" +
      createHash("sha256").update(manifest).digest("hex") +
      "  manifest.json\n";
    await writeFile(output + "/SHA256SUMS", sums, { flag: "wx", mode: 0o444 });
    await chmod(output + "/SHA256SUMS", 0o444);
    return {
      output,
      files: rows.length,
      bytes: budget.bytes,
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      activation: "pending",
    };
  } catch (error) {
    const current = await lstat(output);
    if (
      current.ino === identity.ino &&
      current.dev === identity.dev &&
      current.uid === process.getuid()
    )
      await rm(output, { recursive: true });
    throw error;
  }
}
export async function verifyBootstrapKit(root) {
  externalPath(root);
  await source(root, true);
  const manifest = JSON.parse(await readFile(root + "/manifest.json", "utf8"));
  if (
    manifest.format !== 1 ||
    Object.keys(manifest).sort().join() !==
      "files,format,runtimeArchiveSha256" ||
    !/^[a-f0-9]{64}$/.test(manifest.runtimeArchiveSha256) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 40000
  )
    fail();
  const expected = new Set(["manifest.json", "SHA256SUMS"]);
  let bytes = 0;
  for (const row of manifest.files) {
    relative(row.path);
    if (
      Object.keys(row).sort().join() !== "bytes,mode,path,sha256" ||
      ![0o444, 0o555].includes(row.mode) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      expected.has(row.path)
    )
      fail();
    expected.add(row.path);
    const info = await source(root + "/" + row.path);
    bytes += info.size;
    if (
      bytes > 768 * 1024 * 1024 ||
      info.size !== row.bytes ||
      (info.mode & 0o777) !== row.mode ||
      (await hash(root + "/" + row.path)) !== row.sha256
    )
      fail("kit_content_mismatch");
  }
  const manifestText = await readFile(root + "/manifest.json", "utf8");
  const sums =
    manifest.files.map((row) => row.sha256 + "  " + row.path).join("\n") +
    "\n" +
    createHash("sha256").update(manifestText).digest("hex") +
    "  manifest.json\n";
  if ((await readFile(root + "/SHA256SUMS", "utf8")) !== sums)
    fail("kit_content_mismatch");
  let count = 0;
  const enumerate = async (directory, prefix = "") => {
    await source(directory, true);
    for (const name of await readdir(directory)) {
      const relativeName = prefix + name,
        info = await lstat(directory + "/" + name);
      if (++count > 80000 || info.isSymbolicLink())
        fail("kit_content_mismatch");
      if (info.isDirectory())
        await enumerate(directory + "/" + name, relativeName + "/");
      else if (!expected.has(relativeName)) fail("kit_content_mismatch");
    }
  };
  await enumerate(root);
  return manifest;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stderr.write("Use the prepared-input buildBootstrapKit API.\n");
  process.exitCode = 1;
}
