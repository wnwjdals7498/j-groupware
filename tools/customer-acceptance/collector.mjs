import { readFile, stat } from "node:fs/promises";
import https from "node:https";
import { isIP } from "node:net";
import {
  ALL_ACCEPTANCE_TEST_IDS,
  FEATURE_MATRIX,
  OPERATIONS_GATES,
  RESOURCE_METRIC_NAMES,
  TARGET_PATHS,
} from "./feature-matrix.mjs";

export const PROBE_TIMEOUT_MS = 2500;
export const MAX_RESPONSE_BYTES = 16 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const EXECUTION_KINDS = new Set([
  "customer-vm",
  "control-vm",
  "paired-vms",
  "fixture",
]);
const CONFIG_SOURCES = new Set(["operator-attestation", "read-only-export"]);
const RESOURCE_SOURCES = new Set([
  "operator-attestation",
  "read-only-monitoring-export",
]);

function now() {
  return new Date().toISOString();
}

function timestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validHostname(hostname) {
  if (
    typeof hostname !== "string" ||
    hostname.length > 253 ||
    hostname !== hostname.toLowerCase()
  )
    return false;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".")
  )
    return false;
  if (isIP(hostname) === 4) {
    const octets = hostname.split(".").map(Number);
    return (
      octets[0] !== 0 &&
      octets[0] !== 127 &&
      octets[0] !== 169 &&
      octets[0] < 224
    );
  }
  if (isIP(hostname) === 6)
    return (
      hostname !== "::" &&
      hostname !== "::1" &&
      !hostname.toLowerCase().startsWith("fe80:")
    );
  return hostname
    .split(".")
    .every(
      (part) =>
        part.length >= 1 &&
        part.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
    );
}

function fixtureHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1";
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return (
    plainObject(value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function validateTarget(target, executionKind, allowedHostnames, service) {
  if (!hasOnlyKeys(target, new Set(["role", "url"]))) return null;
  if (
    typeof target.role !== "string" ||
    !service.targetRoles.includes(target.role)
  )
    return null;
  if (
    typeof target.url !== "string" ||
    target.url.length > 2048 ||
    /[\s\\%?#]/.test(target.url)
  )
    return null;
  let parsed;
  try {
    parsed = new URL(target.url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    return null;
  if (parsed.port === "3001" || (parsed.port && Number(parsed.port) < 1))
    return null;
  if (
    !TARGET_PATHS[target.role].test(parsed.pathname) ||
    parsed.pathname.includes("..")
  )
    return null;
  if (!allowedHostnames.includes(parsed.hostname)) return null;
  if (executionKind === "fixture") {
    if (
      !fixtureHostname(parsed.hostname) ||
      !parsed.port ||
      Number(parsed.port) < 1024 ||
      Number(parsed.port) === 3001
    )
      return null;
  } else {
    if (
      !validHostname(parsed.hostname) ||
      (parsed.port && parsed.port !== "443")
    )
      return null;
  }
  return { role: target.role, url: parsed };
}

export function validateProfile(profile) {
  if (
    !hasOnlyKeys(
      profile,
      new Set([
        "version",
        "profileId",
        "serviceId",
        "featureId",
        "execution",
        "approvedHostnames",
        "targets",
        "configurationEvidence",
        "resourceEvidence",
        "operationsEvidence",
      ]),
    )
  )
    return { ok: false, code: "profile_invalid" };
  if (
    profile.version !== 1 ||
    typeof profile.profileId !== "string" ||
    !ID_PATTERN.test(profile.profileId)
  )
    return { ok: false, code: "profile_invalid" };
  const service = FEATURE_MATRIX.find(
    (item) => item.serviceId === profile.serviceId,
  );
  if (!service || profile.featureId !== service.featureId)
    return { ok: false, code: "feature_mismatch" };
  if (
    !hasOnlyKeys(profile.execution, new Set(["kind", "id"])) ||
    !EXECUTION_KINDS.has(profile.execution.kind) ||
    typeof profile.execution.id !== "string" ||
    !ID_PATTERN.test(profile.execution.id)
  )
    return { ok: false, code: "execution_invalid" };
  if (
    !Array.isArray(profile.approvedHostnames) ||
    profile.approvedHostnames.length < 1 ||
    profile.approvedHostnames.length > 12
  )
    return { ok: false, code: "target_not_approved" };
  const approved = profile.approvedHostnames;
  if (
    new Set(approved).size !== approved.length ||
    approved.some((host) => typeof host !== "string")
  )
    return { ok: false, code: "target_not_approved" };
  if (profile.execution.kind === "fixture") {
    if (approved.some((host) => !fixtureHostname(host)))
      return { ok: false, code: "target_not_approved" };
  } else if (approved.some((host) => !validHostname(host))) {
    return { ok: false, code: "target_not_approved" };
  }
  if (
    !Array.isArray(profile.targets) ||
    profile.targets.length !== service.targetRoles.length
  )
    return { ok: false, code: "targets_incomplete" };
  const targets = profile.targets.map((target) =>
    validateTarget(target, profile.execution.kind, approved, service),
  );
  if (targets.some((target) => target === null))
    return { ok: false, code: "target_rejected" };
  const roles = targets.map((target) => target.role);
  if (
    new Set(roles).size !== roles.length ||
    service.targetRoles.some((role) => !roles.includes(role))
  )
    return { ok: false, code: "targets_incomplete" };
  if (service.serviceId === "j-groupware") {
    const control = targets.find((target) => target.role === "control-health");
    const customer = targets.find(
      (target) => target.role === "customer-health",
    );
    if (control.url.hostname === customer.url.hostname)
      return { ok: false, code: "paired_targets_must_differ" };
    if (profile.execution.kind !== "paired-vms")
      return { ok: false, code: "execution_invalid" };
  }
  if (
    service.serviceId === "j-auth" &&
    targets[0].url.hostname !== targets[1].url.hostname
  )
    return { ok: false, code: "identity_targets_must_match" };
  if (profile.execution.kind === "fixture" && service.targetRoles.length !== 1)
    return { ok: false, code: "fixture_profile_invalid" };

  const configurationEvidence =
    profile.configurationEvidence === undefined
      ? []
      : profile.configurationEvidence;
  if (
    !Array.isArray(configurationEvidence) ||
    configurationEvidence.length > service.configEvidenceIds.length
  )
    return { ok: false, code: "config_evidence_invalid" };
  const seenConfig = new Set();
  for (const entry of configurationEvidence) {
    if (!hasOnlyKeys(entry, new Set(["id", "status", "source", "observedAt"])))
      return { ok: false, code: "config_evidence_invalid" };
    if (
      !service.configEvidenceIds.includes(entry.id) ||
      seenConfig.has(entry.id) ||
      !["observed", "absent", "not_run"].includes(entry.status) ||
      !CONFIG_SOURCES.has(entry.source) ||
      !timestamp(entry.observedAt)
    )
      return { ok: false, code: "config_evidence_invalid" };
    seenConfig.add(entry.id);
  }

  const resourceEvidence =
    profile.resourceEvidence === undefined ? [] : profile.resourceEvidence;
  if (
    !Array.isArray(resourceEvidence) ||
    resourceEvidence.length > service.resourceScopes.length
  )
    return { ok: false, code: "resource_evidence_invalid" };
  const seenResource = new Set();
  for (const entry of resourceEvidence) {
    if (
      !hasOnlyKeys(entry, new Set(["scope", "source", "measuredAt", "metrics"]))
    )
      return { ok: false, code: "resource_evidence_invalid" };
    if (
      !service.resourceScopes.includes(entry.scope) ||
      seenResource.has(entry.scope) ||
      !RESOURCE_SOURCES.has(entry.source) ||
      !timestamp(entry.measuredAt) ||
      !plainObject(entry.metrics)
    )
      return { ok: false, code: "resource_evidence_invalid" };
    const metricNames = Object.keys(entry.metrics);
    if (
      service.resourceMetrics.some((name) => !metricNames.includes(name)) ||
      metricNames.some(
        (name) =>
          !RESOURCE_METRIC_NAMES.includes(name) ||
          typeof entry.metrics[name] !== "number" ||
          !Number.isFinite(entry.metrics[name]) ||
          entry.metrics[name] < 0 ||
          (name === "cpu_percent" && entry.metrics[name] > 100),
      )
    )
      return { ok: false, code: "resource_evidence_invalid" };
    seenResource.add(entry.scope);
  }
  const operationsEvidence =
    profile.operationsEvidence === undefined ? [] : profile.operationsEvidence;
  const operationEvidenceLimit = OPERATIONS_GATES.reduce(
    (total, gate) => total + gate.evidenceIds.length,
    0,
  );
  if (
    !Array.isArray(operationsEvidence) ||
    operationsEvidence.length > operationEvidenceLimit
  )
    return { ok: false, code: "operations_evidence_invalid" };
  const seenOperations = new Set();
  for (const entry of operationsEvidence) {
    if (
      !hasOnlyKeys(
        entry,
        new Set(["gateId", "evidenceId", "status", "source", "observedAt"]),
      )
    )
      return { ok: false, code: "operations_evidence_invalid" };
    const gate = OPERATIONS_GATES.find(
      (candidate) => candidate.id === entry.gateId,
    );
    const evidenceKey = `${entry.gateId}:${entry.evidenceId}`;
    if (
      !gate ||
      !gate.evidenceIds.includes(entry.evidenceId) ||
      seenOperations.has(evidenceKey) ||
      !["observed", "absent", "not_run"].includes(entry.status) ||
      !CONFIG_SOURCES.has(entry.source) ||
      !timestamp(entry.observedAt)
    )
      return { ok: false, code: "operations_evidence_invalid" };
    seenOperations.add(evidenceKey);
  }
  return {
    ok: true,
    service,
    targets,
    configurationEvidence,
    resourceEvidence,
    operationsEvidence,
  };
}

function blankServiceResult(service) {
  return {
    serviceId: service.serviceId,
    featureId: service.featureId,
    acceptanceTestId: service.acceptanceTestId,
    status: "not_run",
    healthChecks: service.targetRoles.map((role) => ({
      role,
      status: "not_run",
      tlsStatus: "not_run",
      checkedAt: null,
      checkedTargetHostname: null,
    })),
    configurationEvidence: service.configEvidenceIds.map((id) => ({
      id,
      status: "not_run",
      source: "not_provided",
      observedAt: null,
    })),
    resourceEvidence: service.resourceScopes.length
      ? service.resourceScopes.map((scope) => ({
          scope,
          status: "not_run",
          source: "not_provided",
          measuredAt: null,
          metricNames: [],
        }))
      : [
          {
            scope: "service-vm",
            status: "not_required_by_feature_spec",
            source: "feature-specification",
            measuredAt: null,
            metricNames: [],
          },
        ],
  };
}

function tlsFailure(error) {
  return (
    typeof error?.code === "string" &&
    /CERT|TLS|SSL|VERIFY|SELF_SIGNED|ISSUER/.test(error.code)
  );
}

export function probeHttps(
  target,
  { timeoutMs: requestedTimeoutMs = PROBE_TIMEOUT_MS, fixtureCa } = {},
) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isInteger(requestedTimeoutMs)
      ? Math.max(1, Math.min(PROBE_TIMEOUT_MS, requestedTimeoutMs))
      : PROBE_TIMEOUT_MS;
    const checkedAt = now();
    let settled = false;
    let tlsStatus = "not_verified";
    let responseBytes = 0;
    let totalTimer;
    const finish = (status, finalTls = tlsStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      resolve({
        role: target.role,
        status,
        tlsStatus: finalTls,
        checkedAt,
        checkedTargetHostname: target.url.hostname,
      });
    };
    const options = {
      protocol: "https:",
      hostname: target.url.hostname,
      port: target.url.port || 443,
      path: target.url.pathname,
      method: "GET",
      headers: { accept: "application/json, text/plain;q=0.8" },
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      maxHeaderSize: 8192,
      timeout: timeoutMs,
    };
    if (!isIP(target.url.hostname)) options.servername = target.url.hostname;
    if (fixtureCa) options.ca = fixtureCa;
    const request = https.request(options, (response) => {
      tlsStatus = response.socket.authorized ? "trusted" : "untrusted";
      const declaredSize = Number(response.headers["content-length"] ?? 0);
      if (declaredSize > MAX_RESPONSE_BYTES) {
        finish("response_too_large", tlsStatus);
        response.destroy();
        return;
      }
      response.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          finish("response_too_large", tlsStatus);
          response.destroy();
        }
      });
      response.on("end", () => {
        const code = response.statusCode ?? 0;
        if (code >= 300 && code < 400) finish("redirect_rejected", tlsStatus);
        else if (code >= 200 && code < 300) finish("http_2xx", tlsStatus);
        else finish("http_unhealthy", tlsStatus);
      });
      response.on("aborted", () => finish("response_error", tlsStatus));
      response.on("error", () => finish("response_error", tlsStatus));
    });
    request.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        tlsStatus = socket.authorized ? "trusted" : "untrusted";
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      );
    });
    totalTimer = setTimeout(() => {
      request.destroy(
        Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      );
    }, timeoutMs);
    totalTimer.unref?.();
    request.on("error", (error) => {
      if (tlsFailure(error)) finish("tls_rejected", "untrusted");
      else if (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT")
        finish("timeout");
      else if (error.code === "ECONNREFUSED") finish("unreachable");
      else finish("network_error");
    });
    request.end();
  });
}

function reportBase({
  profile = null,
  validationCode = null,
  source = "explicit-profile",
} = {}) {
  return {
    schemaVersion: 1,
    generatedAt: now(),
    collectorStatus: validationCode ? "blocked" : "ready",
    acceptance_complete: false,
    source_provenance: {
      profileSource: source,
      profileProvided: Boolean(profile),
      executionKind: profile?.execution?.kind ?? null,
      evidenceSources: profile
        ? ["profile-provided-evidence", "direct-https-read-only-probe"]
        : ["no-profile-provided"],
    },
    serviceResults: FEATURE_MATRIX.map(blankServiceResult),
    operationalGates: OPERATIONS_GATES.map((gate) => ({
      gateId: gate.id,
      status: "not_run",
      evidenceItems: gate.evidenceIds.map((id) => ({
        id,
        status: "not_run",
        source: "not_provided",
        observedAt: null,
      })),
    })),
    not_run_list: [
      ...ALL_ACCEPTANCE_TEST_IDS,
      ...OPERATIONS_GATES.map((gate) => gate.id),
    ],
    ...(validationCode ? { blockCode: validationCode } : {}),
  };
}

export function redactEvidence(
  service,
  configurationEvidence,
  resourceEvidence,
) {
  const configById = new Map(
    configurationEvidence.map((entry) => [entry.id, entry]),
  );
  const safeConfigurationEvidence = service.configEvidenceIds.map((id) => {
    const entry = configById.get(id);
    return entry
      ? {
          id,
          status: entry.status,
          source: entry.source,
          observedAt: entry.observedAt,
        }
      : { id, status: "not_run", source: "not_provided", observedAt: null };
  });
  const resourceByScope = new Map(
    resourceEvidence.map((entry) => [entry.scope, entry]),
  );
  const safeResourceEvidence = service.resourceScopes.length
    ? service.resourceScopes.map((scope) => {
        const entry = resourceByScope.get(scope);
        return entry
          ? {
              scope,
              status: "measured",
              source: entry.source,
              measuredAt: entry.measuredAt,
              metricNames: Object.keys(entry.metrics).sort(),
            }
          : {
              scope,
              status: "not_run",
              source: "not_provided",
              measuredAt: null,
              metricNames: [],
            };
      })
    : [
        {
          scope: "service-vm",
          status: "not_required_by_feature_spec",
          source: "feature-specification",
          measuredAt: null,
          metricNames: [],
        },
      ];
  return {
    configurationEvidence: safeConfigurationEvidence,
    resourceEvidence: safeResourceEvidence,
  };
}

export async function collectAcceptanceReport(profile, options = {}) {
  const validation = validateProfile(profile);
  if (!validation.ok)
    return reportBase({ profile: null, validationCode: validation.code });
  if (options.fixtureCa && profile.execution.kind !== "fixture")
    return reportBase({ validationCode: "fixture_trust_override_forbidden" });
  const report = reportBase({ profile });
  const result = report.serviceResults.find(
    (item) => item.serviceId === validation.service.serviceId,
  );
  Object.assign(
    result,
    redactEvidence(
      validation.service,
      validation.configurationEvidence,
      validation.resourceEvidence,
    ),
  );
  const operationsById = new Map(
    validation.operationsEvidence.map((entry) => [
      `${entry.gateId}:${entry.evidenceId}`,
      entry,
    ]),
  );
  report.operationalGates = OPERATIONS_GATES.map((gate) => {
    return {
      gateId: gate.id,
      status: "not_run",
      evidenceItems: gate.evidenceIds.map((id) => {
        const entry = operationsById.get(`${gate.id}:${id}`);
        return {
          id,
          status: entry?.status ?? "not_run",
          source: entry?.source ?? "not_provided",
          observedAt: entry?.observedAt ?? null,
        };
      }),
    };
  });
  const probes = await Promise.all(
    validation.targets.map((target) =>
      probeHttps(target, {
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
        ...(options.fixtureCa ? { fixtureCa: options.fixtureCa } : {}),
      }),
    ),
  );
  result.healthChecks = validation.service.targetRoles.map((role) =>
    probes.find((probe) => probe.role === role),
  );
  result.status = probes.every(
    (probe) => probe.status === "http_2xx" && probe.tlsStatus === "trusted",
  )
    ? "preflight_ready"
    : "preflight_failed";
  report.collectorStatus = "completed";
  return report;
}

export async function loadProfile(profilePath) {
  if (!profilePath || typeof profilePath !== "string")
    return { ok: false, code: "profile_required" };
  try {
    const profileStat = await stat(profilePath);
    if (!profileStat.isFile()) return { ok: false, code: "profile_unreadable" };
    if (profileStat.size > 64 * 1024)
      return { ok: false, code: "profile_too_large" };
    const raw = await readFile(profilePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024)
      return { ok: false, code: "profile_too_large" };
    return { ok: true, profile: JSON.parse(raw) };
  } catch {
    return { ok: false, code: "profile_unreadable" };
  }
}

export function missingProfileReport(code = "profile_required") {
  return reportBase({ validationCode: code, source: "no-profile" });
}
