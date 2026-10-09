import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { BUNDLE_SERVICES } from "./product-environment.mjs";
import { externalPath } from "../gateway/gateway.mjs";
import { DirectoryLock } from "./reconciler.mjs";
import { ProvisionError } from "./provision-error.mjs";

const fail = (code = "invalid_bundle_archive") => {
  throw new ProvisionError(code);
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const validDigest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const workspacesFor = (service) => [
  "apps/server",
  "packages/contracts",
  ...(service === "j-groupware"
    ? ["packages/permissions", "packages/bff-auth"]
    : []),
];
function normalized(raw) {
  if (
    !/^[A-Za-z0-9_./-]+$/.test(raw) ||
    raw.length > 255 ||
    !raw.startsWith("./")
  )
    fail();
  const relative = raw.slice(2).replace(/\/$/, "");
  if (relative === "") return "";
  if (
    relative
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    path.normalize(relative) !== relative
  )
    fail();
  return relative;
}
const text = (block) => {
  const zero = block.indexOf(0),
    bytes = zero < 0 ? block : block.subarray(0, zero);
  if ([...bytes].some((v) => v < 32 || v > 126)) fail();
  return bytes.toString("ascii");
};
const octal = (block) => {
  const value = block
    .toString("ascii")
    .replace(/[\x00 ]+$/, "")
    .replace(/^ +/, "");
  if (!/^[0-7]+$/.test(value)) fail();
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail();
  return number;
};
async function safeFile(
  file,
  { privateFile = false, maximum = 64 * 1024 * 1024 } = {},
) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(file)) !== file ||
    ![0, process.getuid()].includes(info.uid) ||
    info.mode & (privateFile ? 0o077 : 0o022) ||
    info.size > maximum
  )
    fail("unsafe_bundle_input");
  return info;
}
async function publicDirectory(directory) {
  externalPath(directory);
  for (const target of [
    directory,
    ...(function* () {
      for (let p = path.dirname(directory); p !== "/"; p = path.dirname(p))
        yield p;
    })(),
  ]) {
    const info = await lstat(target);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(target)) !== target ||
      ![0, process.getuid()].includes(info.uid) ||
      info.mode & 0o022
    )
      fail("unsafe_bundle_root");
  }
  const info = await lstat(directory);
  if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o755)
    fail("unsafe_bundle_root");
}
class TarReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0);
  }
  async take(size) {
    const parts = [];
    let total = 0;
    while (total < size) {
      if (!this.pending.length) {
        const next = await this.iterator.next();
        if (next.done) fail("truncated_bundle_archive");
        this.pending = next.value;
      }
      const length = Math.min(size - total, this.pending.length);
      parts.push(this.pending.subarray(0, length));
      this.pending = this.pending.subarray(length);
      total += length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
  }
  async terminal() {
    if ((await this.take(512)).some((b) => b !== 0)) fail();
    if (this.pending.some((b) => b !== 0)) fail();
    this.pending = Buffer.alloc(0);
    for (;;) {
      const next = await this.iterator.next();
      if (next.done) break;
      if (next.value.some((b) => b !== 0)) fail();
    }
  }
}
async function extract(archive, stage, digest, signal) {
  const info = await safeFile(archive);
  if (info.size < 18) fail();
  const source = createReadStream(archive, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  });
  const compressedHash = createHash("sha256");
  let compressed = 0,
    expanded = 0,
    fileBytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      compressed += chunk.length;
      if (compressed > info.size || compressed > 64 * 1024 * 1024)
        return done(new ProvisionError("bundle_archive_limit"));
      compressedHash.update(chunk);
      done(null, chunk);
    },
  });
  const gunzip = createGunzip();
  const bounded = new Transform({
    transform(chunk, _encoding, done) {
      expanded += chunk.length;
      if (expanded > 80 * 1024 * 1024)
        return done(new ProvisionError("bundle_archive_limit"));
      done(null, chunk);
    },
  });
  const pumping = pipeline(source, meter, gunzip, bounded, { signal });
  void pumping.catch(() => {});
  const reader = new TarReader(bounded),
    files = new Map(),
    entries = new Set(),
    directories = new Set();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const block = await reader.take(512);
      if (block.every((b) => b === 0)) {
        await reader.terminal();
        break;
      }
      if (
        block.subarray(257, 263).toString() !== "ustar\0" ||
        block.subarray(263, 265).toString() !== "00"
      )
        fail("unsupported_bundle_archive");
      const checksum = octal(block.subarray(148, 156));
      let actual = 0;
      for (let i = 0; i < 512; i++)
        actual += i >= 148 && i < 156 ? 32 : block[i];
      if (actual !== checksum) fail("bundle_header_checksum");
      const prefix = text(block.subarray(345, 500)),
        name = text(block.subarray(0, 100));
      const relative = normalized(prefix ? prefix + "/" + name : name),
        kind = block[156];
      const size = octal(block.subarray(124, 136)),
        mode = octal(block.subarray(100, 108));
      octal(block.subarray(108, 116));
      octal(block.subarray(116, 124));
      octal(block.subarray(136, 148));
      if (
        ![0, 48, 53].includes(kind) ||
        text(block.subarray(157, 257)) ||
        mode & 0o7022 ||
        mode > 0o777 ||
        size > 4 * 1024 * 1024 ||
        entries.has(relative) ||
        entries.size >= 8192 ||
        (kind === 53 && size !== 0) ||
        (!relative && kind !== 53)
      )
        fail();
      entries.add(relative);
      if (kind === 53) {
        directories.add(relative);
        if (relative)
          await mkdir(path.join(stage, relative), {
            recursive: true,
            mode: 0o755,
          });
        continue;
      }
      if (files.size >= 4096) fail("bundle_archive_limit");
      fileBytes += size;
      if (fileBytes > 64 * 1024 * 1024) fail("bundle_archive_limit");
      const target = path.join(stage, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      const file = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o644,
      );
      const contentHash = createHash("sha256");
      try {
        for (let remaining = size; remaining > 0;) {
          const part = await reader.take(Math.min(remaining, 65536));
          contentHash.update(part);
          let offset = 0;
          while (offset < part.length) {
            const written = (await file.write(part, offset)).bytesWritten;
            if (!written) fail("bundle_write_failed");
            offset += written;
          }
          remaining -= part.length;
        }
      } finally {
        await file.close();
      }
      const padding = (512 - (size % 512)) % 512;
      if (padding && (await reader.take(padding)).some((b) => b !== 0)) fail();
      files.set(relative, { sha256: contentHash.digest("hex"), size });
    }
    await pumping;
    if (compressed !== info.size || compressedHash.digest("hex") !== digest)
      fail("bundle_digest_mismatch");
    return { files, directories };
  } finally {
    source.destroy();
    meter.destroy();
    gunzip.destroy();
    bounded.destroy();
    await pumping.catch(() => {});
  }
}
const allowedSource = (service, name) => {
  const compiled = workspacesFor(service).some(
    (workspace) =>
      name.startsWith(workspace + "/dist/") &&
      /(?:\.js|\.mjs|\.cjs|\.json|\.d\.ts)$/.test(name),
  );
  if (compiled) return true;
  if (
    new RegExp(
      "^deploy/" +
        (service === "j-messenger" ? "postgres-migrations" : "migrations") +
        "/[0-9]+[a-z0-9_-]*\\.sql$",
    ).test(name)
  )
    return true;
  if (service === "j-talk" && name === "apps/widget/dist/widget.min.js")
    return true;
  if (
    service === "j-web" &&
    [
      "deploy/jweb-helper.mjs",
      "deploy/hosting/jweb.sudoers",
      "deploy/hosting/sshd_config",
      "deploy/hosting/vsftpd.conf",
    ].includes(name)
  )
    return true;
  return (
    service === "j-groupware" &&
    (/^deploy\/agent\/[a-z-]+\.mjs$/.test(name) ||
      [
        "deploy/provision-service",
        "deploy/bootstrap",
        "deploy/gateway/gateway.mjs",
        "deploy/gateway/nginx.conf.template",
        "deploy/gateway/gw.conf.template",
        "deploy/gateway/snippets/tls.conf",
      ].includes(name))
  );
};
async function validatePayload(root, service, contents) {
  const { files, directories } = contents;
  const json = async (name, maximum = 4 * 1024 * 1024) => {
    const value = files.get(name);
    if (!value || value.size > maximum) fail("bundle_not_ready");
    try {
      return JSON.parse(await readFile(path.join(root, name), "utf8"));
    } catch {
      fail();
    }
  };
  const metadata = await json("jgw-bundle.json", 8192),
    inventory = await json("jgw-bundle-files.json");
  if (
    metadata.service !== service ||
    metadata.profile !== "suite-internal" ||
    metadata.entrypoint !== "apps/server/dist/main.js" ||
    !validDigest(metadata.entrypointSha256) ||
    !validDigest(metadata.packageLockSha256) ||
    Object.keys(metadata).sort().join(",") !==
      "entrypoint,entrypointSha256,packageId,packageLockSha256,profile,service" ||
    !/^[a-f0-9-]{36}$/.test(metadata.packageId)
  )
    fail("bundle_not_ready");
  if (
    Object.keys(inventory).sort().join(",") !==
      "entrypoint,entrypointSha256,packageId,packageLockSha256,profile,service,sourceFiles" ||
    !Array.isArray(inventory.sourceFiles) ||
    inventory.sourceFiles.length < 1 ||
    inventory.sourceFiles.length > 4096
  )
    fail();
  for (const [key, value] of Object.entries(metadata))
    if (inventory[key] !== value) fail();
  const sourceNames = new Set();
  for (const file of inventory.sourceFiles) {
    if (
      !file ||
      Object.keys(file).sort().join(",") !== "path,sha256" ||
      !allowedSource(service, file.path) ||
      !validDigest(file.sha256) ||
      sourceNames.has(file.path) ||
      files.get(file.path)?.sha256 !== file.sha256
    )
      fail("bundle_file_digest_mismatch");
    sourceNames.add(file.path);
  }
  if (
    files.get(metadata.entrypoint)?.sha256 !== metadata.entrypointSha256 ||
    files.get("package-lock.json")?.sha256 !== metadata.packageLockSha256
  )
    fail("bundle_file_digest_mismatch");
  const workspaces = workspacesFor(service);
  const generated = [
    "package.json",
    "package-lock.json",
    "jgw-bundle.json",
    "jgw-bundle-files.json",
    ...workspaces.map((p) => p + "/package.json"),
  ];
  if (
    [...files.keys()].some(
      (file) => !sourceNames.has(file) && !generated.includes(file),
    )
  )
    fail("unexpected_bundle_file");
  if (
    [...directories].some(
      (directory) =>
        directory &&
        ![...files.keys()].some((file) => file.startsWith(directory + "/")),
    )
  )
    fail("unexpected_bundle_directory");
  const pkg = await json("package.json", 32768),
    lock = await json("package-lock.json");
  if (
    pkg.name !== service + "-suite-runtime" ||
    pkg.private !== true ||
    pkg.type !== "module" ||
    pkg.scripts ||
    JSON.stringify(pkg.workspaces) !== JSON.stringify(workspaces) ||
    lock.lockfileVersion !== 3 ||
    !lock.packages ||
    typeof lock.packages !== "object"
  )
    fail("invalid_bundle_package");
  for (const workspace of workspaces) {
    const local = await json(workspace + "/package.json", 32768);
    if (
      local.scripts ||
      local.type !== "module" ||
      !/^\d+\.\d+\.\d+$/.test(local.version) ||
      local.name !==
        "@" +
          service +
          "/" +
          (workspace === "apps/server" ? "server" : workspace.slice(9)) ||
      Object.values(local.dependencies ?? {}).some(
        (version) => !/^\d+\.\d+\.\d+$/.test(version),
      )
    )
      fail("invalid_bundle_package");
    if (
      lock.packages["node_modules/" + local.name]?.resolved !== workspace ||
      lock.packages["node_modules/" + local.name]?.link !== true
    )
      fail("invalid_bundle_lock");
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (
      name &&
      !workspaces.includes(name) &&
      (!name.startsWith("node_modules/") ||
        name.split("/").some((p) => p === ".." || !p))
    )
      fail("invalid_bundle_lock");
    if (entry.link && !workspaces.includes(entry.resolved))
      fail("invalid_bundle_lock");
    if (entry.resolved && !entry.link) {
      let url;
      try {
        url = new URL(entry.resolved);
      } catch {
        fail("invalid_bundle_lock");
      }
      if (
        !(
          (url.protocol === "http:" && url.host === "127.0.0.1:4873") ||
          (url.protocol === "https:" && url.host === "registry.npmjs.org")
        ) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        typeof entry.integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
      )
        fail("invalid_bundle_lock");
    }
  }
  return metadata;
}
async function npmInstall(root, config, cache, npmCli, signal) {
  await safeFile(config, { privateFile: true, maximum: 32768 });
  await safeFile(npmCli);
  const env = {
    PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: root,
    NPM_CONFIG_USERCONFIG: config,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_GLOBAL: "false",
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:4873",
  };
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        npmCli,
        "ci",
        "--prefix=" + root,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: root, detached: true, env, shell: false, stdio: "ignore" },
    );
    let cancelled = false;
    const kill = () => {
      cancelled = true;
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") cancelled = true;
        }
    };
    const timer = setTimeout(kill, 60000);
    signal?.addEventListener("abort", kill, { once: true });
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    };
    child.once("error", () => {
      stop();
      reject(new ProvisionError("bundle_dependency_install_failed"));
    });
    child.once("close", (code) => {
      stop();
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      if (code === 0 && !cancelled) resolve();
      else
        reject(
          new ProvisionError(
            signal?.aborted ? "cancelled" : "bundle_dependency_install_failed",
          ),
        );
    });
    if (signal?.aborted) kill();
  });
}
// npm inherits the bootstrapper's private umask. Runtime service accounts need
// readable files, while links may only resolve inside this newly-owned stage.
async function runtimeModes(root, signal) {
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      signal?.throwIfAborted();
      const file = path.join(directory, name),
        info = await lstat(file);
      if (info.uid !== process.getuid()) fail("unsafe_bundle_dependency");
      if (info.isSymbolicLink()) {
        const resolved = await realpath(file);
        if (
          !file.startsWith(root + "/node_modules/") ||
          !resolved.startsWith(root + "/")
        )
          fail("unsafe_bundle_dependency");
      } else if (info.isDirectory()) {
        await visit(file);
        await chmod(file, 0o755);
      } else if (info.isFile())
        await chmod(file, info.mode & 0o111 ? 0o755 : 0o644);
      else fail("unsafe_bundle_dependency");
    }
  }
  await visit(root);
}
export class BundleInstaller {
  constructor({ root, npmConfig, cache, npmCli }) {
    for (const value of [root, npmConfig, cache, npmCli]) externalPath(value);
    Object.assign(this, {
      root,
      npmConfig,
      cache,
      npmCli,
      lock: new DirectoryLock(root),
    });
  }
  async install({ service, archive, digest }, signal) {
    if (!BUNDLE_SERVICES.includes(service) || !validDigest(digest))
      fail("invalid_service");
    externalPath(archive);
    await publicDirectory(this.root);
    signal?.throwIfAborted();
    const release = await this.lock.acquire();
    if (!release) fail("busy");
    const target = path.join(this.root, service);
    let stage,
      reserved = false;
    const token = randomUUID();
    try {
      stage = await mkdtemp(path.join(this.root, ".install-" + service + "-"));
      const contents = await extract(archive, stage, digest, signal);
      const metadata = await validatePayload(stage, service, contents);
      const existing = await lstat(target).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing) {
        const info = existing;
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid() ||
          info.mode & 0o022 ||
          (await realpath(target)) !== target
        )
          fail("unmanaged_bundle_destination");
        const markerFile = target + "/.jgw-install.json";
        try {
          await safeFile(markerFile, { maximum: 8192 });
        } catch {
          fail("unmanaged_bundle_destination");
        }
        const marker = JSON.parse(await readFile(markerFile, "utf8"));
        if (
          marker.service !== service ||
          marker.archiveSha256 !== digest ||
          marker.phase !== "ready"
        )
          fail("bundle_conflict");
        for (const [name, original] of contents.files) {
          await safeFile(path.join(target, name));
          if (hash(await readFile(path.join(target, name))) !== original.sha256)
            fail("bundle_conflict");
        }
        if (service === "j-groupware")
          for (const wrapper of [
            "deploy/provision-service",
            "deploy/bootstrap",
          ])
            if (
              contents.files.has(wrapper) &&
              ((await lstat(target + "/" + wrapper)).mode & 0o777) !== 0o755
            )
              fail("bundle_conflict");
        const dependencies = await lstat(target + "/node_modules");
        if (
          !dependencies.isDirectory() ||
          dependencies.isSymbolicLink() ||
          ![0, process.getuid()].includes(dependencies.uid) ||
          dependencies.mode & 0o022
        )
          fail("bundle_dependency_install_failed");
        if ((info.mode & 0o777) !== 0o755) await chmod(target, 0o755);
        return {
          service,
          phase: "ready",
          changed: false,
          archiveSha256: digest,
        };
      }
      // Exclusive reservation prevents rename from replacing even an empty,
      // preexisting user directory. The final ready marker is published last.
      await npmInstall(stage, this.npmConfig, this.cache, this.npmCli, signal);
      // Extraction strips executable bits. Restore only this fixed, hash-checked
      // base entrypoints; arbitrary archive scripts remain nonexecutable.
      if (service === "j-groupware")
        for (const wrapper of ["deploy/provision-service", "deploy/bootstrap"])
          if (contents.files.has(wrapper))
            await chmod(stage + "/" + wrapper, 0o755);
      await runtimeModes(stage, signal);
      signal?.throwIfAborted();
      await mkdir(target, { mode: 0o700 });
      reserved = true;
      await writeFile(
        target + "/.install-owner.json",
        JSON.stringify({ token }),
        { flag: "wx", mode: 0o600 },
      );
      for (const name of await readdir(stage))
        await rename(stage + "/" + name, target + "/" + name);
      await writeFile(
        target + "/.jgw-install.json",
        JSON.stringify({
          service,
          phase: "ready",
          archiveSha256: digest,
          packageLockSha256: metadata.packageLockSha256,
          nodeVersion: process.version,
        }) + "\n",
        { flag: "wx", mode: 0o644 },
      );
      await rm(target + "/.install-owner.json");
      await chmod(target, 0o755);
      return { service, phase: "ready", changed: true, archiveSha256: digest };
    } catch (error) {
      if (reserved) {
        const info = await lstat(target).catch(() => null);
        const marker = await readFile(
          target + "/.install-owner.json",
          "utf8",
        ).catch(() => "");
        if (
          info?.isDirectory() &&
          !info.isSymbolicLink() &&
          info.uid === process.getuid() &&
          marker === JSON.stringify({ token })
        )
          await rm(target, { recursive: true });
      }
      throw error instanceof ProvisionError
        ? error
        : new ProvisionError(
            signal?.aborted ? "cancelled" : "bundle_install_failed",
          );
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
      await release();
    }
  }
}
