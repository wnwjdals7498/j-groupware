import { SERVICE_CATALOG, assertCustomerTenantId } from "@j-auth/contracts";
import {
  mkdir,
  realpath,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { externalPath } from "../gateway/gateway.mjs";

const optional = SERVICE_CATALOG.filter(
  (s) => s.tenantService && s.serviceId !== "j-groupware",
).map((s) => s.serviceId);
export class AgentError extends Error {
  constructor(code) {
    super(code);
    this.name = "AgentError";
    this.code = code;
  }
}
function tenant(value) {
  try {
    assertCustomerTenantId(value);
  } catch {
    throw new AgentError("invalid_state");
  }
  return value;
}
function serviceList(value) {
  if (
    !Array.isArray(value) ||
    value.length > optional.length ||
    new Set(value).size !== value.length ||
    value.some((s) => !optional.includes(s))
  )
    throw new AgentError("invalid_state");
  return optional.filter((s) => value.includes(s));
}
// Internal adapter shape, not a console HTTP contract or a persisted status schema.
export function planActions(tenantId, desired, inventory) {
  tenant(tenantId);
  if (
    !desired ||
    !inventory ||
    desired.tenant !== tenantId ||
    inventory.tenant !== tenantId
  )
    throw new AgentError("invalid_state");
  const wanted = serviceList(desired.services),
    installed = serviceList(inventory.installed);
  return [
    ...wanted
      .filter((s) => !installed.includes(s))
      .map((service) => ({ kind: "install", service })),
    ...installed
      .filter((s) => !wanted.includes(s))
      .map((service) => ({ kind: "remove", service })),
  ];
}
export class DirectoryLock {
  constructor(root) {
    this.root = externalPath(root);
  }
  async acquire() {
    let ancestor = this.root;
    while (true) {
      try {
        if ((await realpath(ancestor)) !== ancestor)
          throw new AgentError("unsafe_lock_root");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (
      (await realpath(this.root)) !== this.root ||
      !info.isDirectory() ||
      info.uid !== process.getuid() ||
      info.mode & 0o022
    )
      throw new AgentError("unsafe_lock_root");
    const directory = path.join(this.root, ".run.lock");
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") return undefined;
      throw error;
    }
    const token = randomUUID();
    try {
      await writeFile(
        path.join(directory, "owner.json"),
        JSON.stringify({ pid: process.pid, token }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      const owner = JSON.parse(
        await readFile(path.join(directory, "owner.json"), "utf8"),
      );
      if (owner.token !== token || (await realpath(directory)) !== directory)
        throw new AgentError("lock_lost");
      await rm(directory, { recursive: true });
      released = true;
    };
  }
}
function cancelled(signal) {
  if (signal?.aborted) throw new AgentError("cancelled");
}
async function readBounded(reader, signal, timeout) {
  cancelled(signal);
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(new AgentError(signal?.aborted ? "cancelled" : "read_timeout"));
  combined.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await Promise.race([
      Promise.resolve().then(() => reader(combined)),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", onAbort);
  }
}
export class AgentReconciler {
  constructor({
    tenant: tenantId,
    lock,
    desired,
    inventory,
    provision,
    report,
    readTimeout = 5000,
  }) {
    this.tenant = tenant(tenantId);
    if (
      !lock?.acquire ||
      !desired ||
      !inventory ||
      !provision ||
      !report ||
      !Number.isInteger(readTimeout) ||
      readTimeout < 10 ||
      readTimeout > 30000
    )
      throw new AgentError("invalid_configuration");
    Object.assign(this, {
      lock,
      desired,
      inventory,
      provision,
      report,
      readTimeout,
    });
  }
  async run(signal) {
    cancelled(signal);
    const release = await this.lock.acquire();
    if (!release)
      return {
        tenant: this.tenant,
        outcome: "busy",
        actions: [],
        reported: false,
      };
    let observed, desiredServices;
    const actions = [];
    let phase = "desired",
      error;
    const readInventory = async () => {
      const current = await readBounded(
        this.inventory,
        signal,
        this.readTimeout,
      );
      if (!current || current.tenant !== this.tenant)
        throw new AgentError("invalid_state");
      observed = serviceList(current.installed);
      return { tenant: this.tenant, installed: observed };
    };
    try {
      try {
        const wanted = await readBounded(
          this.desired,
          signal,
          this.readTimeout,
        );
        if (!wanted || wanted.tenant !== this.tenant)
          throw new AgentError("invalid_state");
        desiredServices = serviceList(wanted.services);
        phase = "inventory";
        const current = await readInventory();
        const planned = planActions(
          this.tenant,
          { tenant: this.tenant, services: desiredServices },
          current,
        );
        for (const action of planned) {
          cancelled(signal);
          phase = "provision";
          let failed = false;
          // Never race a mutating adapter. It must settle/stop its process before unlock.
          try {
            await this.provision(action, signal);
          } catch {
            failed = true;
          }
          observed = undefined;
          phase = "inventory";
          try {
            await readInventory();
          } catch {
            actions.push({ ...action, outcome: "unconfirmed" });
            throw new AgentError(
              signal?.aborted ? "cancelled" : "observation_failed",
            );
          }
          if (failed || signal?.aborted) {
            actions.push({ ...action, outcome: "failed" });
            phase = "provision";
            throw new AgentError(
              signal?.aborted ? "cancelled" : "provision_failed",
            );
          }
          const reflected =
            action.kind === "install"
              ? observed.includes(action.service)
              : !observed.includes(action.service);
          if (!reflected) {
            actions.push({ ...action, outcome: "unconfirmed" });
            throw new AgentError("observation_failed");
          }
          actions.push({ ...action, outcome: "applied" });
        }
        if (
          planActions(
            this.tenant,
            { tenant: this.tenant, services: desiredServices },
            { tenant: this.tenant, installed: observed },
          ).length
        )
          throw new AgentError("observation_failed");
      } catch (failure) {
        const safeCodes = [
          "invalid_state",
          "cancelled",
          "read_timeout",
          "provision_failed",
          "observation_failed",
        ];
        error =
          failure instanceof AgentError && safeCodes.includes(failure.code)
            ? failure.code
            : signal?.aborted
              ? "cancelled"
              : phase + "_unavailable";
      }
      const result = {
        tenant: this.tenant,
        outcome: error ? "failed" : "synchronized",
        actions,
        ...(desiredServices ? { desired: desiredServices } : {}),
        ...(observed ? { installed: observed } : {}),
        ...(error ? { error, phase } : {}),
      };
      // The reporter is an internal, cancellation-aware adapter, not a guessed HTTP API.
      // Hold the lock until it settles to avoid an old report overtaking a later run.
      try {
        await this.report(structuredClone(result), signal);
        return { ...result, reported: true };
      } catch {
        return {
          ...result,
          reported: false,
          reportError: "report_unavailable",
        };
      }
    } finally {
      await release();
    }
  }
}
