import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { ProvisionError } from "./provision-error.mjs";
export async function privateDirectory(target) {
  const entries = [];
  for (let value = target; value !== "/"; value = path.dirname(value))
    entries.unshift(value);
  for (const value of entries) {
    let info;
    try {
      info = await lstat(value);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(value, { mode: 0o700 });
      info = await lstat(value);
    }
    const trustedTemporary =
      ["/tmp", "/var/tmp"].includes(value) &&
      info.uid === 0 &&
      Boolean(info.mode & 0o1000);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ![0, process.getuid()].includes(info.uid) ||
      (info.mode & 0o022 && !trustedTemporary)
    )
      throw new ProvisionError("unsafe_private_directory");
  }
  const info = await lstat(target);
  if (info.uid !== process.getuid() || info.mode & 0o077)
    throw new ProvisionError("unsafe_private_directory");
}
