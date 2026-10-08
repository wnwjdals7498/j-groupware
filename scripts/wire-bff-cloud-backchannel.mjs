// Isolated test-only Docker wiring; host DNS and CA stores are unchanged.
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repo = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.resolve(repo, "../.suite-runtime/j-groupware");
const auth = path.resolve(repo, "../.suite-runtime/j-auth");
const file = runtime + "/integration.env",
  text = await readFile(file, "utf8");
const env = Object.fromEntries(
  text
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
if (env.JGW_TEST_RUNTIME !== "isolated-cloud")
  throw new Error("Only isolated cloud fixtures may be wired.");
function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error("Isolated Docker wiring failed.");
  return r.stdout;
}
const state = JSON.parse(
  docker(["inspect", "j-auth-cloud-test-keycloak-1"]),
)[0];
if (state.Config.Labels["com.docker.compose.project"] !== "j-auth-cloud-test")
  throw new Error("Non-test container refused.");
const gateway =
  state.NetworkSettings.Networks["j-auth-cloud-test_default"]?.Gateway;
if (!/^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(gateway ?? ""))
  throw new Error("Private test bridge required.");
const hosts = [env.JGW_TEST_TENANT_A, env.JGW_TEST_TENANT_B].map((tenant) => {
  if (!/^bff-[ab]-[a-f0-9]{8}$/.test(tenant))
    throw new Error("Unexpected fixture tenant.");
  return "gw." + tenant + ".jgw.test:" + gateway;
});
const current = Object.fromEntries(
  state.Config.Env.map((value) => {
    const i = value.indexOf("=");
    return [value.slice(0, i), value.slice(i + 1)];
  }),
);
const noProxy = [
  current.no_proxy ?? current.NO_PROXY ?? "",
  ...hosts.map((host) => host.split(":")[0]),
  gateway,
]
  .filter(Boolean)
  .join(",");
const override = runtime + "/keycloak-backchannel.yaml";
await writeFile(
  override,
  JSON.stringify({
    services: {
      keycloak: {
        extra_hosts: hosts,
        environment: {
          KC_LOG_LEVEL: "INFO",
          NO_PROXY: noProxy,
          no_proxy: noProxy,
        },
        volumes: [
          {
            type: "bind",
            source: env.JGW_TLS_CERTIFICATE,
            target: "/opt/keycloak/conf/truststores/j-groupware-cloud-test.pem",
            read_only: true,
          },
        ],
      },
    },
  }),
  { mode: 0o600 },
);
docker([
  "compose",
  "--env-file",
  auth + "/compose.env",
  "-f",
  path.resolve(repo, "../j-auth/deploy/compose.yaml"),
  "-f",
  auth + "/compose.integration.yaml",
  "-f",
  override,
  "-p",
  "j-auth-cloud-test",
  "up",
  "-d",
  "keycloak",
]);
await writeFile(
  file,
  text
    .split("\n")
    .filter((line) => !line.startsWith("JGW_TEST_BIND_IP="))
    .join("\n")
    .trimEnd() + `\nJGW_TEST_BIND_IP=${gateway}\n`,
  { mode: 0o600 },
);
console.log(
  "Wired persistent container-only fixture DNS and trusted BFF CA on the private Docker bridge. TLS checks remain enabled.",
);
