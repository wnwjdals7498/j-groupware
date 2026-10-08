import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { externalPath } from "../gateway/gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";

// Read-only: unlike directory preparation, missing inputs never create parents.
export async function readControlFile(
  file,
  { privateFile = true, maximum = 32768 } = {},
) {
  externalPath(file);
  for (
    let directory = path.dirname(file);
    directory !== "/";
    directory = path.dirname(directory)
  ) {
    const info = await lstat(directory);
    const temporary =
      ["/tmp", "/var/tmp"].includes(directory) &&
      info.uid === 0 &&
      Boolean(info.mode & 0o1000);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ![0, process.getuid()].includes(info.uid) ||
      (info.mode & 0o022 && !temporary) ||
      (await realpath(directory)) !== directory
    )
      throw new ProvisionError("unsafe_control_file");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      ![0, process.getuid()].includes(info.uid) ||
      info.mode & (privateFile ? 0o077 : 0o022) ||
      info.size > maximum ||
      (await realpath(file)) !== file
    )
      throw new ProvisionError("unsafe_control_file");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size <= maximum) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) return buffer.subarray(0, size).toString("utf8");
      size += bytesRead;
    }
    throw new ProvisionError("unsafe_control_file");
  } finally {
    await handle.close();
  }
}
export async function readControlJson(file, maximum) {
  const text = await readControlFile(file, { maximum });
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProvisionError("invalid_control_file");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value) + "\n" !== text
  )
    throw new ProvisionError("invalid_control_file");
  return value;
}
