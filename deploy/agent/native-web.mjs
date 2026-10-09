import { lstat, readFile } from "node:fs/promises";
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import path from "node:path";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { readControlFile, readControlJson } from "./control-files.mjs";
import { protectedStoragePath } from "./product-storage.mjs";
import {
  installationDirectory,
  installationFile,
  installationDigest,
} from "./install-files.mjs";
import { externalPath, execute } from "../gateway/gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";
import { parseUnitObservation } from "./unit-observation.mjs";

const fail = (code = "invalid_web_installation") => {
  throw new ProvisionError(code);
};
const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
const port = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 65535 || value === 3001)
    fail();
  return value;
};
export function renderWebUnits() {
  return {
    "sshd-jweb.service":
      "[Unit]\nDescription=J Web isolated SFTP\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/sbin/sshd -D -e -f /etc/jweb/sshd_config\nExecReload=/bin/kill -HUP $MAINPID\nKillMode=control-group\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n",
    "vsftpd-jweb.service":
      "[Unit]\nDescription=J Web explicit TLS FTPS\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/usr/sbin/vsftpd /etc/jweb/vsftpd.conf\nKillMode=control-group\nRestart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n",
  };
}
export function renderWebFirewall({
  sftpPort,
  ftpsPort,
  passiveMin,
  passiveMax,
}) {
  [sftpPort, ftpsPort, passiveMin, passiveMax].forEach(port);
  if (passiveMin > passiveMax || (passiveMin <= 3001 && passiveMax >= 3001))
    fail();
  // Only an owned table. No global flush, management-SSH policy or unrelated chain changes.
  return `table inet jgw_web {\n chain input {\n  type filter hook input priority 0; policy accept;\n  tcp dport { 443, ${sftpPort}, ${ftpsPort}, ${passiveMin}-${passiveMax} } accept\n }\n}\n`;
}
export class NativeWebHosting {
  constructor({ tenant, bundleRoot, unitRoot, stateRoot, profile }) {
    assertCustomerTenantId(tenant);
    [bundleRoot, unitRoot, stateRoot].forEach(externalPath);
    const fields = [
      "caCertificate",
      "caKey",
      "ftpsCertificate",
      "ftpsKey",
      "sshHostKey",
      "sftpPort",
      "ftpsPort",
      "passiveMin",
      "passiveMax",
      "backupMaxBytes",
      "backupMaxEntries",
    ];
    if (!profile || Object.keys(profile).sort().join() !== fields.sort().join())
      fail();
    for (const name of [
      "caCertificate",
      "caKey",
      "ftpsCertificate",
      "ftpsKey",
      "sshHostKey",
    ])
      externalPath(profile[name]);
    [
      profile.sftpPort,
      profile.ftpsPort,
      profile.passiveMin,
      profile.passiveMax,
    ].forEach(port);
    if (
      profile.passiveMin > profile.passiveMax ||
      profile.passiveMax - profile.passiveMin > 1000 ||
      [profile.sftpPort, profile.ftpsPort, 443].some(
        (p) => p >= profile.passiveMin && p <= profile.passiveMax,
      ) ||
      new Set([profile.sftpPort, profile.ftpsPort, 443]).size !== 3 ||
      !Number.isSafeInteger(profile.backupMaxBytes) ||
      profile.backupMaxBytes < 1 ||
      profile.backupMaxBytes > 20 * 1024 ** 3 ||
      !Number.isSafeInteger(profile.backupMaxEntries) ||
      profile.backupMaxEntries < 1 ||
      profile.backupMaxEntries > 100000
    )
      fail();
    renderWebFirewall(profile);
    Object.assign(this, { tenant, bundleRoot, unitRoot, stateRoot, profile });
    this.receipt = stateRoot + "/web-installation.json";
  }
  async material() {
    const p = this.profile;
    const ca = await readControlFile(p.caCertificate, { privateFile: false }),
      caKey = await readControlFile(p.caKey),
      certificate = await readControlFile(p.ftpsCertificate, {
        privateFile: false,
      }),
      key = await readControlFile(p.ftpsKey),
      ssh = await readControlFile(p.sshHostKey);
    try {
      const root = new X509Certificate(ca),
        leaf = new X509Certificate(certificate),
        signer = createPrivateKey(caKey),
        actor = createPrivateKey(key);
      if (
        !root.ca ||
        leaf.ca ||
        !root.checkPrivateKey(signer) ||
        !leaf.checkPrivateKey(actor) ||
        !leaf.verify(root.publicKey) ||
        !leaf.checkIssued(root) ||
        [root, leaf].some(
          (c) =>
            Date.parse(c.validFrom) > Date.now() ||
            Date.parse(c.validTo) <= Date.now(),
        ) ||
        createPublicKey(signer)
          .export({ type: "spki", format: "der" })
          .equals(
            createPublicKey(actor).export({ type: "spki", format: "der" }),
          )
      )
        fail();
      // Existing OpenSSH private host key, never ssh-keygen/credential generation.
      if (
        !ssh.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n") ||
        !ssh.endsWith("-----END OPENSSH PRIVATE KEY-----\n")
      )
        fail();
    } catch {
      fail("invalid_web_credentials");
    }
    return { ca, caKey, certificate, key, ssh };
  }
  async assets() {
    const root = this.bundleRoot + "/j-web";
    const inventory = JSON.parse(
      await readControlFile(root + "/jgw-bundle-files.json", {
        privateFile: false,
        maximum: 4 * 1024 * 1024,
      }),
    );
    if (inventory.service !== "j-web" || !Array.isArray(inventory.sourceFiles))
      fail();
    const files = {};
    for (const name of [
      "deploy/jweb-helper.mjs",
      "apps/server/dist/disk-cli.js",
      "apps/server/dist/disk.js",
      "deploy/hosting/jweb.sudoers",
      "deploy/hosting/sshd_config",
      "deploy/hosting/vsftpd.conf",
    ]) {
      const row = inventory.sourceFiles.find((f) => f.path === name);
      const text = await readControlFile(root + "/" + name, {
        privateFile: false,
        maximum: 262144,
      });
      if (!row || row.sha256 !== installationDigest(text))
        fail("web_bundle_conflict");
      files[name] = text;
    }
    return files;
  }
  async preflight() {
    if (process.getuid() !== 0) fail("root_required");
    await this.material();
    await this.assets();
    await this.group();
    for (const binary of [
      "/usr/sbin/sshd",
      "/usr/sbin/vsftpd",
      "/usr/sbin/visudo",
      "/usr/sbin/nginx",
      "/usr/sbin/nft",
    ])
      await protectedStoragePath(binary, false);
    const result = JSON.parse(
      await execute(
        "/usr/bin/node",
        [this.bundleRoot + "/j-web/apps/server/dist/disk-cli.js"],
        { env },
      ),
    );
    if (result?.root !== "/srv/jweb") fail("web_data_disk_required");
  }
  async group() {
    const rows = (await execute("/usr/bin/getent", ["group"], { env }))
      .split("\n")
      .filter((row) => row.startsWith("jweb-sftp:"));
    if (rows.length > 1) fail("unmanaged_web_group");
    let receipt;
    try {
      receipt = await readControlJson(this.stateRoot + "/web-group.json", 8192);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!rows.length) {
      if (receipt) fail("unmanaged_web_group");
      return undefined;
    }
    const [name, password, gid, members] = rows[0].split(":");
    if (
      !receipt ||
      Object.keys(receipt).sort().join() !== "format,gid,name,tenant" ||
      receipt.format !== 1 ||
      receipt.tenant !== this.tenant ||
      receipt.name !== name ||
      password !== "x" ||
      !/^[1-9][0-9]*$/.test(gid) ||
      receipt.gid !== Number(gid) ||
      members === undefined ||
      (members &&
        members
          .split(",")
          .some((member) => !/^jw-[a-z0-9]{4,24}$/.test(member)))
    )
      fail("unmanaged_web_group");
    return receipt;
  }
  async prepare() {
    await this.preflight();
    const material = await this.material(),
      assets = await this.assets(),
      p = this.profile;
    const sshd = assets["deploy/hosting/sshd_config"]
      .replace(/^Port 2222$/m, "Port " + p.sftpPort)
      .replace(/^HostKey .+$/m, "HostKey /etc/jweb/ssh_host_ed25519_key");
    const ftp = assets["deploy/hosting/vsftpd.conf"]
      .replace(/^listen_port=21$/m, "listen_port=" + p.ftpsPort)
      .replace(/^pasv_min_port=56110$/m, "pasv_min_port=" + p.passiveMin)
      .replace(/^pasv_max_port=56119$/m, "pasv_max_port=" + p.passiveMax);
    const files = {
      "/usr/local/sbin/jweb-helper": [assets["deploy/jweb-helper.mjs"], 0o555],
      "/etc/sudoers.d/jweb": [assets["deploy/hosting/jweb.sudoers"], 0o440],
      "/etc/jweb/helper.json": [
        JSON.stringify({ tenant: this.tenant, domainSuffix: ".jgw.test" }),
        0o600,
      ],
      "/etc/jweb/sshd_config": [sshd, 0o600],
      "/etc/jweb/vsftpd.conf": [ftp, 0o600],
      "/etc/jweb/tls/ca.crt": [material.ca, 0o644],
      "/etc/jweb/tls/ca.key": [material.caKey, 0o600],
      "/etc/jweb/tls/ftps.crt": [material.certificate, 0o644],
      "/etc/jweb/tls/ftps.key": [material.key, 0o600],
      "/etc/jweb/ssh_host_ed25519_key": [material.ssh, 0o600],
      "/etc/pam.d/jweb-ftps": [
        "auth required pam_unix.so\naccount required pam_unix.so\n",
        0o644,
      ],
      "/etc/jweb/firewall.nft": [renderWebFirewall(p), 0o600],
    };
    await installationDirectory(this.stateRoot, 0o700);
    const receipt =
      JSON.stringify({
        format: 1,
        tenant: this.tenant,
        files: Object.fromEntries(
          Object.entries(files).map(([file, [text, mode]]) => [
            file,
            { sha256: installationDigest(text), mode },
          ]),
        ),
        units: renderWebUnits(),
      }) + "\n";
    // Immutable intent precedes mutation so changed input cannot adopt a partial install.
    await installationFile(this.receipt, receipt);
    for (const directory of [
      "/usr/local/sbin",
      "/etc/sudoers.d",
      "/etc/jweb",
      "/etc/jweb/tls",
      "/etc/jweb/tls/sites",
      "/etc/pam.d",
      "/var/lib/jweb",
      "/var/lib/jweb-ftps",
      "/var/lib/jweb-ftps/empty",
      "/etc/nginx/jweb.d",
      "/run/sshd",
    ])
      await installationDirectory(directory);
    for (const [file, [text, mode]] of Object.entries(files))
      await installationFile(file, text, mode);
    try {
      await readControlFile("/etc/jweb/ftps-users");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await installationFile("/etc/jweb/ftps-users", "");
    }
    await protectedStoragePath("/usr/sbin/groupadd", false);
    if (!(await this.group())) {
      await execute("/usr/sbin/groupadd", ["--system", "jweb-sftp"], { env });
      const row = (
        await execute("/usr/bin/getent", ["group", "jweb-sftp"], { env })
      )
        .trim()
        .split(":");
      if (
        row.length !== 4 ||
        row[0] !== "jweb-sftp" ||
        row[1] !== "x" ||
        !/^[1-9][0-9]*$/.test(row[2]) ||
        row[3]
      )
        fail("unmanaged_web_group");
      await installationFile(
        this.stateRoot + "/web-group.json",
        JSON.stringify({
          format: 1,
          tenant: this.tenant,
          name: row[0],
          gid: Number(row[2]),
        }) + "\n",
      );
    }
    await installationDirectory(this.unitRoot);
    for (const [name, text] of Object.entries(renderWebUnits()))
      await installationFile(path.join(this.unitRoot, name), text, 0o644);
    await execute("/usr/sbin/visudo", ["-cf", "/etc/sudoers.d/jweb"], { env });
    await execute("/usr/sbin/sshd", ["-t", "-f", "/etc/jweb/sshd_config"], {
      env,
    });
    return {
      tenant: this.tenant,
      phase: "web_hosting_prepared",
      activation: "pending",
    };
  }
  async validatePrepared() {
    if (process.getuid() !== 0) fail("root_required");
    await this.group();
    const record = await readControlJson(this.receipt, 32768);
    const allowed = [
      "/usr/local/sbin/jweb-helper",
      "/etc/sudoers.d/jweb",
      "/etc/jweb/helper.json",
      "/etc/jweb/sshd_config",
      "/etc/jweb/vsftpd.conf",
      "/etc/jweb/tls/ca.crt",
      "/etc/jweb/tls/ca.key",
      "/etc/jweb/tls/ftps.crt",
      "/etc/jweb/tls/ftps.key",
      "/etc/jweb/ssh_host_ed25519_key",
      "/etc/pam.d/jweb-ftps",
      "/etc/jweb/firewall.nft",
    ];
    if (
      Object.keys(record).sort().join() !==
        ["format", "tenant", "files", "units"].sort().join() ||
      record.format !== 1 ||
      record.tenant !== this.tenant ||
      !record.files ||
      Object.keys(record.files).sort().join() !== allowed.sort().join() ||
      JSON.stringify(record.units) !== JSON.stringify(renderWebUnits())
    )
      fail("web_installation_conflict");
    for (const [file, value] of Object.entries(record.files)) {
      if (
        !value ||
        Object.keys(value).sort().join() !== "mode,sha256" ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        ![0o555, 0o440, 0o644, 0o600].includes(value.mode)
      )
        fail("web_installation_conflict");
      await protectedStoragePath(file, false);
      const info = await lstat(file);
      if (
        (info.mode & 0o777) !== value.mode ||
        installationDigest(await readFile(file)) !== value.sha256
      )
        fail("web_installation_conflict");
    }
    for (const [name, text] of Object.entries(renderWebUnits()))
      if (
        (await readControlFile(path.join(this.unitRoot, name), {
          privateFile: false,
        })) !== text
      )
        fail("web_installation_conflict");
  }
  async observe(name) {
    if (process.getuid() !== 0) fail("root_required");
    await protectedStoragePath("/usr/bin/systemctl", false);
    return parseUnitObservation(
      await execute(
        "/usr/bin/systemctl",
        [
          "show",
          name,
          "--all",
          "--no-pager",
          "--property=LoadState,FragmentPath,ActiveState",
        ],
        { env },
      ),
    );
  }
  async firewallPresent() {
    const names = JSON.parse(
      await execute("/usr/sbin/nft", ["--json", "list", "tables"], { env }),
    );
    if (!Array.isArray(names.nftables)) fail("invalid_firewall_observation");
    return names.nftables.some(
      (row) => row.table?.family === "inet" && row.table?.name === "jgw_web",
    );
  }
  async firewallObservation() {
    const value = JSON.parse(
      await execute(
        "/usr/sbin/nft",
        ["--json", "list", "table", "inet", "jgw_web"],
        { env },
      ),
    );
    if (!Array.isArray(value.nftables)) fail("invalid_firewall_observation");
    const canonical = (object) =>
      Array.isArray(object)
        ? object.map(canonical)
        : object && typeof object === "object"
          ? Object.fromEntries(
              Object.entries(object)
                .filter(([key]) => key !== "handle")
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, canonical(item)]),
            )
          : object;
    return (
      JSON.stringify(canonical(value.nftables.filter((row) => !row.metainfo))) +
      "\n"
    );
  }
  async start() {
    if (this.unitRoot !== "/etc/systemd/system")
      fail("invalid_activation_target");
    await this.validatePrepared();
    await execute("/usr/bin/systemctl", ["daemon-reload"], { env });
    for (const name of Object.keys(renderWebUnits())) {
      const value = await this.observe(name);
      if (
        value.LoadState !== "loaded" ||
        value.FragmentPath !== path.join(this.unitRoot, name)
      )
        fail("unit_conflict");
    }
    // An absent named table is added; an existing unobserved table is refused.
    if (await this.firewallPresent()) {
      const expected = await readControlFile(
        this.stateRoot + "/web-firewall.json",
      );
      const actual = await this.firewallObservation();
      if (expected !== actual) fail("web_firewall_conflict");
    } else {
      await execute(
        "/usr/sbin/nft",
        ["--check", "--file", "/etc/jweb/firewall.nft"],
        { env },
      );
      await execute("/usr/sbin/nft", ["--file", "/etc/jweb/firewall.nft"], {
        env,
      });
      await installationFile(
        this.stateRoot + "/web-firewall.json",
        await this.firewallObservation(),
      );
    }
    await execute("/usr/bin/systemctl", ["daemon-reload"], { env });
    for (const name of Object.keys(renderWebUnits()))
      await execute("/usr/bin/systemctl", ["enable", "--now", name], { env });
  }
  async stop() {
    try {
      await this.validatePrepared();
    } catch (error) {
      if (error.code !== "ENOENT" || !(await this.stopped())) throw error;
      return;
    }
    for (const name of Object.keys(renderWebUnits())) {
      const value = await this.observe(name);
      if (
        value.LoadState !== "loaded" ||
        value.FragmentPath !== path.join(this.unitRoot, name)
      )
        fail("unit_conflict");
      await execute("/usr/bin/systemctl", ["disable", "--now", name], { env });
    }
    if (!(await this.stopped())) fail("web_writer_active");
    // Remove only the exact recorded table; other firewall tables remain intact.
    try {
      const expected = await readControlFile(
        this.stateRoot + "/web-firewall.json",
      );
      if (!(await this.firewallPresent())) return;
      const actual = await this.firewallObservation();
      if (actual !== expected) fail("web_firewall_conflict");
      await execute("/usr/sbin/nft", ["delete", "table", "inet", "jgw_web"], {
        env,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  async stopped() {
    for (const name of Object.keys(renderWebUnits())) {
      const value = await this.observe(name);
      if (
        value.LoadState === "not-found" &&
        value.FragmentPath === "" &&
        value.ActiveState === "inactive"
      ) {
        try {
          await lstat(path.join(this.unitRoot, name));
          fail("unit_conflict");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        continue;
      }
      if (
        value.LoadState !== "loaded" ||
        value.FragmentPath !== path.join(this.unitRoot, name)
      )
        fail("unit_conflict");
      if (!["inactive", "failed"].includes(value.ActiveState)) return false;
    }
    return true;
  }
  async ready() {
    await this.validatePrepared();
    for (const name of Object.keys(renderWebUnits())) {
      const value = await this.observe(name);
      if (
        value.LoadState !== "loaded" ||
        value.FragmentPath !== path.join(this.unitRoot, name) ||
        value.ActiveState !== "active"
      )
        fail("web_hosting_not_ready");
    }
    if (
      !(await this.firewallPresent()) ||
      (await this.firewallObservation()) !==
        (await readControlFile(this.stateRoot + "/web-firewall.json"))
    )
      fail("web_firewall_conflict");
    return true;
  }
}
