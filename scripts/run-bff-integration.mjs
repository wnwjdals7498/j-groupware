import { spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
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
  const runtime = { ...parseEnv(await readFile(env, "utf8")), ...process.env };
  if (
    runtime.JGW_TEST_RUNTIME !== "isolated-cloud" ||
    runtime.JAUTH_TEST_RUNTIME !== "isolated-cloud"
  )
    throw new Error();
  const certificates = await Promise.all(
    [
      ...new Set(
        [
          runtime.JAUTH_TLS_CERTIFICATE,
          runtime.JGW_TLS_CERTIFICATE,
          runtime.NODE_EXTRA_CA_CERTS,
        ].filter(Boolean),
      ),
    ].map((file) => readFile(file, "utf8")),
  );
  const trustBundle = env + ".trust.pem";
  await writeFile(trustBundle, certificates.join("\n"), { mode: 0o600 });
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
      env: {
        ...process.env,
        JGW_TEST_ENV: env,
        NODE_EXTRA_CA_CERTS: trustBundle,
      },
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
