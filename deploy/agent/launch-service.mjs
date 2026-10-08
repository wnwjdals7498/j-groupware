import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  credentialNames,
  serviceCredentialVariables,
} from "./tls-credentials.mjs";
import { ProvisionError } from "./provision-error.mjs";
export async function credentialEnvironment(
  service,
  environment = process.env,
) {
  const variables = serviceCredentialVariables(service),
    directory = environment.CREDENTIALS_DIRECTORY;
  const expected = "/run/credentials/jgw-" + service.slice(2) + ".service";
  if (directory !== expected || process.getuid() === 0)
    throw new ProvisionError("invalid_runtime_credentials");
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    ![0, process.getuid()].includes(info.uid) ||
    (await realpath(directory)) !== directory
  )
    throw new ProvisionError("invalid_runtime_credentials");
  const result = { ...environment };
  for (let i = 0; i < variables.length; i++) {
    const file = path.join(directory, credentialNames[i]),
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        stat.size === 0 ||
        stat.size > 65536 ||
        ![0, process.getuid()].includes(stat.uid)
      )
        throw new ProvisionError("invalid_runtime_credentials");
    } finally {
      await handle.close();
    }
    result[variables[i]] = file;
  }
  result.NODE_EXTRA_CA_CERTS = path.join(directory, "ca-certificate");
  for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"])
    delete result[name];
  return result;
}
export async function launchService(service, bundleRoot) {
  if (
    process.platform !== "linux" ||
    typeof process.execve !== "function" ||
    !path.isAbsolute(bundleRoot) ||
    path.normalize(bundleRoot) !== bundleRoot ||
    /[\s\0%]/u.test(bundleRoot)
  )
    throw new ProvisionError("invalid_configuration");
  const environment = await credentialEnvironment(service),
    entry = path.join(bundleRoot, service, "apps/server/dist/main.js");
  for (let current = entry; current !== "/"; current = path.dirname(current)) {
    const info = await lstat(current);
    if (
      info.uid !== 0 ||
      info.mode & 0o022 ||
      info.isSymbolicLink() ||
      (current === entry ? !info.isFile() : !info.isDirectory()) ||
      (await realpath(current)) !== current
    )
      throw new ProvisionError("unsafe_bundle");
  }
  // A fresh Node process reads NODE_EXTRA_CA_CERTS at startup. Keep the unit's
  // PID and signal behavior rather than setting the CA after Node initialization.
  process.execve(process.execPath, [process.execPath, entry], environment);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 4) {
    process.stderr.write("Invalid service launch.\n");
    process.exitCode = 1;
  } else
    launchService(process.argv[2], process.argv[3]).catch(() => {
      process.stderr.write("Service credentials or bundle unavailable.\n");
      process.exitCode = 1;
    });
}
