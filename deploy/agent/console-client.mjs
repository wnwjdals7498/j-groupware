import { assertCustomerTenantId, SERVICE_CATALOG } from "@j-auth/contracts";
import { AgentError } from "./reconciler.mjs";
const services = SERVICE_CATALOG.filter(
  (s) => s.tenantService && !s.required,
).map((s) => s.serviceId);
const allowedErrors = new Set([
  "invalid_state",
  "cancelled",
  "read_timeout",
  "provision_failed",
  "observation_failed",
  "desired_unavailable",
  "inventory_unavailable",
]);
function selected(value) {
  if (
    !Array.isArray(value) ||
    value.length > services.length ||
    new Set(value).size !== value.length ||
    value.some((v) => !services.includes(v))
  )
    throw new AgentError("invalid_state");
  return services.filter((s) => value.includes(s));
}
const positive = (n) => Number.isInteger(n) && n > 0 && n <= 2147483647;
export class ConsoleAgentClient {
  constructor({ tenant, origin, key, fetch = globalThis.fetch }) {
    assertCustomerTenantId(tenant);
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "console.jgw.test" ||
      url.port === "3001" ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[A-Za-z0-9_-]{43}$/.test(key) ||
      typeof fetch !== "function"
    )
      throw new AgentError("invalid_configuration");
    Object.assign(this, { tenant, origin: url.origin, key, fetch });
  }
  async request(path, method, body, signal) {
    if (!(
      (path === "/console/api/agent/desired-state" &&
        method === "GET" &&
        body === undefined) ||
      (path === "/console/api/agent/status" && method === "POST" && body)
    ))
      throw new AgentError("invalid_state");
    signal?.throwIfAborted();
    let response;
    try {
      response = await this.fetch(this.origin + path, {
        method,
        credentials: "omit",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
        headers: {
          Authorization: "Bearer " + this.key,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AgentError("console_unavailable");
    }
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("application/json")
    ) {
      await response.body?.cancel();
      throw new AgentError(
        response.status === 409 ? "stale_state" : "console_unavailable",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AgentError("invalid_state");
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) throw new AgentError("invalid_state");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      await reader.cancel().catch(() => {});
      throw new AgentError("invalid_state");
    } finally {
      reader.releaseLock();
    }
  }
  async desired(signal) {
    this.current = undefined;
    const value = await this.request(
      "/console/api/agent/desired-state",
      "GET",
      undefined,
      signal,
    );
    if (
      !value ||
      value.tenant !== this.tenant ||
      !positive(value.revision) ||
      !positive(value.agentEpoch) ||
      !Number.isInteger(value.reportSequence) ||
      value.reportSequence < 0 ||
      value.reportSequence >= 2147483647
    )
      throw new AgentError("invalid_state");
    const list = selected(value.services);
    this.current = {
      revision: value.revision,
      epoch: value.agentEpoch,
      sequence: value.reportSequence,
    };
    return { tenant: this.tenant, services: list };
  }
  async report(result, signal) {
    if (
      !this.current ||
      !result ||
      result.tenant !== this.tenant ||
      !["synchronized", "failed"].includes(result.outcome) ||
      (result.phase !== undefined &&
        !["desired", "inventory", "provision"].includes(result.phase)) ||
      (result.error !== undefined && !allowedErrors.has(result.error))
    )
      throw new AgentError("invalid_state");
    const body = {
      desiredRevision: this.current.revision,
      agentEpoch: this.current.epoch,
      reportSequence: this.current.sequence + 1,
      outcome: result.outcome,
      ...(result.installed ? { installed: selected(result.installed) } : {}),
      ...(result.incomplete ? { incomplete: selected(result.incomplete) } : {}),
      ...(result.phase ? { phase: result.phase } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    const response = await this.request(
      "/console/api/agent/status",
      "POST",
      body,
      signal,
    );
    if (
      response?.accepted !== true ||
      response.desiredRevision !== this.current.revision
    )
      throw new AgentError("invalid_state");
    this.current.sequence = body.reportSequence;
  }
}
