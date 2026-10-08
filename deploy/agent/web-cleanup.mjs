import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ProvisionError } from "./provision-error.mjs";

const binary = "/usr/local/sbin/jweb-helper";
// The installer runs as root after stop/dump/NOLOGIN. This capability exposes
// only the helper's backed-up remove-all operation, never purge or arbitrary OS commands.
export class WebServiceCleanup {
  async run(service) {
    if (service !== "j-web")
      throw new ProvisionError("cleanup_adapter_unbound");
    if (process.getuid() !== 0) throw new ProvisionError("root_required");
    for (let file = binary; file !== "/"; file = path.dirname(file)) {
      const info = await lstat(file);
      if (
        info.uid !== 0 ||
        info.mode & 0o022 ||
        info.isSymbolicLink() ||
        (await realpath(file)) !== file ||
        (file === binary
          ? !info.isFile() || !(info.mode & 0o111) || info.size > 262144
          : !info.isDirectory())
      )
        throw new ProvisionError("unsafe_web_helper");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ["remove-all"], {
        detached: true,
        shell: false,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks = [];
      let size = 0,
        timedOut = false,
        stopFailed = false;
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") stopFailed = true;
          }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, 60000);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8192) kill();
        else chunks.push(chunk);
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new ProvisionError("web_cleanup_failed"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        kill();
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (
            code !== 0 ||
            timedOut ||
            stopFailed ||
            size > 8192 ||
            value?.ok !== true ||
            !Number.isInteger(value.removed) ||
            value.removed < 0
          )
            throw new Error();
          resolve({ service: "j-web", removed: value.removed });
        } catch {
          reject(new ProvisionError("web_cleanup_failed"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end("{}");
    });
  }
}
