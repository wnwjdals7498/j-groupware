import { assertCustomerTenantId } from "@j-auth/contracts";
import { X509Certificate, createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  mkdir,
  writeFile,
  rename,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { externalPath } from "../gateway/gateway.mjs";
import { serviceDatabase, ProvisionError } from "./service-database.mjs";
import { DirectoryLock } from "./reconciler.mjs";
import { privateDirectory } from "./private-files.mjs";
function origin(value, host) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProvisionError("invalid_bootstrap");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.port === "3001" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ProvisionError("invalid_bootstrap");
  return url.origin;
}
export function validateBootstrap(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "agentKey,authOrigin,bundles,clientSecret,consoleOrigin,localCa,serviceKey,tenant"
  )
    throw new ProvisionError("invalid_bootstrap");
  assertCustomerTenantId(input.tenant);
  for (const key of ["serviceKey", "agentKey"])
    if (!/^[A-Za-z0-9_-]{43}$/.test(input[key]))
      throw new ProvisionError("invalid_bootstrap");
  if (
    typeof input.clientSecret !== "string" ||
    !/^[A-Za-z0-9._~-]{16,256}$/.test(input.clientSecret)
  )
    throw new ProvisionError("invalid_bootstrap");
  const authOrigin = origin(input.authOrigin, "auth.jgw.test"),
    consoleOrigin = origin(input.consoleOrigin, "console.jgw.test");
  if (
    typeof input.localCa !== "string" ||
    Buffer.byteLength(input.localCa) > 32768
  )
    throw new ProvisionError("invalid_ca");
  let certificate;
  try {
    certificate = new X509Certificate(input.localCa);
  } catch {
    throw new ProvisionError("invalid_ca");
  }
  if (
    !certificate.ca ||
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now()
  )
    throw new ProvisionError("invalid_ca");
  if (
    !Array.isArray(input.bundles) ||
    input.bundles.length > 7 ||
    new Set(input.bundles.map((b) => b.service)).size !==
      input.bundles.length ||
    !input.bundles.some((b) => b.service === "j-groupware")
  )
    throw new ProvisionError("invalid_bundle_list");
  for (const bundle of input.bundles) {
    serviceDatabase(bundle.service);
    if (
      Object.keys(bundle).sort().join(",") !== "archive,digest,service" ||
      !/^[a-f0-9]{64}$/.test(bundle.digest)
    )
      throw new ProvisionError("invalid_bundle_list");
    externalPath(bundle.archive);
  }
  return { tenant: input.tenant, authOrigin, consoleOrigin, certificate };
}
export class BootstrapFiles {
  constructor(root) {
    this.root = externalPath(root);
    this.lock = new DirectoryLock(root);
  }
  async prepare(input) {
    const checked = validateBootstrap(input);
    await privateDirectory(this.root);
    const release = await this.lock.acquire();
    if (!release) throw new ProvisionError("busy");
    const created = [];
    try {
      const rootInfo = await lstat(this.root);
      if (rootInfo.mode & 0o077)
        throw new ProvisionError("unsafe_bootstrap_root");
      // Never re-issue or overwrite one-time secrets on retry.
      try {
        await lstat(path.join(this.root, "bootstrap.env"));
        throw new ProvisionError("bootstrap_already_prepared");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const directory = path.join(this.root, "bundles");
      await mkdir(directory, { mode: 0o700 });
      created.push(directory);
      const bundles = [];
      for (const bundle of input.bundles) {
        const info = await lstat(bundle.archive);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          (await realpath(bundle.archive)) !== bundle.archive ||
          info.size > 1024 * 1024 * 1024 ||
          ![0, process.getuid()].includes(info.uid) ||
          info.mode & 0o022
        )
          throw new ProvisionError("unsafe_bundle");
        const destination = path.join(directory, bundle.service + ".tgz");
        const digest = createHash("sha256");
        let count = 0;
        await pipeline(
          createReadStream(bundle.archive, {
            flags: constants.O_RDONLY | constants.O_NOFOLLOW,
          }),
          new Transform({
            transform(chunk, _encoding, done) {
              count += chunk.length;
              if (count > info.size || count > 1024 * 1024 * 1024)
                return done(new ProvisionError("unsafe_bundle"));
              digest.update(chunk);
              done(null, chunk);
            },
          }),
          createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        );
        if (count !== info.size || digest.digest("hex") !== bundle.digest)
          throw new ProvisionError("bundle_digest_mismatch");
        bundles.push({ service: bundle.service, digest: bundle.digest });
      }
      const env = {
        JGW_TENANT: checked.tenant,
        KC_PUBLIC_URL: checked.authOrigin,
        JGW_CONSOLE_ORIGIN: checked.consoleOrigin,
        JGW_OIDC_CLIENT_SECRET: input.clientSecret,
        JGW_AUTH_SERVICE_KEY: input.serviceKey,
        JGW_AGENT_KEY: input.agentKey,
      };
      const files = {
        "auth-ca.crt": checked.certificate.toString(),
        "bootstrap.env":
          Object.entries(env)
            .map(([key, value]) => key + "=" + value)
            .join("\n") + "\n",
        "bootstrap.json":
          JSON.stringify({
            tenant: checked.tenant,
            phase: "prepared",
            caFingerprint: checked.certificate.fingerprint256,
            bundles,
          }) + "\n",
      };
      // Secret file is the final commit marker; incomplete preparations are removed.
      for (const name of ["auth-ca.crt", "bootstrap.json", "bootstrap.env"]) {
        const destination = path.join(this.root, name),
          temporary = destination + "." + randomUUID() + ".partial";
        try {
          await writeFile(temporary, files[name], { flag: "wx", mode: 0o600 });
          await rename(temporary, destination);
          created.push(destination);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      return {
        tenant: checked.tenant,
        phase: "prepared",
        bundles: bundles.map((b) => b.service),
        caFingerprint: checked.certificate.fingerprint256,
      };
    } catch (error) {
      for (const file of created.reverse())
        await rm(file, { recursive: true, force: true });
      throw error instanceof ProvisionError
        ? error
        : new ProvisionError("bootstrap_preparation_failed");
    } finally {
      await release();
    }
  }
}
