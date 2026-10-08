import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repository = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.resolve(repository, "../.suite-runtime/j-groupware");
const authEnv = path.resolve(
  repository,
  "../.suite-runtime/j-auth/integration.env",
);
try {
  await access(runtime + "/integration.env");
  throw new Error(
    "Existing BFF runtime is preserved; refusing to replace secrets.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const auth = Object.fromEntries(
  (await readFile(authEnv, "utf8"))
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
if (auth.JAUTH_TEST_RUNTIME !== "isolated-cloud")
  throw new Error("Require the existing isolated j-auth test runtime.");
await mkdir(runtime + "/tls", { recursive: true, mode: 0o700 });
const a = "bff-a-" + randomUUID().slice(0, 8),
  b = "bff-b-" + randomUUID().slice(0, 8);
const env = {
  ...auth,
  JGW_TEST_RUNTIME: "isolated-cloud",
  JGW_TEST_TENANT_A: a,
  JGW_TEST_TENANT_B: b,
  JGW_DB_PASSWORD: randomBytes(32).toString("base64url"),
  JGW_DB_PORT: "54232",
  JGW_PORT: "54233",
  JGW_TLS_CERTIFICATE: runtime + "/tls/server.crt",
  JGW_TLS_KEY: runtime + "/tls/server.key",
  JAUTH_TEST_ENV: authEnv,
};
await writeFile(
  runtime + "/integration.env",
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join(""),
  { mode: 0o600, flag: "wx" },
);
await writeFile(
  runtime + "/compose.env",
  `JGW_RUNTIME_DIR=${runtime}\nJGW_DB_PASSWORD=${env.JGW_DB_PASSWORD}\nPOSTGRES_SUPERUSER_PASSWORD=${randomBytes(32).toString("base64url")}\n`,
  { mode: 0o600, flag: "wx" },
);
await writeFile(
  runtime + "/compose.yaml",
  `services:\n  postgres:\n    image: postgres:18.6-bookworm\n    environment:\n      POSTGRES_PASSWORD: \${POSTGRES_SUPERUSER_PASSWORD}\n      JGW_DB_PASSWORD: \${JGW_DB_PASSWORD}\n    ports: ["127.0.0.1:54232:5432"]\n    volumes:\n      - \${JGW_RUNTIME_DIR}/postgres:/var/lib/postgresql\n      - ${repository}/tests/bff/postgres-init.sh:/docker-entrypoint-initdb.d/01-bff.sh:ro\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 2s\n      timeout: 2s\n      retries: 30\n`,
  { mode: 0o600, flag: "wx" },
);
const result = spawnSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:3072",
    "-sha256",
    "-nodes",
    "-keyout",
    runtime + "/tls/server.key",
    "-out",
    runtime + "/tls/server.crt",
    "-days",
    "30",
    "-subj",
    "/CN=gw." + a + ".jgw.test",
    "-addext",
    `subjectAltName=DNS:gw.${a}.jgw.test,DNS:gw.${b}.jgw.test,DNS:localhost,IP:127.0.0.1`,
  ],
  { stdio: "ignore" },
);
if (result.status !== 0) throw new Error("BFF certificate generation failed.");
console.log(
  "Prepared isolated BFF env and TLS outside checkout; existing j-auth credentials preserved.",
);
