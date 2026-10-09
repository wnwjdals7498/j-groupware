import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repository = fileURLToPath(new URL("../", import.meta.url));
const failure = (code) => Object.assign(new Error(code), { code });
async function ownedDirectory(root) {
  await mkdir(root, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & 0o077 ||
    (await realpath(root)) !== root
  )
    throw failure("unsafe_test_resource_root");
}
// One lease covers build, child processes and fixture teardown. Never steal a
// stale lease: a dead test parent does not prove its containers have stopped.
export async function runIsolatedTests(
  commands,
  {
    root = path.join(tmpdir(), "jgw-test-jobs-" + process.getuid()),
    leaseRoot = root,
    cwd = repository,
  } = {},
) {
  if (
    !Array.isArray(commands) ||
    !commands.length ||
    commands.some((command) => !Array.isArray(command) || !command.length)
  )
    throw failure("invalid_test_command");
  await ownedDirectory(root);
  await ownedDirectory(leaseRoot);
  const disk = await statfs(root, { bigint: true });
  if (disk.bavail * disk.bsize < 256n * 1024n * 1024n)
    throw failure("test_capacity_insufficient");
  const lease = leaseRoot + "/active";
  try {
    await mkdir(lease, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw Object.assign(failure("test_resource_busy"), { lease });
    throw error;
  }
  let work,
    exit = 1,
    unsettled = false;
  const identity = await lstat(lease);
  try {
    work = await mkdtemp(root + "/run-");
    await writeFile(
      lease + "/owner.json",
      JSON.stringify({ pid: process.pid, work }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const env = {
      ...process.env,
      TMPDIR: work,
      TMP: work,
      TEMP: work,
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    delete env.NODE_COMPILE_CACHE;
    for (const [command, ...args] of commands) {
      exit = await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env,
          detached: true,
          shell: false,
          stdio: "inherit",
        });
        const forward = (signal) => {
          if (child.pid)
            try {
              process.kill(-child.pid, signal);
            } catch (error) {
              if (error.code !== "ESRCH") unsettled = true;
            }
        };
        const terminate = () => forward("SIGTERM");
        process.once("SIGINT", terminate);
        process.once("SIGTERM", terminate);
        child.once("error", reject);
        child.once("close", async (code) => {
          process.removeListener("SIGINT", terminate);
          process.removeListener("SIGTERM", terminate);
          forward("SIGKILL");
          if (child.pid) {
            let alive = true;
            for (let i = 0; i < 50; i++) {
              try {
                process.kill(-child.pid, 0);
              } catch (error) {
                if (error.code === "ESRCH") {
                  alive = false;
                  break;
                }
                unsettled = true;
                break;
              }
              await delay(100);
            }
            unsettled ||= alive;
          }
          resolve(code ?? 1);
        });
      });
      if (exit !== 0 || unsettled) break;
    }
    if (unsettled) throw failure("test_process_group_unsettled");
    return exit;
  } finally {
    const current = await lstat(lease);
    if (
      current.uid !== process.getuid() ||
      current.ino !== identity.ino ||
      current.dev !== identity.dev
    )
      throw failure("test_lease_changed");
    if (!unsettled) {
      if (exit === 0 && work) await rm(work, { recursive: true });
      else if (work)
        process.stderr.write("Failed test files retained: " + work + "\n");
      await rm(lease, { recursive: true });
    }
  }
}
const files = {
  agent: [
    "reconciler.test",
    "preparation.test",
    "base-bootstrap.test",
    "test-resources.test",
  ],
  storage: ["storage.integration.test"],
  unpack: ["unpack.integration.test"],
  products: ["products.integration.test"],
  bundles: ["bundles.integration.test"],
  database: ["database.integration.test"],
  tls: ["tls-credentials.integration.test"],
  "web-cleanup": ["web-cleanup.integration.test"],
  native: ["native-install.integration.test"],
};
export function isolatedCommands(kind, npmCli) {
  const npm = (script) => [process.execPath, npmCli, "run", script];
  if (kind === "check")
    return [
      npm("build"),
      npm("typecheck"),
      [
        process.execPath,
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.config.ts",
      ],
      npm("lint"),
      npm("format:check"),
    ];
  if (kind === "integration")
    return [
      npm("build"),
      [process.execPath, "scripts/run-bff-integration.mjs"],
    ];
  if (files[kind])
    return [
      [
        process.execPath,
        "--test",
        ...files[kind].map((name) => "tests/agent/" + name + ".mjs"),
      ],
    ];
  throw failure("invalid_test_kind");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const cli = process.env.npm_execpath;
    if (!cli || !(await readFile(cli)).length || process.argv.length !== 3)
      throw failure("invalid_test_arguments");
    process.exitCode = await runIsolatedTests(
      isolatedCommands(process.argv[2], cli),
      { leaseRoot: "/tmp/jgw-suite-test-jobs-" + process.getuid() },
    );
  } catch (error) {
    process.stderr.write(
      (error.code ?? "isolated_test_failed") +
        (error.lease ? ": " + error.lease : "") +
        "\n",
    );
    process.exitCode = 1;
  }
}
