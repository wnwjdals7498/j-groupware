import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { SERVICE_CATALOG } from "@j-auth/contracts";
import { externalPath } from "../gateway/gateway.mjs";
import { AgentError } from "./reconciler.mjs";

const optional = new Set(
  SERVICE_CATALOG.filter(
    (s) => s.tenantService && s.serviceId !== "j-groupware",
  ).map((s) => s.serviceId),
);
// Only the fixed installer interface: install or backed-up removal. Purge is absent.
export function provisionCommand(
  binary,
  { timeout = 180000, grace = 500 } = {},
) {
  externalPath(binary);
  if (
    process.platform !== "linux" ||
    !Number.isInteger(timeout) ||
    timeout < 50 ||
    timeout > 600000 ||
    !Number.isInteger(grace) ||
    grace < 10 ||
    grace > 5000
  )
    throw new AgentError("invalid_configuration");
  return async ({ kind, service }, signal) => {
    if (!["install", "remove"].includes(kind) || !optional.has(service))
      throw new AgentError("invalid_state");
    if (signal?.aborted) throw new AgentError("cancelled");
    const info = await lstat(binary);
    if (
      (await realpath(binary)) !== binary ||
      !info.isFile() ||
      ![0, process.getuid()].includes(info.uid) ||
      info.mode & 0o022
    )
      throw new AgentError("invalid_configuration");
    return new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        [service, ...(kind === "remove" ? ["--remove"] : [])],
        {
          shell: false,
          detached: true,
          env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      let closed = false,
        cancelling = false,
        killed = false,
        code,
        killTimer;
      const terminateGroup = (sig) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, sig);
        } catch (error) {
          if (error.code !== "ESRCH")
            throw new AgentError("provision_stop_failed");
        }
      };
      const finish = () => {
        if (!closed || (cancelling && !killed)) return;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (cancelling)
          reject(
            new AgentError(signal?.aborted ? "cancelled" : "provision_timeout"),
          );
        else if (code === 0) resolve();
        else reject(new AgentError("provision_failed"));
      };
      const abort = () => {
        if (cancelling) return;
        cancelling = true;
        terminateGroup("SIGTERM");
        killTimer = setTimeout(() => {
          terminateGroup("SIGKILL");
          killed = true;
          finish();
        }, grace);
      };
      const timer = setTimeout(abort, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => {
        closed = true;
        code = 1;
        finish();
      });
      child.once("close", (value) => {
        closed = true;
        code = value;
        if (!cancelling) terminateGroup("SIGKILL");
        finish();
      });
      if (signal?.aborted) abort();
    });
  };
}
