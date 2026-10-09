import { lstat, readFile, rm } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { readControlFile, readControlJson } from "./control-files.mjs";
import {
  installationDirectory,
  installationFile,
  installationDigest,
} from "./install-files.mjs";
import { protectedStoragePath } from "./product-storage.mjs";
import { externalPath, execute } from "../gateway/gateway.mjs";
import { renderGatewayUnit } from "./native-gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";

const env = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  DEBIAN_FRONTEND: "noninteractive",
};
const exact = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...fields].sort().join();
const fail = (code = "invalid_os_bootstrap") => {
  throw new ProvisionError(code);
};
export async function requireSystemdVm() {
  if (process.getuid() !== 0) fail("root_required");
  if ((await readFile("/proc/1/comm", "utf8")).trim() !== "systemd")
    fail("systemd_vm_required");
}
export const OS_REQUIRED_PACKAGES = Object.freeze([
  "nginx",
  "postgresql-client-18",
  "docker-ce",
  "docker-ce-cli",
  "containerd.io",
  "docker-compose-plugin",
  "ca-certificates",
  "openssl",
  "sudo",
  "openssh-server",
  "vsftpd",
  "nftables",
  "gettext-base",
  "passwd",
  "procps",
  "tar",
  "gzip",
  "curl",
]);
export function renderPostgresCompose({
  tenant,
  image,
  dataRoot,
  passwordFile,
  port,
}) {
  if (
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant) ||
    !/^postgres:18\.6-bookworm@sha256:[a-f0-9]{64}$/.test(image) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    port === 3001
  )
    fail();
  [dataRoot, passwordFile].forEach(externalPath);
  return (
    JSON.stringify({
      services: {
        postgres: {
          image,
          pull_policy: "never",
          restart: "unless-stopped",
          labels: {
            "jgw.managed": "1",
            "jgw.tenant": tenant,
            "jgw.service": "postgres",
          },
          environment: {
            POSTGRES_USER: "postgres",
            POSTGRES_DB: "postgres",
            POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password",
          },
          secrets: ["postgres_password"],
          ports: ["127.0.0.1:" + port + ":5432"],
          volumes: [
            {
              type: "bind",
              source: dataRoot,
              target: "/var/lib/postgresql",
              bind: { create_host_path: false },
            },
          ],
          healthcheck: {
            test: ["CMD", "pg_isready", "-U", "postgres", "-d", "postgres"],
            interval: "2s",
            timeout: "2s",
            retries: 30,
          },
        },
      },
      secrets: { postgres_password: { file: passwordFile } },
    }) + "\n"
  );
}
export function renderPostgresUnit(stateRoot, tenant) {
  for (const value of [stateRoot]) {
    externalPath(value);
    if (!/^[a-zA-Z0-9_./-]+$/.test(value)) fail();
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) fail();
  const args = `--project-directory ${stateRoot} --file ${stateRoot}/compose.json --project-name jgw-pg-${tenant}`;
  return `[Unit]\nDescription=J Groupware PostgreSQL 18\nRequires=docker.service\nAfter=docker.service network-online.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nWorkingDirectory=${stateRoot}\nExecStart=/usr/bin/docker compose ${args} up --detach --wait --wait-timeout 90 --pull never\nExecStop=/usr/bin/docker compose ${args} stop --timeout 30\nTimeoutStartSec=120\nTimeoutStopSec=60\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
}
// Offline exact-version Debian artifacts. No apt repository edits, network pulls,
// secret issuance, OS PostgreSQL server or activation during preflight/prepare.
export class OsBootstrap {
  constructor({
    tenant,
    stateRoot = "/etc/jgw/os",
    unitRoot = "/etc/systemd/system",
    profile,
  }) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant) ||
      !exact(profile, ["packages", "node", "caFile", "postgres"]) ||
      !Array.isArray(profile.packages) ||
      profile.packages.length > 300 ||
      !exact(profile.node, ["file", "sha256", "version"]) ||
      !/^v(?:22\.(?:1[89]|[2-9][0-9])|24\.[0-9]+)\.[0-9]+$/.test(
        profile.node.version,
      ) ||
      !exact(profile.postgres, ["image", "dataRoot", "port", "passwordFile"])
    )
      fail();
    [
      stateRoot,
      unitRoot,
      profile.node.file,
      profile.caFile,
      profile.postgres.dataRoot,
      profile.postgres.passwordFile,
    ].forEach(externalPath);
    if (!/^[a-f0-9]{64}$/.test(profile.node.sha256)) fail();
    const names = new Set();
    for (const pkg of profile.packages) {
      if (
        !exact(pkg, ["name", "version", "architecture", "sha256", "file"]) ||
        !/^[a-z0-9][a-z0-9+.-]+$/.test(pkg.name) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9:+.~-]{0,127}$/.test(pkg.version) ||
        !["amd64", "arm64", "all"].includes(pkg.architecture) ||
        !/^[a-f0-9]{64}$/.test(pkg.sha256) ||
        names.has(pkg.name)
      )
        fail();
      names.add(pkg.name);
      externalPath(pkg.file);
    }
    if (OS_REQUIRED_PACKAGES.some((name) => !names.has(name)))
      fail("os_packages_unbound");
    const outputs = [
      stateRoot,
      unitRoot,
      profile.postgres.dataRoot,
      "/usr/bin/node",
      "/usr/local/share/ca-certificates/jgw-" + tenant + ".crt",
    ];
    if (
      outputs.some((root, index) =>
        outputs.some(
          (other, otherIndex) =>
            index !== otherIndex &&
            (other === root || other.startsWith(root + "/")),
        ),
      )
    )
      fail("overlapping_os_bootstrap");
    for (const input of [
      profile.node.file,
      profile.caFile,
      profile.postgres.passwordFile,
      ...profile.packages.map((pkg) => pkg.file),
    ])
      if (
        outputs.some((root) => input === root || input.startsWith(root + "/"))
      )
        fail("overlapping_os_bootstrap");
    renderPostgresCompose({ tenant, ...profile.postgres });
    Object.assign(this, { tenant, stateRoot, unitRoot, profile });
  }
  root() {
    if (process.platform !== "linux" || process.getuid() !== 0)
      fail("root_required");
  }
  async preflight() {
    this.root();
    await protectedStoragePath("/usr/lib/os-release", false);
    const release = await readFile("/usr/lib/os-release", "utf8");
    if (!/^ID=debian$/m.test(release) || !/^VERSION_ID="12"$/m.test(release))
      fail("unsupported_os");
    for (const binary of ["/usr/bin/dpkg", "/usr/bin/dpkg-deb"])
      await protectedStoragePath(binary, false);
    const architecture = (
      await execute("/usr/bin/dpkg", ["--print-architecture"], { env })
    ).trim();
    for (const pkg of this.profile.packages) {
      await protectedStoragePath(pkg.file, false);
      const info = await lstat(pkg.file);
      if (
        info.nlink !== 1 ||
        info.size > 256 * 1024 * 1024 ||
        installationDigest(await readFile(pkg.file)) !== pkg.sha256
      )
        fail("os_artifact_mismatch");
      const metadata = await execute(
        "/usr/bin/dpkg-deb",
        ["--field", pkg.file, "Package", "Version", "Architecture"],
        { env },
      );
      if (
        metadata !==
          `Package: ${pkg.name}\nVersion: ${pkg.version}\nArchitecture: ${pkg.architecture}\n` ||
        ![architecture, "all"].includes(pkg.architecture)
      )
        fail("os_artifact_mismatch");
    }
    await protectedStoragePath(this.profile.node.file, false);
    const node = await lstat(this.profile.node.file);
    if (
      node.nlink !== 1 ||
      !(node.mode & 0o111) ||
      node.size > 150 * 1024 * 1024 ||
      installationDigest(await readFile(this.profile.node.file)) !==
        this.profile.node.sha256 ||
      (await execute(this.profile.node.file, ["--version"], { env })).trim() !==
        this.profile.node.version
    )
      fail("node_artifact_mismatch");
    const ca = new X509Certificate(
      await readControlFile(this.profile.caFile, { privateFile: false }),
    );
    if (
      !ca.ca ||
      Date.parse(ca.validFrom) > Date.now() ||
      Date.parse(ca.validTo) <= Date.now()
    )
      fail("invalid_ca");
    if (
      !/^[A-Za-z0-9_-]{43}\n$/.test(
        await readControlFile(this.profile.postgres.passwordFile),
      )
    )
      fail("invalid_postgres_password");
    return { tenant: this.tenant, phase: "os_artifacts_verified" };
  }
  async prepare() {
    await this.preflight();
    await installationDirectory(this.stateRoot, 0o700);
    await installationFile(
      this.stateRoot + "/installation.json",
      JSON.stringify({
        format: 1,
        tenant: this.tenant,
        profile: this.profile,
      }) + "\n",
    );
    await installationFile(
      this.stateRoot + "/compose.json",
      renderPostgresCompose({ tenant: this.tenant, ...this.profile.postgres }),
    );
    await installationDirectory(this.unitRoot);
    await installationFile(
      this.unitRoot + "/jgw-postgres.service",
      renderPostgresUnit(this.stateRoot, this.tenant),
      0o644,
    );
    await installationFile(
      this.unitRoot + "/jgw-gateway.service",
      renderGatewayUnit(),
      0o644,
    );
    return { tenant: this.tenant, phase: "os_prepared", activation: "pending" };
  }
  async requirePrepared() {
    await this.preflight();
    const receipt = await readControlJson(
      this.stateRoot + "/installation.json",
      262144,
    );
    if (
      JSON.stringify(receipt) !==
        JSON.stringify({
          format: 1,
          tenant: this.tenant,
          profile: this.profile,
        }) ||
      (await readControlFile(this.stateRoot + "/compose.json")) !==
        renderPostgresCompose({
          tenant: this.tenant,
          ...this.profile.postgres,
        }) ||
      (await readControlFile(this.unitRoot + "/jgw-postgres.service", {
        privateFile: false,
      })) !== renderPostgresUnit(this.stateRoot, this.tenant)
    )
      fail("os_installation_conflict");
    if (
      (await readControlFile(this.unitRoot + "/jgw-gateway.service", {
        privateFile: false,
      })) !== renderGatewayUnit()
    )
      fail("os_installation_conflict");
  }
  async applyPackages() {
    await this.requirePrepared();
    if (
      this.unitRoot !== "/etc/systemd/system" ||
      this.stateRoot !== "/etc/jgw/os"
    )
      fail("invalid_activation_target");
    await requireSystemdVm();
    await protectedStoragePath("/usr/bin/systemctl", false);
    const stockState = (
      await execute(
        "/usr/bin/systemctl",
        ["show", "nginx.service", "--property=UnitFileState", "--value"],
        { env },
      )
    ).trim();
    if (!["", "disabled", "static", "not-found"].includes(stockState))
      fail("unmanaged_gateway_enabled");
    const guard = "/usr/sbin/policy-rc.d",
      text = "#!/bin/sh\nexit 101\n";
    // Never overwrite/adopt an operator policy. Our own guard prevents package
    // post-install scripts from starting daemons before configuration is ready.
    await installationDirectory("/usr/sbin");
    const created = await installationFile(guard, text, 0o755);
    try {
      await execute(
        "/usr/bin/dpkg",
        [
          "--force-confdef",
          "--force-confold",
          "--install",
          ...this.profile.packages.map((pkg) => pkg.file),
        ],
        { env, timeout: 300000, maximum: 4 * 1024 * 1024 },
      );
    } finally {
      if (created) {
        await protectedStoragePath(guard, false);
        if ((await readFile(guard, "utf8")) !== text)
          fail("package_policy_changed");
        await rm(guard);
      }
    }
    for (const pkg of this.profile.packages) {
      const installed = await execute(
        "/usr/bin/dpkg-query",
        [
          "--show",
          "--showformat=${Status}\t${Version}\t${Architecture}\n",
          pkg.name,
        ],
        { env },
      );
      if (
        installed !==
        `install ok installed\t${pkg.version}\t${pkg.architecture}\n`
      )
        fail("os_package_not_ready");
    }
    // This was absent/disabled before installation. Prevent the distribution
    // unit enabled by package scripts from racing our owned PID-path unit at boot.
    await execute("/usr/bin/systemctl", ["disable", "nginx.service"], { env });
    await installationFile(
      "/usr/bin/node",
      await readFile(this.profile.node.file),
      0o555,
    );
    await installationDirectory("/usr/local/share/ca-certificates");
    await installationFile(
      "/usr/local/share/ca-certificates/jgw-" + this.tenant + ".crt",
      await readControlFile(this.profile.caFile, { privateFile: false }),
      0o644,
    );
    await protectedStoragePath("/usr/sbin/update-ca-certificates", false);
    await execute("/usr/sbin/update-ca-certificates", [], {
      env,
      timeout: 60000,
    });
    return {
      tenant: this.tenant,
      phase: "os_packages_installed",
      activation: "pending",
    };
  }
  async startPostgres() {
    await this.requirePrepared();
    if (
      this.unitRoot !== "/etc/systemd/system" ||
      this.stateRoot !== "/etc/jgw/os"
    )
      fail("invalid_activation_target");
    await requireSystemdVm();
    for (const binary of ["/usr/bin/docker", "/usr/bin/systemctl"])
      await protectedStoragePath(binary, false);
    const dataRoot = this.profile.postgres.dataRoot;
    await installationDirectory(dataRoot);
    const directory = await lstat(dataRoot);
    const dataIdentity = {
      format: 1,
      tenant: this.tenant,
      root: dataRoot,
      dev: directory.dev,
      ino: directory.ino,
    };
    try {
      if (
        JSON.stringify(
          await readControlJson(this.stateRoot + "/postgres-data.json", 8192),
        ) !== JSON.stringify(dataIdentity)
      )
        fail("unmanaged_postgres_data");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const { readdir } = await import("node:fs/promises");
      if ((await readdir(dataRoot)).length) fail("unmanaged_postgres_data");
      await installationFile(
        this.stateRoot + "/postgres-data.json",
        JSON.stringify(dataIdentity) + "\n",
      );
    }
    const images = JSON.parse(
      await execute(
        "/usr/bin/docker",
        ["image", "inspect", this.profile.postgres.image],
        { env },
      ),
    );
    if (
      images.length !== 1 ||
      !images[0]?.RepoDigests?.includes(
        "postgres@" + this.profile.postgres.image.split("@")[1],
      )
    )
      fail("postgres_image_unbound");
    const project = "jgw-pg-" + this.tenant;
    const ids = (
      await execute(
        "/usr/bin/docker",
        [
          "container",
          "ls",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          "label=com.docker.compose.project=" + project,
        ],
        { env },
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (ids.length > 1) fail("unmanaged_postgres");
    if (ids.length) {
      const [container] = JSON.parse(
        await execute("/usr/bin/docker", ["container", "inspect", ids[0]], {
          env,
        }),
      );
      const labels = container?.Config?.Labels;
      if (
        labels?.["jgw.managed"] !== "1" ||
        labels["jgw.tenant"] !== this.tenant ||
        labels["jgw.service"] !== "postgres" ||
        labels["com.docker.compose.service"] !== "postgres" ||
        container.Config.Image !== this.profile.postgres.image ||
        container.Image !== images[0].Id ||
        container.HostConfig.Privileged ||
        !container.Mounts?.some(
          (mount) =>
            mount.Type === "bind" &&
            mount.Source === this.profile.postgres.dataRoot &&
            mount.Destination === "/var/lib/postgresql" &&
            mount.RW,
        ) ||
        JSON.stringify(container.HostConfig.PortBindings) !==
          JSON.stringify({
            "5432/tcp": [
              {
                HostIp: "127.0.0.1",
                HostPort: String(this.profile.postgres.port),
              },
            ],
          })
      )
        fail("unmanaged_postgres");
    }
    await execute("/usr/bin/systemctl", ["daemon-reload"], { env });
    await execute(
      "/usr/bin/systemctl",
      ["enable", "--now", "jgw-postgres.service"],
      { env, timeout: 120000 },
    );
    await execute(
      "/usr/bin/docker",
      [
        "compose",
        "--project-directory",
        this.stateRoot,
        "--file",
        this.stateRoot + "/compose.json",
        "--project-name",
        project,
        "exec",
        "--no-TTY",
        "postgres",
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      { env },
    );
    return { tenant: this.tenant, phase: "postgres_ready" };
  }
}
