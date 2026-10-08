import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repository = fileURLToPath(new URL("../", import.meta.url));
try {
  const env = await realpath(
    process.env.JGW_TEST_ENV ??
      path.resolve(repository, "../.suite-runtime/j-groupware/integration.env"),
  );
  if (!path.relative(repository, env).startsWith(".." + path.sep))
    throw new Error();
  const child = spawn(
    process.execPath,
    [
      `--env-file=${env}`,
      path.join(repository, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.integration.config.ts",
      ...process.argv.slice(2),
    ],
    {
      cwd: repository,
      env: { ...process.env, JGW_TEST_ENV: env },
      shell: false,
      stdio: "inherit",
    },
  );
  child.once("error", () => {
    process.stderr.write("Could not start BFF integration tests.\n");
    process.exitCode = 1;
  });
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
  });
} catch {
  process.stderr.write(
    "BFF integration requires an external isolated cloud test env. No tests were run.\n",
  );
  process.exitCode = 1;
}
