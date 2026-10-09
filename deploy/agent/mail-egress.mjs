import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute, externalPath } from "../gateway/gateway.mjs";
import { readControlFile } from "./control-files.mjs";
import { installationDirectory, installationFile } from "./install-files.mjs";
import { requireSystemdVm } from "./os-bootstrap.mjs";
import { protectedStoragePath } from "./product-storage.mjs";
import { parseUnitObservation } from "./unit-observation.mjs";
import { ProvisionError } from "./provision-error.mjs";

const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
const unit = "jgw-mail-egress.service";
const table = "jgw_mail_egress";
const fail = (code = "mail_egress_conflict") => {
  throw new ProvisionError(code);
};
const safePath = (value) => {
  externalPath(value);
  if (!/^[A-Za-z0-9_./-]+$/.test(value)) fail("invalid_mail_egress_path");
};

// The supported Mailpit profile uses host networking and loopback SMTP.
// inet/output covers both IP families without opening any other firewall chain.
// Official grammar: https://www.netfilter.org/projects/nftables/manpage.html
export function renderMailEgressFirewall() {
  return 'table inet jgw_mail_egress {\n  chain output {\n    type filter hook output priority filter; policy accept;\n    oifname != "lo" tcp dport { 25, 465, 587 } reject with tcp reset\n  }\n}\n';
}
export function renderMailEgressUnit(bundleRoot, stateRoot) {
  [bundleRoot, stateRoot].forEach(safePath);
  return `[Unit]\nDescription=Block external SMTP delivery for J Mail\nBefore=network-pre.target docker.service jgw-mail.service\nWants=network-pre.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/node ${bundleRoot}/j-groupware/deploy/agent/mail-egress.mjs --start --state-root ${stateRoot}\nTimeoutStartSec=30\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
}

// Compare persistent ownership receipts independent of kernel-assigned handles.
export function canonicalMailEgressObservation(value) {
  if (!value || !Array.isArray(value.nftables) || value.nftables.length > 32)
    fail();
  const entries = value.nftables.filter((row) => !row.metainfo);
  if (
    !entries.some(
      (row) => row.table?.family === "inet" && row.table?.name === table,
    )
  )
    fail();
  for (const row of entries) {
    const item = row.table ?? row.chain ?? row.rule;
    if (
      !item ||
      item.family !== "inet" ||
      (row.table ? item.name !== table : item.table !== table)
    )
      fail();
  }
  const canonical = (item) =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([key]) => key !== "handle")
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return JSON.stringify(canonical(entries)) + "\n";
}

/** Construction is inert. All native reads/writes/activation require root + systemd PID1. */
export class NativeMailEgress {
  constructor({ bundleRoot, stateRoot, unitRoot = "/etc/systemd/system" }) {
    [bundleRoot, stateRoot, unitRoot].forEach(safePath);
    Object.assign(this, { bundleRoot, stateRoot, unitRoot });
    this.rules = stateRoot + "/firewall.nft";
    this.receipt = stateRoot + "/firewall.json";
  }
  async preflight() {
    await requireSystemdVm();
    if (this.unitRoot !== "/etc/systemd/system")
      fail("invalid_activation_target");
    await protectedStoragePath("/usr/sbin/nft", false);
    await protectedStoragePath("/usr/bin/systemctl", false);
    await protectedStoragePath(this.unitRoot);
    await protectedStoragePath(
      this.bundleRoot + "/j-groupware/deploy/agent/mail-egress.mjs",
      false,
    );
  }
  async prepare() {
    await this.preflight();
    await installationDirectory(this.stateRoot, 0o700);
    await installationFile(this.rules, renderMailEgressFirewall());
    await installationFile(
      path.join(this.unitRoot, unit),
      renderMailEgressUnit(this.bundleRoot, this.stateRoot),
      0o644,
    );
    await execute("/usr/bin/systemctl", ["daemon-reload"], { env });
  }
  async prepared() {
    await this.preflight();
    await protectedStoragePath(this.stateRoot);
    if (
      (await readControlFile(this.rules)) !== renderMailEgressFirewall() ||
      (await readControlFile(path.join(this.unitRoot, unit), {
        privateFile: false,
      })) !== renderMailEgressUnit(this.bundleRoot, this.stateRoot)
    )
      fail();
  }
  async present() {
    await requireSystemdVm();
    const value = JSON.parse(
      await execute("/usr/sbin/nft", ["--json", "list", "tables"], { env }),
    );
    if (!Array.isArray(value.nftables)) fail();
    return value.nftables.some(
      (row) => row.table?.family === "inet" && row.table?.name === table,
    );
  }
  async observation() {
    await requireSystemdVm();
    return canonicalMailEgressObservation(
      JSON.parse(
        await execute(
          "/usr/sbin/nft",
          ["--json", "list", "table", "inet", table],
          { env },
        ),
      ),
    );
  }
  async applyPrepared() {
    await this.prepared();
    if (await this.present()) {
      // Never adopt or flush a pre-existing table without its exact root-owned receipt.
      if (
        (await readControlFile(this.receipt, { maximum: 32768 })) !==
        (await this.observation())
      )
        fail();
      return;
    }
    await execute("/usr/sbin/nft", ["--check", "--file", this.rules], { env });
    await execute("/usr/sbin/nft", ["--file", this.rules], { env });
    await installationFile(this.receipt, await this.observation());
  }
  async start() {
    await this.prepared();
    // Refuse a foreign table before enabling the fixed owned boot unit.
    if (
      (await this.present()) &&
      (await readControlFile(this.receipt)) !== (await this.observation())
    )
      fail();
    await execute("/usr/bin/systemctl", ["enable", "--now", unit], { env });
    await this.ready();
  }
  async ready() {
    await this.prepared();
    const value = parseUnitObservation(
      await execute(
        "/usr/bin/systemctl",
        [
          "show",
          unit,
          "--all",
          "--no-pager",
          "--property=LoadState,FragmentPath,ActiveState",
        ],
        { env },
      ),
    );
    if (
      value.LoadState !== "loaded" ||
      value.FragmentPath !== path.join(this.unitRoot, unit) ||
      value.ActiveState !== "active" ||
      !(await this.present()) ||
      (await readControlFile(this.receipt)) !== (await this.observation())
    )
      fail("mail_egress_not_ready");
  }
  // Customer-host SMTP denial persists after Mailpit stop/unsubscribe and on reboot.
  // Removing it is a separate operator decision; the suite never resets global rules.
}

async function main(argv) {
  if (argv.length !== 3 || argv[0] !== "--start" || argv[1] !== "--state-root")
    fail("invalid_mail_egress_arguments");
  const self = fileURLToPath(import.meta.url);
  const bundleRoot = path.resolve(path.dirname(self), "../../..");
  await new NativeMailEgress({
    bundleRoot,
    stateRoot: argv[2],
  }).applyPrepared();
  process.stdout.write('{"phase":"mail_egress_ready"}\n');
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      (error instanceof ProvisionError ? error.code : "mail_egress_failed") +
        "\n",
    );
    process.exitCode = 1;
  });
