import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_SERVICES } from "./product-environment.mjs";
import { ProvisionError } from "./service-database.mjs";
import { externalPath } from "../gateway/gateway.mjs";
import { privateDirectory } from "./private-files.mjs";

const digest = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
async function run(command, args, cwd, env, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new ProvisionError("bundle_command_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else
        reject(
          new ProvisionError(
            timedOut ? "bundle_command_timeout" : "bundle_command_failed",
          ),
        );
    });
  });
}
async function safeInput(file, kind) {
  const info = await lstat(file);
  if (
    info.isSymbolicLink() ||
    info.mode & 0o022 ||
    ![0, process.getuid()].includes(info.uid) ||
    (kind === "directory" ? !info.isDirectory() : !info.isFile()) ||
    (await realpath(file)) !== file
  )
    throw new ProvisionError("unsafe_bundle_input");
  return info;
}
async function runtimePackage(source, expected) {
  const file = source + "/package.json";
  const info = await safeInput(file, "file");
  if (info.size > 32768) throw new ProvisionError("unsafe_bundle_input");
  const value = JSON.parse(await readFile(file, "utf8"));
  if (
    value.name !== expected ||
    value.type !== "module" ||
    !/^\d+\.\d+\.\d+$/.test(value.version)
  )
    throw new ProvisionError("invalid_bundle_package");
  if (
    Object.entries(value.dependencies ?? {}).some(
      ([name, version]) =>
        !/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name) ||
        !/^\d+\.\d+\.\d+$/.test(version),
    )
  )
    throw new ProvisionError("unpinned_bundle_dependency");
  return {
    name: value.name,
    version: value.version,
    private: true,
    type: "module",
    engines: { node: ">=22.18.0" },
    ...(value.exports ? { exports: value.exports } : {}),
    dependencies: value.dependencies ?? {},
  };
}

// Packages already-built, allowlisted files only. It never builds source, reads
// local node_modules/env, publishes a package, extracts an archive or activates OS services.
export async function buildProductBundle({
  service,
  sourceRoot,
  output,
  npmConfig,
  cache,
  npmCli,
  registryOrigin = "http://127.0.0.1:4873",
}) {
  if (!BUNDLE_SERVICES.includes(service))
    throw new ProvisionError("product_adapter_unbound");
  const registry = new URL(registryOrigin);
  if (
    registry.protocol !== "http:" ||
    registry.hostname !== "127.0.0.1" ||
    !registry.port ||
    registry.port === "3001" ||
    registry.pathname !== "/" ||
    registry.username ||
    registry.password ||
    registry.search ||
    registry.hash
  )
    throw new ProvisionError("invalid_bundle_registry");
  sourceRoot = path.resolve(sourceRoot);
  await safeInput(sourceRoot, "directory");
  if (path.basename(sourceRoot) !== service)
    throw new ProvisionError("invalid_bundle_source");
  for (const file of [output, npmConfig, cache, npmCli]) externalPath(file);
  const credentials = await safeInput(npmConfig, "file");
  if (credentials.mode & 0o077 || credentials.size > 32768)
    throw new ProvisionError("unsafe_registry_configuration");
  await safeInput(npmCli, "file");
  if (!output.endsWith(".tar.gz"))
    throw new ProvisionError("invalid_bundle_output");
  await privateDirectory(path.dirname(output));
  try {
    await lstat(output);
    const error = new ProvisionError("EEXIST");
    throw error;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = await mkdtemp(
    path.join(path.dirname(output), ".product-bundle-"),
  );
  const stage = temporary + "/payload",
    archive = temporary + "/artifact.tar.gz";
  const paths = [],
    inventory = [];
  let bytes = 0;
  const copy = async (relative) => {
    const source = path.join(sourceRoot, relative),
      destination = path.join(stage, relative);
    const info = await safeInput(source, "file");
    bytes += info.size;
    if (
      info.size > 4 * 1024 * 1024 ||
      bytes > 64 * 1024 * 1024 ||
      paths.length >= 4096
    )
      throw new ProvisionError("bundle_input_limit");
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(source, destination);
    paths.push(relative);
    inventory.push({ path: relative, sha256: await digest(destination) });
  };
  const tree = async (relative, kind) => {
    await safeInput(path.join(sourceRoot, relative), "directory");
    for (const entry of await readdir(path.join(sourceRoot, relative), {
      withFileTypes: true,
    })) {
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.name) || entry.isSymbolicLink())
        throw new ProvisionError("unsafe_bundle_input");
      const name = relative + "/" + entry.name;
      if (entry.isDirectory()) await tree(name, kind);
      else if (
        entry.isFile() &&
        (kind === "sql"
          ? /^\d+[a-z0-9_-]*\.sql$/.test(entry.name)
          : /(?:\.js|\.mjs|\.cjs|\.json|\.d\.ts)$/.test(entry.name))
      )
        await copy(name);
      else if (
        entry.isFile() &&
        kind === "compiled" &&
        entry.name.endsWith(".map")
      )
        continue;
      else throw new ProvisionError("unsafe_bundle_input");
    }
  };
  try {
    const contractName = `@${service}/contracts`,
      serverName = `@${service}/server`;
    const contracts = await runtimePackage(
      sourceRoot + "/packages/contracts",
      contractName,
    );
    const server = await runtimePackage(
      sourceRoot + "/apps/server",
      serverName,
    );
    if (server.dependencies[contractName] !== contracts.version)
      throw new ProvisionError("bundle_contract_mismatch");
    const workspaces = [
      ["apps/server", server],
      ["packages/contracts", contracts],
    ];
    if (service === "j-groupware")
      for (const name of ["permissions", "bff-auth"])
        workspaces.push([
          "packages/" + name,
          await runtimePackage(
            sourceRoot + "/packages/" + name,
            "@j-groupware/" + name,
          ),
        ]);
    const local = new Map(
      workspaces.map(([, value]) => [value.name, value.version]),
    );
    for (const [, value] of workspaces)
      for (const [name, version] of Object.entries(value.dependencies))
        if (local.has(name) && local.get(name) !== version)
          throw new ProvisionError("bundle_contract_mismatch");
    for (const [workspace, value] of workspaces) {
      await tree(workspace + "/dist", "compiled");
      await writeFile(
        stage + "/" + workspace + "/package.json",
        JSON.stringify(value, null, 2) + "\n",
        { flag: "wx", mode: 0o644 },
      );
    }
    const entrypoint = "apps/server/dist/main.js";
    if (!paths.includes(entrypoint))
      throw new ProvisionError("bundle_not_ready");
    await tree(
      service === "j-messenger"
        ? "deploy/postgres-migrations"
        : "deploy/migrations",
      "sql",
    );
    if (service === "j-talk") {
      const widget = await safeInput(
        sourceRoot + "/apps/widget/dist/widget.min.js",
        "file",
      );
      if (widget.size > 30 * 1024)
        throw new ProvisionError("bundle_widget_limit");
      await copy("apps/widget/dist/widget.min.js");
    }
    if (service === "j-web") {
      for (const name of [
        "deploy/jweb-helper.mjs",
        "deploy/hosting/jweb.sudoers",
        "deploy/hosting/sshd_config",
        "deploy/hosting/vsftpd.conf",
      ])
        await copy(name);
    }
    if (service === "j-groupware") {
      for (const name of [
        "bootstrap-files",
        "base-environment",
        "console-client",
        "native-platform",
        "notification-manifest",
        "private-files",
        "product-environment",
        "product-gateway",
        "product-readiness",
        "provision-command",
        "provision-error",
        "reconciler",
        "service-database",
        "service-environment",
        "service-lifecycle",
        "web-cleanup",
        "bundle-install",
      ])
        await copy("deploy/agent/" + name + ".mjs");
      for (const name of [
        "gateway.mjs",
        "nginx.conf.template",
        "gw.conf.template",
        "snippets/tls.conf",
      ])
        await copy("deploy/gateway/" + name);
    }
    await writeFile(
      stage + "/package.json",
      JSON.stringify(
        {
          name: service + "-suite-runtime",
          private: true,
          type: "module",
          engines: { node: ">=22.18.0" },
          workspaces: workspaces.map(([name]) => name),
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o644 },
    );
    const env = {
      PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: temporary,
      NPM_CONFIG_USERCONFIG: npmConfig,
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_REGISTRY: registry.origin,
    };
    await run(
      process.execPath,
      [
        npmCli,
        "install",
        "--package-lock-only",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      stage,
      env,
    );
    const lock = JSON.parse(
      await readFile(stage + "/package-lock.json", "utf8"),
    );
    if (
      lock.lockfileVersion !== 3 ||
      Object.keys(lock.packages).some(
        (key) => key.includes("apps/web") || key.includes("apps/desktop"),
      )
    )
      throw new ProvisionError("invalid_bundle_lock");
    const metadata = {
      service,
      profile: "suite-internal",
      entrypoint,
      entrypointSha256: await digest(stage + "/" + entrypoint),
      sourceFiles: inventory.sort((a, b) => a.path.localeCompare(b.path)),
      packageLockSha256: await digest(stage + "/package-lock.json"),
      packageId: randomUUID(),
    };
    const encoded = JSON.stringify(metadata, null, 2) + "\n";
    // Native preflight intentionally accepts bounded metadata; detailed file
    // inventory lives separately and is included by the archive digest.
    const { sourceFiles, ...header } = metadata;
    await writeFile(
      stage + "/jgw-bundle.json",
      JSON.stringify(header, null, 2) + "\n",
      { flag: "wx", mode: 0o644 },
    );
    await writeFile(stage + "/jgw-bundle-files.json", encoded, {
      flag: "wx",
      mode: 0o644,
    });
    await run(
      "/usr/bin/tar",
      ["--format=ustar", "-czf", archive, "-C", stage, "."],
      temporary,
      {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
      },
    );
    await link(archive, output);
    return {
      service,
      output,
      sha256: await digest(archive),
      bytes: (await lstat(archive)).size,
      sourceFiles: sourceFiles.length,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [service, sourceRoot, output] = process.argv.slice(2);
  buildProductBundle({
    service,
    sourceRoot,
    output,
    npmConfig: process.env.JGW_BUNDLE_NPM_CONFIG,
    cache: process.env.JGW_BUNDLE_NPM_CACHE,
    npmCli: process.env.JGW_BUNDLE_NPM_CLI,
  })
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error) => {
      process.stderr.write(
        (error instanceof ProvisionError ? error.code : "bundle_failed") + "\n",
      );
      process.exitCode = 1;
    });
}
