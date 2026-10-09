import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { protectedStoragePath } from "./product-storage.mjs";
import { externalPath } from "../gateway/gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";

export const installationDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function installationDirectory(directory, mode = 0o755) {
  externalPath(directory);
  if (process.getuid() !== 0) throw new ProvisionError("root_required");
  try {
    await protectedStoragePath(directory, true);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    try {
      await protectedStoragePath(parent, true);
    } catch (parentError) {
      if (parentError.code !== "ENOENT") throw parentError;
      await installationDirectory(parent);
    }
    await mkdir(directory, { mode });
    await chmod(directory, mode);
    await protectedStoragePath(directory, true);
  }
  if (((await lstat(directory)).mode & 0o777) !== mode)
    throw new ProvisionError("installation_directory_conflict");
}
// Fixed destinations only in callers. Existing different files are never replaced.
export async function installationFile(file, bytes, mode = 0o600) {
  externalPath(file);
  if (process.getuid() !== 0) throw new ProvisionError("root_required");
  await protectedStoragePath(path.dirname(file), true);
  try {
    await protectedStoragePath(file, false);
    const info = await lstat(file);
    if (
      (info.mode & 0o777) !== mode ||
      info.size !== Buffer.byteLength(bytes) ||
      !(await readFile(file)).equals(Buffer.from(bytes))
    )
      throw new ProvisionError("installation_file_conflict");
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = file + "." + randomUUID() + ".partial";
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    // Private/root-owned ancestry excludes a foreign writer. Do not overwrite a race.
    try {
      await lstat(file);
      throw new ProvisionError("installation_file_conflict");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(temporary, file);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}
