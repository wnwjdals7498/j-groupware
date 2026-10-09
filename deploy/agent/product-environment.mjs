import { assertCustomerTenantId } from "@j-auth/contracts";
import { isIP } from "node:net";
import { parseEnv } from "node:util";
import { ProvisionError, serviceDatabase } from "./service-database.mjs";
import { externalPath } from "../gateway/gateway.mjs";

export const PRODUCT_SERVICES = Object.freeze([
  "j-approval",
  "j-messenger",
  "j-talk",
  "j-mail",
  "j-web",
  "j-customer-auth-db",
]);
export const BUNDLE_SERVICES = Object.freeze([
  "j-groupware",
  ...PRODUCT_SERVICES,
]);
const prefixes = {
  "j-approval": "JAP",
  "j-talk": "JT",
  "j-mail": "JML",
  "j-web": "JW",
  "j-customer-auth-db": "JCADB",
};
const fail = () => {
  throw new ProvisionError("invalid_product_configuration");
};
const port = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 65535 || value === 3001)
    fail();
  return value;
};
function origin(value, kind, tenant) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.port === "3001" ||
    (kind === "customer"
      ? url.protocol !== "https:" || url.hostname !== `gw.${tenant}.jgw.test`
      : kind === "keycloak"
        ? url.protocol !== "https:" ||
          !/^[a-z0-9.-]+\.jgw\.test$/.test(url.hostname)
        : url.hostname !== "127.0.0.1" ||
          !url.port ||
          (kind === "mailpit"
            ? url.protocol !== "http:"
            : !["http:", "https:"].includes(url.protocol)))
  )
    fail();
  return url.origin;
}
const secret = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new ProvisionError("invalid_environment_secrets");
  return value;
};
// Only trusted installer configuration reaches this adapter. No request body or
// inherited shell environment can add product variables or change the database.
export class ProductEnvironment {
  constructor({
    tenant,
    databasePort,
    keycloakOrigin,
    profiles,
    notificationOrigin,
  }) {
    assertCustomerTenantId(tenant);
    this.tenant = tenant;
    this.databasePort = port(databasePort);
    this.keycloakOrigin = origin(keycloakOrigin, "keycloak");
    this.notificationOrigin =
      notificationOrigin === undefined
        ? undefined
        : origin(notificationOrigin, "notification");
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles))
      fail();
    this.profiles = {};
    const ports = [databasePort];
    for (const [service, value] of Object.entries(profiles)) {
      if (
        !PRODUCT_SERVICES.includes(service) ||
        !value ||
        typeof value !== "object" ||
        Object.keys(value).some(
          (key) =>
            ![
              "port",
              "certificate",
              "key",
              "ca",
              "dataRoot",
              "mailpitOrigin",
              "customerAddress",
              "publicOrigin",
              "guestSigningKey",
            ].includes(key),
        )
      )
        fail();
      const p = {
        port: port(value.port),
        certificate: externalPath(value.certificate),
        key: externalPath(value.key),
        ca: externalPath(value.ca),
      };
      ports.push(p.port);
      if (service === "j-customer-auth-db") {
        p.publicOrigin = origin(value.publicOrigin, "customer", tenant);
        p.serverName = new URL(p.publicOrigin).hostname;
        p.publicHost = new URL(p.publicOrigin).host;
        p.guestSigningKey = externalPath(value.guestSigningKey);
      } else if (
        value.publicOrigin !== undefined ||
        value.guestSigningKey !== undefined
      )
        fail();
      if (service === "j-messenger") p.dataRoot = externalPath(value.dataRoot);
      if (service === "j-mail")
        p.mailpitOrigin = origin(value.mailpitOrigin, "mailpit");
      if (value.customerAddress !== undefined) {
        if (service !== "j-web" || isIP(value.customerAddress) !== 4) fail();
        p.customerAddress = value.customerAddress;
      }
      if (service === "j-approval" && !this.notificationOrigin) fail();
      this.profiles[service] = Object.freeze(p);
    }
    if (!ports.length || new Set(ports).size !== ports.length) fail();
    Object.freeze(this.profiles);
  }
  profile(service) {
    serviceDatabase(service);
    const value = this.profiles[service];
    if (!value) throw new ProvisionError("product_adapter_unbound");
    return value;
  }
  variables(service, value) {
    const p = this.profile(service),
      db = serviceDatabase(service);
    const variables = {
      NODE_ENV: "production",
      KC_PUBLIC_URL: this.keycloakOrigin,
      NODE_EXTRA_CA_CERTS: p.ca,
      JGW_PROVISION_NOTIFICATION_KEY: secret(value.notificationKey),
    };
    const password = secret(value.databasePassword);
    if (service === "j-messenger") {
      Object.assign(variables, {
        HOST: "127.0.0.1",
        PORT: String(p.port),
        PUBLIC_ORIGIN: `https://127.0.0.1:${p.port}`,
        AUTH_MODE: "j-auth",
        JAUTH_TENANT: this.tenant,
        DATABASE_DRIVER: "postgres",
        DATABASE_SCHEMA: "public",
        DATABASE_URL: `postgres://jgw_messenger:${password}@127.0.0.1:${this.databasePort}/jgw_messenger`,
        CURSOR_SIGNING_KEY: secret(value.cursorSigningKey),
        TLS_CERT_PATH: p.certificate,
        TLS_KEY_PATH: p.key,
        DB_PATH: p.dataRoot + "/unused.sqlite",
        FILE_ROOT: p.dataRoot + "/files",
        TEMP_ROOT: p.dataRoot + "/tmp",
        WEB_DIST: p.dataRoot + "/web-dist",
        BACKUP_ROOT: p.dataRoot + "/backups",
      });
    } else {
      const prefix = prefixes[service];
      Object.assign(variables, {
        [prefix + "_TENANT"]: this.tenant,
        [prefix + "_DB_HOST"]: "127.0.0.1",
        [prefix + "_DB_PORT"]: String(this.databasePort),
        [prefix + "_DB_NAME"]: db,
        [prefix + "_DB_USER"]: db,
        [prefix + "_DB_PASSWORD"]: password,
        [prefix + "_PORT"]: String(p.port),
        [prefix + "_TLS_CERTIFICATE"]: p.certificate,
        [prefix + "_TLS_KEY"]: p.key,
      });
      if (service === "j-approval")
        Object.assign(variables, {
          JAP_NOTIFICATION_URL: this.notificationOrigin,
          JAP_NOTIFICATION_KEY: value.notificationKey,
        });
      if (service === "j-talk" && this.notificationOrigin)
        Object.assign(variables, {
          JT_NOTIFICATION_URL: this.notificationOrigin,
          JT_NOTIFICATION_KEY: value.notificationKey,
        });
      if (service === "j-mail") variables.JML_MAILPIT_URL = p.mailpitOrigin;
      if (service === "j-customer-auth-db") {
        const cursorSigningKey = secret(value.cursorSigningKey);
        if (
          Buffer.from(cursorSigningKey, "base64url").toString("base64url") !==
          cursorSigningKey
        )
          fail();
        Object.assign(variables, {
          JCADB_PUBLIC_ORIGIN: p.publicOrigin,
          JCADB_CA_CERTIFICATE: p.ca,
          JCADB_GUEST_SIGNING_KEY: p.guestSigningKey,
          JCADB_CURSOR_SIGNING_KEY: cursorSigningKey,
        });
      }
      if (service === "j-web" && p.customerAddress)
        variables.JW_CUSTOMER_ADDRESS = p.customerAddress;
    }
    return variables;
  }
  render(service, value) {
    return Object.entries(this.variables(service, value))
      .map(([key, text]) => `${key}=${text}\n`)
      .join("");
  }
  read(service, text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 32768) fail();
    const variables = parseEnv(text),
      prefix = prefixes[service];
    let password;
    if (service === "j-messenger") {
      try {
        password = new URL(variables.DATABASE_URL).password;
      } catch {
        fail();
      }
    } else password = variables[prefix + "_DB_PASSWORD"];
    const value = {
      databasePassword: secret(password),
      notificationKey: secret(variables.JGW_PROVISION_NOTIFICATION_KEY),
      ...(["j-messenger", "j-customer-auth-db"].includes(service)
        ? {
            cursorSigningKey: secret(
              variables[
                service === "j-messenger"
                  ? "CURSOR_SIGNING_KEY"
                  : "JCADB_CURSOR_SIGNING_KEY"
              ],
            ),
          }
        : {}),
    };
    // Exact comparison refuses duplicate keys, secret drift and an otherwise
    // syntactically valid file targeting another tenant, DB, port or TLS file.
    if (this.render(service, value) !== text)
      throw new ProvisionError("environment_profile_mismatch");
    return value;
  }
}
