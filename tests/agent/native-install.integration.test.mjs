import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderPostgresCompose,
  renderPostgresUnit,
  OsBootstrap,
} from "../../deploy/agent/os-bootstrap.mjs";
import {
  renderWebFirewall,
  renderWebUnits,
  NativeWebHosting,
} from "../../deploy/agent/native-web.mjs";
import {
  renderProvisionAgentUnits,
  activatePreparedProvisionAgent,
} from "../../deploy/agent/agent-install.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";

const pg = {
  tenant: "native-fixture",
  image: "postgres:18.6-bookworm@sha256:" + "1".repeat(64),
  dataRoot: "/var/lib/jgw-postgres",
  passwordFile: "/etc/jgw-input/postgres-password",
  port: 5438,
};
test("PostgreSQL Compose stays pinned, loopback-only and secret-file backed; unit shutdown retains volumes", () => {
  const service = JSON.parse(renderPostgresCompose(pg)).services.postgres;
  assert.deepEqual(service.ports, ["127.0.0.1:5438:5432"]);
  assert.equal(service.environment.POSTGRES_PASSWORD, undefined);
  assert.equal(
    service.environment.POSTGRES_PASSWORD_FILE,
    "/run/secrets/postgres_password",
  );
  assert.equal(service.pull_policy, "never");
  assert.equal(service.volumes[0].bind.create_host_path, false);
  assert(!renderPostgresUnit("/etc/jgw/os", pg.tenant).includes("down"));
  assert.throws(() => renderPostgresCompose({ ...pg, port: 3001 }));
  assert.throws(() =>
    renderPostgresCompose({ ...pg, image: "postgres:latest" }),
  );
});
test("Web rules and auxiliary units own fixed files without global firewall reset or shell access", () => {
  const firewall = renderWebFirewall({
    sftpPort: 2222,
    ftpsPort: 21,
    passiveMin: 56110,
    passiveMax: 56119,
  });
  assert(
    firewall.includes("table inet jgw_web") &&
      !firewall.includes("flush") &&
      !firewall.includes("policy drop"),
  );
  assert.throws(() =>
    renderWebFirewall({
      sftpPort: 3001,
      ftpsPort: 21,
      passiveMin: 56110,
      passiveMax: 56119,
    }),
  );
  assert.throws(() =>
    renderWebFirewall({
      sftpPort: 2222,
      ftpsPort: 21,
      passiveMin: 3000,
      passiveMax: 3002,
    }),
  );
  assert(
    renderWebUnits()["sshd-jweb.service"].includes("-f /etc/jweb/sshd_config"),
  );
  assert(
    renderProvisionAgentUnits("/opt/jgw/bundles")[
      "jgw-provision-agent.timer"
    ].includes("OnUnitActiveSec=60s"),
  );
});
test("native activation requires root and an OS package source cannot omit the foundation", async () => {
  await assert.rejects(activatePreparedProvisionAgent(), {
    code: "root_required",
  });
  assert.throws(
    () =>
      new OsBootstrap({
        tenant: pg.tenant,
        profile: {
          packages: [],
          node: {
            file: "/opt/input/node",
            version: "v22.18.0",
            sha256: "1".repeat(64),
          },
          caFile: "/opt/input/ca.crt",
          postgres: {
            image: pg.image,
            dataRoot: pg.dataRoot,
            passwordFile: pg.passwordFile,
            port: pg.port,
          },
        },
      }),
    { code: "os_packages_unbound" },
  );
  assert.throws(
    () =>
      new NativeWebHosting({
        tenant: pg.tenant,
        bundleRoot: "/opt/bundles",
        unitRoot: "/run/units",
        stateRoot: "/var/lib/installer",
        profile: {},
      }),
    { code: "invalid_web_installation" },
  );
  assert.throws(
    () => execute("/usr/bin/true", [], { maximum: 5 * 1024 * 1024 }),
    { code: "invalid_output_limit" },
  );
});
