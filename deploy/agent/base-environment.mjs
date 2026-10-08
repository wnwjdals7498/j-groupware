import { X509Certificate } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { parseEnv } from "node:util";
import path from "node:path";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { externalPath } from "../gateway/gateway.mjs";
import { privateDirectory } from "./private-files.mjs";
import { ProvisionError } from "./provision-error.mjs";
import { BUNDLE_SERVICES, PRODUCT_SERVICES } from "./product-environment.mjs";

const fail = (code = "invalid_base_configuration") => {
  throw new ProvisionError(code);
};
const secret = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    fail("invalid_environment_secrets");
  return value;
};
const port = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 65535 || value === 3001)
    fail();
  return value;
};
function origin(value, host) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
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
    fail();
  return url.origin;
}
const encode = (values) =>
  Object.entries(values)
    .map(([key, value]) => key + "=" + value)
    .join("\n") + "\n";
async function privateText(file, maximum) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & 0o077 ||
    info.size > maximum ||
    (await realpath(file)) !== file
  )
    fail("unsafe_bootstrap_file");
  return readFile(file, "utf8");
}
// The final bootstrap.env marker and canonical decoding are required before a
// sealed, one-time response can be used by the installer. Secrets stay outside source.
export async function readPreparedBootstrap(root) {
  externalPath(root);
  await privateDirectory(root);
  const text = await privateText(path.join(root, "bootstrap.env"), 32768);
  const values = parseEnv(text);
  const names = [
    "JGW_TENANT",
    "KC_PUBLIC_URL",
    "JGW_CONSOLE_ORIGIN",
    "JGW_OIDC_CLIENT_SECRET",
    "JGW_AUTH_SERVICE_KEY",
    "JGW_AGENT_KEY",
  ];
  if (
    Object.keys(values).sort().join(",") !== [...names].sort().join(",") ||
    encode(Object.fromEntries(names.map((name) => [name, values[name]]))) !==
      text
  )
    fail("invalid_bootstrap_file");
  assertCustomerTenantId(values.JGW_TENANT);
  const keycloakOrigin = origin(values.KC_PUBLIC_URL, "auth.jgw.test"),
    consoleOrigin = origin(values.JGW_CONSOLE_ORIGIN, "console.jgw.test");
  if (!/^[A-Za-z0-9._~-]{16,256}$/.test(values.JGW_OIDC_CLIENT_SECRET))
    fail("invalid_bootstrap_file");
  const serviceKey = secret(values.JGW_AUTH_SERVICE_KEY),
    agentKey = secret(values.JGW_AGENT_KEY);
  const metadata = JSON.parse(
    await privateText(root + "/bootstrap.json", 8192),
  );
  const ca = root + "/auth-ca.crt";
  let certificate;
  try {
    certificate = new X509Certificate(await privateText(ca, 32768));
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    fail("invalid_ca");
  }
  if (
    !certificate.ca ||
    Date.parse(certificate.validFrom) > Date.now() ||
    Date.parse(certificate.validTo) <= Date.now() ||
    metadata.caFingerprint !== certificate.fingerprint256
  )
    fail("invalid_ca");
  if (
    metadata.tenant !== values.JGW_TENANT ||
    metadata.phase !== "prepared" ||
    Object.keys(metadata).sort().join(",") !==
      "bundles,caFingerprint,phase,tenant" ||
    !Array.isArray(metadata.bundles) ||
    metadata.bundles.length > BUNDLE_SERVICES.length ||
    !metadata.bundles.some((bundle) => bundle?.service === "j-groupware") ||
    new Set(metadata.bundles.map((bundle) => bundle?.service)).size !==
      metadata.bundles.length
  )
    fail("invalid_bootstrap_file");
  const bundles = metadata.bundles.map((bundle) => {
    if (
      !bundle ||
      Object.keys(bundle).sort().join(",") !== "digest,service" ||
      !BUNDLE_SERVICES.includes(bundle.service) ||
      !/^[a-f0-9]{64}$/.test(bundle.digest)
    )
      fail("invalid_bootstrap_file");
    return { ...bundle, archive: root + "/bundles/" + bundle.service + ".tgz" };
  });
  return {
    tenant: values.JGW_TENANT,
    keycloakOrigin,
    consoleOrigin,
    clientSecret: values.JGW_OIDC_CLIENT_SECRET,
    serviceKey,
    agentKey,
    ca,
    bundles,
  };
}
export class BaseEnvironment {
  constructor({
    bootstrap,
    databasePort,
    port: listenPort,
    publicOrigin,
    authApiOrigin,
    certificate,
    key,
    services = {},
  }) {
    assertCustomerTenantId(bootstrap.tenant);
    if (!/^[A-Za-z0-9._~-]{16,256}$/.test(bootstrap.clientSecret)) fail();
    this.bootstrap = Object.freeze({
      tenant: bootstrap.tenant,
      keycloakOrigin: origin(bootstrap.keycloakOrigin, "auth.jgw.test"),
      clientSecret: bootstrap.clientSecret,
      serviceKey: secret(bootstrap.serviceKey),
      ca: externalPath(bootstrap.ca),
    });
    this.databasePort = port(databasePort);
    this.port = port(listenPort);
    if (this.databasePort === this.port) fail();
    this.publicOrigin = origin(publicOrigin, `gw.${bootstrap.tenant}.jgw.test`);
    this.authOrigin = origin(authApiOrigin, "jauth.jgw.test");
    this.certificate = externalPath(certificate);
    this.key = externalPath(key);
    if (!services || typeof services !== "object" || Array.isArray(services))
      fail();
    this.services = {};
    const ports = [this.databasePort, this.port];
    for (const [service, value] of Object.entries(services)) {
      if (!PRODUCT_SERVICES.includes(service)) fail();
      const url = new URL(origin(value, "127.0.0.1"));
      if (!url.port) fail();
      ports.push(port(Number(url.port)));
      this.services[service] = url.origin;
    }
    if (new Set(ports).size !== ports.length) fail();
    Object.freeze(this.services);
  }
  profile(service) {
    if (service !== "j-groupware")
      throw new ProvisionError("product_adapter_unbound");
    const url = new URL(this.publicOrigin);
    return {
      port: this.port,
      ca: this.certificate,
      serverName: url.hostname,
      publicHost: url.host,
    };
  }
  variables(service, value) {
    this.profile(service);
    const b = this.bootstrap;
    const variables = {
      NODE_ENV: "production",
      JGW_TENANT: b.tenant,
      KC_PUBLIC_URL: b.keycloakOrigin,
      JAUTH_PUBLIC_URL: this.authOrigin,
      JGW_PUBLIC_ORIGIN: this.publicOrigin,
      JGW_CLIENT_SECRET: b.clientSecret,
      JGW_SERVICE_KEY: b.serviceKey,
      JGW_PORT: String(this.port),
      JGW_DB_HOST: "127.0.0.1",
      JGW_DB_PORT: String(this.databasePort),
      JGW_DB_NAME: "jgw_groupware",
      JGW_DB_USER: "jgw_groupware",
      JGW_DB_PASSWORD: secret(value.databasePassword),
      JGW_TLS_CERTIFICATE: this.certificate,
      JGW_TLS_KEY: this.key,
      NODE_EXTRA_CA_CERTS: b.ca,
      JGW_PROVISION_NOTIFICATION_KEY: secret(value.notificationKey),
    };
    for (const [id, endpoint] of Object.entries(this.services))
      variables[
        "JGW_SERVICE_" + id.slice(2).replaceAll("-", "_").toUpperCase() + "_URL"
      ] = endpoint;
    return variables;
  }
  render(service, value) {
    return encode(this.variables(service, value));
  }
  read(service, text) {
    const values = parseEnv(text),
      secrets = {
        databasePassword: values.JGW_DB_PASSWORD,
        notificationKey: values.JGW_PROVISION_NOTIFICATION_KEY,
      };
    if (this.render(service, secrets) !== text) fail("environment_conflict");
    return secrets;
  }
}
