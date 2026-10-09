import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import {
  collectAcceptanceReport,
  MAX_RESPONSE_BYTES,
  missingProfileReport,
  redactEvidence,
  validateProfile,
} from "../collector.mjs";
import {
  ALL_ACCEPTANCE_TEST_IDS,
  FEATURE_MATRIX,
  OPERATIONS_GATES,
} from "../feature-matrix.mjs";

let fixtureDirectory;
let certificate;
let privateKey;
let server;
let fixturePort;
let responseBody = JSON.stringify({
  status: "ok",
  token: "BODY_TOKEN_SECRET",
  password: "BODY_PASSWORD_SECRET",
});
let responseDelayMs = 0;
let fixtureRequests = 0;

before(async () => {
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "jgw-ca-fixture-"));
  const keyPath = path.join(fixtureDirectory, "fixture-key.pem");
  const certPath = path.join(fixtureDirectory, "fixture-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10_000 },
  );
  certificate = await readFile(certPath);
  privateKey = await readFile(keyPath);
  server = https.createServer(
    { key: privateKey, cert: certificate },
    (_request, response) => {
      fixtureRequests += 1;
      const send = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(responseBody);
      };
      if (responseDelayMs) setTimeout(send, responseDelayMs);
      else send();
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fixturePort = server.address().port;
});

after(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  if (fixtureDirectory)
    await rm(fixtureDirectory, { recursive: true, force: true });
});

function profile({
  port = fixturePort,
  serviceId = "j-messenger",
  featureId = "MS-09",
  role = "service-health",
  url,
} = {}) {
  return {
    version: 1,
    profileId: "local-fixture-profile",
    serviceId,
    featureId,
    execution: { kind: "fixture", id: "owned-local-https-fixture" },
    approvedHostnames: ["127.0.0.1"],
    targets: [
      {
        role,
        url: url ?? `https://127.0.0.1:${port}/health/ready`,
      },
    ],
    configurationEvidence: [],
    resourceEvidence: [],
  };
}

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  socket.close();
  await once(socket, "close");
  return port;
}

describe("customer acceptance collector", () => {
  it("keeps all eight service acceptance IDs visible and never marks acceptance complete", () => {
    assert.deepEqual(
      FEATURE_MATRIX.map((service) => service.acceptanceTestId),
      ALL_ACCEPTANCE_TEST_IDS,
    );
    const report = missingProfileReport();
    assert.equal(report.acceptance_complete, false);
    assert.deepEqual(report.not_run_list, [
      ...ALL_ACCEPTANCE_TEST_IDS,
      ...OPERATIONS_GATES.map((gate) => gate.id),
    ]);
    assert.equal(report.source_provenance.profileSource, "no-profile");
    assert.equal(report.serviceResults.length, 8);
    assert.ok(
      report.serviceResults.every((service) => service.status === "not_run"),
    );
    assert.ok(
      report.operationalGates.every((gate) => gate.status === "not_run"),
    );
    assert.ok(
      report.operationalGates.every((gate) =>
        gate.evidenceItems.every((evidence) => evidence.status === "not_run"),
      ),
    );
  });

  it("requires an explicit profile and makes no default-target request", () => {
    const cli = new URL("../collect.mjs", import.meta.url);
    const result = spawnSync(process.execPath, [cli.pathname], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.collectorStatus, "blocked");
    assert.equal(report.blockCode, "profile_required");
    assert.equal(report.acceptance_complete, false);
    assert.deepEqual(report.not_run_list, [
      ...ALL_ACCEPTANCE_TEST_IDS,
      ...OPERATIONS_GATES.map((gate) => gate.id),
    ]);
    assert.equal(report.source_provenance.profileSource, "no-profile");
    assert.doesNotMatch(result.stdout, /https?:\/\/|127\.0\.0\.1/);
  });

  it("validates all eight service profiles against their own feature IDs and safe target roles", () => {
    const paths = {
      "oidc-discovery": "/realms/tenant-a/.well-known/openid-configuration",
      jwks: "/realms/tenant-a/protocol/openid-connect/certs",
      "customer-auth-exception": "/ext/customer-auth/",
      "talk-exception": "/ext/talk/",
      "site-root": "/",
    };
    for (const service of FEATURE_MATRIX) {
      const hosts =
        service.serviceId === "j-groupware"
          ? ["control.example.invalid", "customer.example.invalid"]
          : ["acceptance.example.invalid"];
      const targets = service.targetRoles.map((role, index) => ({
        role,
        url: `https://${hosts[service.serviceId === "j-groupware" ? index : 0]}${paths[role] ?? "/health/ready"}`,
      }));
      const item = {
        version: 1,
        profileId: `profile-${service.featureId.toLowerCase()}`,
        serviceId: service.serviceId,
        featureId: service.featureId,
        execution: {
          kind:
            service.serviceId === "j-groupware" ? "paired-vms" : "customer-vm",
          id: `vm-${service.featureId.toLowerCase()}`,
        },
        approvedHostnames: hosts,
        targets,
      };
      assert.equal(validateProfile(item).ok, true, service.featureId);
    }
  });

  it("performs a bounded read-only HTTPS check with trusted fixture TLS and redacts response contents", async () => {
    responseDelayMs = 0;
    responseBody = JSON.stringify({
      status: "ok",
      token: "BODY_TOKEN_SECRET",
      password: "BODY_PASSWORD_SECRET",
    });
    const report = await collectAcceptanceReport(profile(), {
      fixtureCa: certificate,
    });
    const messenger = report.serviceResults.find(
      (service) => service.serviceId === "j-messenger",
    );
    assert.equal(messenger.status, "preflight_ready");
    assert.deepEqual(messenger.healthChecks[0], {
      role: "service-health",
      status: "http_2xx",
      tlsStatus: "trusted",
      checkedAt: messenger.healthChecks[0].checkedAt,
      checkedTargetHostname: "127.0.0.1",
    });
    assert.equal(report.acceptance_complete, false);
    assert.ok(report.not_run_list.includes("MS-T04"));
    assert.equal(report.source_provenance.executionKind, "fixture");
    assert.doesNotMatch(
      JSON.stringify(report),
      /BODY_TOKEN_SECRET|BODY_PASSWORD_SECRET/,
    );
    assert.doesNotMatch(
      JSON.stringify(report),
      /fixture-key\.pem|health\/ready/,
    );
  });

  it("rejects a self-signed service certificate without a test-only trusted CA", async () => {
    const report = await collectAcceptanceReport(profile());
    const health = report.serviceResults.find(
      (service) => service.serviceId === "j-messenger",
    ).healthChecks[0];
    assert.equal(health.status, "tls_rejected");
    assert.equal(health.tlsStatus, "untrusted");
    assert.equal(report.acceptance_complete, false);
  });

  it("classifies a closed local target as unreachable and records only its hostname", async () => {
    const port = await freePort();
    const report = await collectAcceptanceReport(profile({ port }), {
      timeoutMs: 300,
    });
    const health = report.serviceResults.find(
      (service) => service.serviceId === "j-messenger",
    ).healthChecks[0];
    assert.equal(health.status, "unreachable");
    assert.equal(health.checkedTargetHostname, "127.0.0.1");
    assert.equal("url" in health, false);
    assert.equal(report.acceptance_complete, false);
  });

  it("blocks a wrong feature/profile before opening a network connection", async () => {
    const wrongPath = profile({
      url: `https://127.0.0.1:${fixturePort}/admin`,
    });
    assert.equal(validateProfile(wrongPath).ok, false);
    const wrongFeature = profile({ featureId: "AU-51" });
    assert.equal(validateProfile(wrongFeature).code, "feature_mismatch");
    const before = fixtureRequests;
    const report = await collectAcceptanceReport(wrongPath);
    assert.equal(fixtureRequests, before);
    assert.equal(report.collectorStatus, "blocked");
    assert.equal(report.blockCode, "target_rejected");
    assert.equal(
      report.serviceResults.every((service) =>
        service.healthChecks.every((check) => check.status === "not_run"),
      ),
      true,
    );
  });

  it("rejects operational evidence IDs outside the O01–O05 read-only matrix", () => {
    const invalid = profile();
    invalid.operationsEvidence = [
      {
        gateId: "O01",
        evidenceId: "admin-api-password",
        status: "observed",
        source: "operator-attestation",
        observedAt: new Date().toISOString(),
      },
    ];
    assert.equal(validateProfile(invalid).code, "operations_evidence_invalid");
  });

  it("rejects credentials, queries, traversal, the forbidden port, and loopback VM profiles", () => {
    const badUrls = [
      `https://user:secret@127.0.0.1:${fixturePort}/health/ready`,
      `https://127.0.0.1:${fixturePort}/health/ready?token=secret`,
      `https://127.0.0.1:${fixturePort}/health/../admin`,
      "https://127.0.0.1:3001/health/ready",
    ];
    for (const url of badUrls)
      assert.equal(validateProfile(profile({ url })).ok, false, url);
    const nonFixture = profile({});
    nonFixture.execution.kind = "customer-vm";
    assert.equal(validateProfile(nonFixture).ok, false);
    const unapproved = profile();
    unapproved.execution.kind = "customer-vm";
    unapproved.approvedHostnames = ["other.example.invalid"];
    assert.equal(validateProfile(unapproved).code, "target_rejected");
  });

  it("rejects an oversized body and enforces an absolute timeout", async () => {
    responseDelayMs = 0;
    responseBody = "x".repeat(MAX_RESPONSE_BYTES + 1);
    const oversized = await collectAcceptanceReport(profile(), {
      fixtureCa: certificate,
    });
    assert.equal(
      oversized.serviceResults.find(
        (service) => service.serviceId === "j-messenger",
      ).healthChecks[0].status,
      "response_too_large",
    );

    responseBody = "{}";
    responseDelayMs = 300;
    const timed = await collectAcceptanceReport(profile(), {
      fixtureCa: certificate,
      timeoutMs: 100,
    });
    assert.equal(
      timed.serviceResults.find(
        (service) => service.serviceId === "j-messenger",
      ).healthChecks[0].status,
      "timeout",
    );
    responseDelayMs = 0;
  });

  it("redacts configuration and resource values while keeping provenance and measurement names", async () => {
    const reportProfile = profile({ serviceId: "j-auth", featureId: "AU-51" });
    reportProfile.execution.kind = "customer-vm";
    reportProfile.execution.id = "auth-vm-01";
    reportProfile.approvedHostnames = ["auth.example.invalid"];
    reportProfile.targets = [
      {
        role: "oidc-discovery",
        url: "https://auth.example.invalid/realms/tenant-a/.well-known/openid-configuration",
      },
      {
        role: "jwks",
        url: "https://auth.example.invalid/realms/tenant-a/protocol/openid-connect/certs",
      },
    ];
    const observedAt = new Date().toISOString();
    reportProfile.configurationEvidence = [
      {
        id: "AU-T10.nginx-allowlist",
        status: "observed",
        source: "read-only-export",
        observedAt,
      },
    ];
    reportProfile.resourceEvidence = [
      {
        scope: "customer-vm",
        source: "read-only-monitoring-export",
        measuredAt: observedAt,
        metrics: {
          cpu_percent: 17.5,
          memory_rss_bytes: 22_000_000,
          disk_free_bytes: 5_000_000_000,
          sample_count: 4,
        },
      },
    ];
    const validation = validateProfile(reportProfile);
    assert.equal(validation.ok, true);
    const values = redactEvidence(
      FEATURE_MATRIX.find((service) => service.serviceId === "j-auth"),
      validation.configurationEvidence,
      validation.resourceEvidence,
    );
    assert.doesNotMatch(JSON.stringify(values), /17\.5|22000000/);
    assert.deepEqual(values.resourceEvidence, [
      {
        scope: "customer-vm",
        status: "measured",
        source: "read-only-monitoring-export",
        measuredAt: observedAt,
        metricNames: [
          "cpu_percent",
          "disk_free_bytes",
          "memory_rss_bytes",
          "sample_count",
        ],
      },
    ]);
    assert.equal(values.configurationEvidence[3].status, "observed");
    assert.equal(reportProfile.resourceEvidence[0].metrics.cpu_percent, 17.5);
    assert.equal(
      reportProfile.resourceEvidence[0].metrics.memory_rss_bytes,
      22_000_000,
    );
    assert.equal(reportProfile.resourceEvidence[0].metrics.sample_count, 4);
  });
});
