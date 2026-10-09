import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NativeMailEgress,
  renderMailEgressFirewall,
  renderMailEgressUnit,
  canonicalMailEgressObservation,
} from "../../deploy/agent/mail-egress.mjs";
import { renderServiceUnit } from "../../deploy/agent/native-platform.mjs";

test("mail policy covers IPv4/IPv6 host egress while preserving loopback capture and existing tables", () => {
  const rules = renderMailEgressFirewall();
  assert.match(rules, /table inet jgw_mail_egress/);
  assert.match(rules, /hook output/);
  assert.match(
    rules,
    /oifname != "lo" tcp dport \{ 25, 465, 587 \} reject with tcp reset/,
  );
  assert.doesNotMatch(
    rules,
    /flush|delete|hook input|policy drop|3001|counter/,
  );
});
test("mail boot dependency is explicit and leaves SMTP denial in place after service stop", () => {
  const unit = renderMailEgressUnit(
    "/opt/jgw/bundles",
    "/etc/jgw/services/mail-egress",
  );
  assert.match(
    unit,
    /Before=network-pre.target docker.service jgw-mail.service/,
  );
  assert.match(unit, /RemainAfterExit=yes/);
  assert.doesNotMatch(unit, /ExecStop=|nft (?:flush|delete)|password|Bearer/);
  const mail = renderServiceUnit(
    "j-mail",
    "/opt/jgw/bundles",
    "/etc/jgw/services",
  );
  assert.match(
    mail,
    /After=.*jgw-mail-egress.service\nRequires=jgw-mail-egress.service\n/,
  );
  assert.doesNotMatch(
    renderServiceUnit("j-talk", "/opt/jgw/bundles", "/etc/jgw/services"),
    /mail-egress/,
  );
});
test("ownership comparison tolerates kernel handles but detects rules and foreign namespaces", () => {
  const value = {
    nftables: [
      { metainfo: { version: "1" } },
      { table: { family: "inet", name: "jgw_mail_egress", handle: 1 } },
      {
        chain: {
          family: "inet",
          table: "jgw_mail_egress",
          name: "output",
          hook: "output",
          handle: 2,
        },
      },
      {
        rule: {
          family: "inet",
          table: "jgw_mail_egress",
          chain: "output",
          handle: 3,
          expr: [{ reject: { type: "tcp reset" } }],
        },
      },
    ],
  };
  const changed = structuredClone(value);
  changed.nftables[1].table.handle = 99;
  assert.equal(
    canonicalMailEgressObservation(value),
    canonicalMailEgressObservation(changed),
  );
  changed.nftables[3].rule.expr = [{ accept: null }];
  assert.notEqual(
    canonicalMailEgressObservation(value),
    canonicalMailEgressObservation(changed),
  );
  assert.throws(
    () =>
      canonicalMailEgressObservation({
        nftables: [{ table: { family: "inet", name: "foreign" } }],
      }),
    /mail_egress_conflict/,
  );
  assert.throws(
    () =>
      canonicalMailEgressObservation({
        ...value,
        nftables: [
          ...value.nftables,
          { rule: { family: "inet", table: "foreign" } },
        ],
      }),
    /mail_egress_conflict/,
  );
});
test("unsafe unit paths are rejected before construction or activation", () => {
  for (const stateRoot of [
    "/etc/jgw/../foreign",
    "/etc/jgw;command",
    "/etc/jgw with space",
    "/etc/jgw%unit",
  ])
    assert.throws(
      () => new NativeMailEgress({ bundleRoot: "/opt/jgw/bundles", stateRoot }),
    );
});
test("native mail operations remain blocked outside a root systemd VM", async () => {
  assert.notEqual(process.getuid(), 0);
  const mail = new NativeMailEgress({
    bundleRoot: "/opt/jgw/bundles",
    stateRoot: "/etc/jgw/services/mail-egress",
  });
  for (const method of [
    "preflight",
    "prepare",
    "prepared",
    "applyPrepared",
    "start",
    "ready",
  ])
    await assert.rejects(mail[method](), { code: "root_required" });
});
