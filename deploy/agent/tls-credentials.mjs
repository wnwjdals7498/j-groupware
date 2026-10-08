import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  createHash,
  randomUUID,
} from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { readControlFile } from "./control-files.mjs";
import { ProvisionError } from "./provision-error.mjs";
import { externalPath } from "../gateway/gateway.mjs";
const mappings = Object.freeze({
  "j-groupware": ["JGW_TLS_CERTIFICATE", "JGW_TLS_KEY", "NODE_EXTRA_CA_CERTS"],
  "j-approval": ["JAP_TLS_CERTIFICATE", "JAP_TLS_KEY", "NODE_EXTRA_CA_CERTS"],
  "j-messenger": ["TLS_CERT_PATH", "TLS_KEY_PATH", "NODE_EXTRA_CA_CERTS"],
  "j-talk": ["JT_TLS_CERTIFICATE", "JT_TLS_KEY", "NODE_EXTRA_CA_CERTS"],
  "j-mail": ["JML_TLS_CERTIFICATE", "JML_TLS_KEY", "NODE_EXTRA_CA_CERTS"],
  "j-web": ["JW_TLS_CERTIFICATE", "JW_TLS_KEY", "NODE_EXTRA_CA_CERTS"],
  "j-customer-auth-db": [
    "JCADB_TLS_CERTIFICATE",
    "JCADB_TLS_KEY",
    "JCADB_CA_CERTIFICATE",
    "JCADB_GUEST_SIGNING_KEY",
  ],
});
export const credentialNames = Object.freeze([
  "tls-certificate",
  "tls-key",
  "ca-certificate",
  "guest-signing-key",
]);
export function serviceCredentialVariables(service) {
  if (typeof service !== "string" || !Object.hasOwn(mappings, service))
    throw new ProvisionError("invalid_service");
  const variables = mappings[service];
  if (!variables) throw new ProvisionError("invalid_service");
  return variables;
}
Object.values(mappings).forEach(Object.freeze);
const digest = (value) => createHash("sha256").update(value).digest("hex");
function validCertificate(pem) {
  const cert = new X509Certificate(pem),
    now = Date.now();
  if (!(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo)))
    throw new ProvisionError("invalid_tls_credentials");
  return cert;
}
function validate(material) {
  try {
    for (const index of [0, 2])
      if (
        !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(
          material[index],
        )
      )
        throw new ProvisionError("invalid_tls_credentials");
    for (const index of [1, ...(material[3] ? [3] : [])])
      if (
        !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\r?\n?$/.test(
          material[index],
        )
      )
        throw new ProvisionError("invalid_tls_credentials");
    const cert = validCertificate(material[0]),
      key = createPrivateKey(material[1]),
      ca = validCertificate(material[2]);
    if (
      !ca.ca ||
      cert.ca ||
      !cert.checkPrivateKey(key) ||
      !cert.verify(ca.publicKey)
    )
      throw new ProvisionError("invalid_tls_credentials");
    if (material[3]) {
      const signing = createPrivateKey(material[3]);
      if (
        signing.asymmetricKeyType !== "rsa" ||
        (signing.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new ProvisionError("invalid_tls_credentials");
      const signingPublic = createPublicKey(signing).export({
        type: "spki",
        format: "der",
      });
      if (
        signingPublic.equals(
          ca.publicKey.export({ type: "spki", format: "der" }),
        ) ||
        signingPublic.equals(
          cert.publicKey.export({ type: "spki", format: "der" }),
        )
      )
        throw new ProvisionError("invalid_tls_credentials");
    }
  } catch {
    throw new ProvisionError("invalid_tls_credentials");
  }
}
async function rootDirectory(directory) {
  for (
    let current = directory;
    current !== "/";
    current = path.dirname(current)
  ) {
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      info.mode & 0o022
    )
      throw new ProvisionError("unsafe_credentials_directory");
  }
}
// Root-only source material stays inaccessible to service users. PID 1 copies
// only these fixed files through LoadCredential into the unit's private runtime.
export class NativeTlsCredentials {
  constructor({ environmentRoot }) {
    this.root = externalPath(environmentRoot);
  }
  directory(service) {
    serviceCredentialVariables(service);
    return path.join(this.root, service + ".credentials");
  }
  async prepare(service) {
    const variables = serviceCredentialVariables(service);
    if (process.getuid() !== 0) throw new ProvisionError("root_required");
    await rootDirectory(this.root);
    const text = await readControlFile(path.join(this.root, service + ".env"));
    const env = parseEnv(text);
    const material = await Promise.all(
      variables.map((variable, index) =>
        readControlFile(externalPath(env[variable]), {
          privateFile: index === 1 || index === 3,
          maximum: 65536,
        }),
      ),
    );
    validate(material);
    const metadata =
        JSON.stringify({ version: 1, service, hashes: material.map(digest) }) +
        "\n",
      target = this.directory(service);
    try {
      await rootDirectory(target);
      const entries = await import("node:fs/promises").then((fs) =>
        fs.readdir(target),
      );
      if (
        entries.sort().join(",") !==
          ["metadata.json", ...credentialNames.slice(0, material.length)]
            .sort()
            .join(",") ||
        (await readControlFile(path.join(target, "metadata.json"))) !== metadata
      )
        throw new ProvisionError("credentials_conflict");
      for (let i = 0; i < material.length; i++)
        if (
          (await readControlFile(path.join(target, credentialNames[i]), {
            maximum: 65536,
          })) !== material[i]
        )
          throw new ProvisionError("credentials_conflict");
      return { changed: false };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(
      this.root,
      service + ".credentials." + randomUUID() + ".partial",
    );
    await mkdir(temporary, { mode: 0o700 });
    try {
      for (let i = 0; i < material.length; i++)
        await writeFile(path.join(temporary, credentialNames[i]), material[i], {
          flag: "wx",
          mode: 0o600,
        });
      await writeFile(path.join(temporary, "metadata.json"), metadata, {
        flag: "wx",
        mode: 0o600,
      });
      // Directory rename cannot replace a populated existing directory; the
      // private root excludes other users. A concurrent owned install is refused.
      await rename(temporary, target);
      return { changed: true };
    } catch {
      throw new ProvisionError("credentials_conflict");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async require(service) {
    try {
      await lstat(this.directory(service));
    } catch (error) {
      if (error.code === "ENOENT")
        throw new ProvisionError("credentials_not_prepared");
      throw error;
    }
    const result = await this.prepare(service);
    if (result.changed) throw new ProvisionError("credentials_not_prepared");
  }
}
