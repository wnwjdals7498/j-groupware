import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
  readFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCustomerTenantId, SERVICE_CATALOG } from "@j-auth/contracts";

const templates = fileURLToPath(new URL("./", import.meta.url));
const checkout = path.resolve(templates, "../..");
const services = new Set(
  SERVICE_CATALOG.filter(
    (s) => s.tenantService && s.serviceId !== "j-groupware",
  ).map((s) => s.serviceId),
);
export class GatewayError extends Error {
  constructor(code) {
    super(code);
    this.name = "GatewayError";
    this.code = code;
  }
}
function invalid() {
  throw new GatewayError("invalid_profile");
}
function integer(raw, fallback, max = 65535) {
  const s = raw ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(s)) invalid();
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n > max) invalid();
  return n;
}
function port(raw, fallback) {
  const n = integer(raw, fallback);
  if (n === 3001) invalid();
  return n;
}
function list(raw, check) {
  if (raw === "") return [];
  if (typeof raw !== "string" || raw.length > 2048) invalid();
  const values = raw.split(",");
  if (new Set(values).size !== values.length) invalid();
  for (const value of values) {
    try {
      check(value);
    } catch {
      invalid();
    }
  }
  return values;
}
export function externalPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^\/[A-Za-z0-9_./-]+$/.test(value) ||
    path.normalize(value) !== value ||
    value === "/"
  )
    invalid();
  const relative = path.relative(checkout, value);
  if (!relative.startsWith("../")) invalid();
  return value;
}
export function loadGatewayProfile(env) {
  const tenant = env.JGW_TENANT;
  try {
    assertCustomerTenantId(tenant);
  } catch {
    invalid();
  }
  const allowed = list(env.JGW_GATEWAY_ALLOWED_TENANTS, assertCustomerTenantId);
  if (!allowed.includes(tenant)) invalid();
  const subscribed = list(env.JGW_GATEWAY_SERVICES ?? "", (s) => {
    if (!services.has(s)) invalid();
  });
  const bind = env.JGW_GATEWAY_BIND ?? "0.0.0.0";
  if (!["127.0.0.1", "0.0.0.0"].includes(bind)) invalid();
  const httpPort = port(env.JGW_GATEWAY_HTTP_PORT, 80);
  const httpsPort = port(env.JGW_GATEWAY_HTTPS_PORT, 443);
  const bffPort = port(env.JGW_PORT, 54233);
  const upstream = (id, name, protocolName) => {
    if (!subscribed.includes(id)) return undefined;
    const protocol = env[protocolName] ?? "http";
    if (!["http", "https"].includes(protocol)) invalid();
    return { port: port(env[name]), protocol };
  };
  const customer = upstream(
    "j-customer-auth-db",
    "JCADB_INTERNAL_PORT",
    "JCADB_INTERNAL_PROTOCOL",
  );
  const talk = upstream(
    "j-talk",
    "JTALK_INTERNAL_PORT",
    "JTALK_INTERNAL_PROTOCOL",
  );
  const ports = [
    httpPort,
    httpsPort,
    bffPort,
    customer?.port,
    talk?.port,
  ].filter((n) => n !== undefined);
  if (new Set(ports).size !== ports.length) invalid();
  return Object.freeze({
    tenant,
    allowed,
    subscribed,
    bind,
    httpPort,
    httpsPort,
    bffPort,
    customer,
    talk,
    certificate: externalPath(env.JGW_TLS_CERTIFICATE),
    key: externalPath(env.JGW_TLS_KEY),
    upstreamCa: externalPath(env.JGW_GATEWAY_UPSTREAM_CA),
    rate: integer(env.JGW_EXT_RATE, 10, 10000),
    burst: integer(env.JGW_EXT_BURST, 20, 10000),
    connections: integer(env.JGW_EXT_CONNECTIONS, 20, 10000),
  });
}
// stdout is used only by the renderer. Never expose stderr/config/env on errors.
export function execute(
  command,
  args,
  { input, env = process.env, timeout = 15000, maximum = 131072 } = {},
) {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 4 * 1024 * 1024
  )
    throw new GatewayError("invalid_output_limit");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      size = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GatewayError("command_timeout"));
    }, timeout);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new GatewayError("command_failed"));
    });
    child.stdout.on("data", (data) => {
      size += data.length;
      if (size <= maximum) output += data;
      else child.kill("SIGKILL");
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && size <= maximum) resolve(output);
      else reject(new GatewayError("command_failed"));
    });
  });
}
export async function envsubst(input, variables) {
  const whitelist = Object.keys(variables)
    .map((name) => "$" + name)
    .join(" ");
  return execute("envsubst", [whitelist], {
    input,
    env: { PATH: process.env.PATH, ...variables },
  });
}
function extRoutes(profile, root, zone) {
  const limits = `limit_req zone=${zone}_req burst=${profile.burst} nodelay;\n        limit_conn ${zone}_conn ${profile.connections};`;
  const proxy = (route, upstream) =>
    `    location ^~ ${route} {\n        ${limits}\n        proxy_pass ${upstream.protocol}://127.0.0.1:${upstream.port};\n    }`;
  const routes = [];
  if (profile.customer)
    routes.push(proxy("/ext/customer-auth/", profile.customer));
  if (profile.talk) routes.push(proxy("/ext/talk/", profile.talk));
  else
    routes.push(
      `    location = /ext/talk/v1/widget.min.js {\n        ${limits}\n        alias ${root}/empty-widget.js;\n        default_type application/javascript;\n        etag on;\n        add_header Cache-Control "max-age=300";\n    }`,
    );
  return routes.join("\n");
}
export async function renderGateway(env, root, substitute = envsubst) {
  const profile = loadGatewayProfile(env);
  externalPath(root);
  const zone =
    "jgw_" +
    createHash("sha256").update(profile.tenant).digest("hex").slice(0, 16);
  const sources = await Promise.all(
    ["nginx.conf.template", "gw.conf.template", "snippets/tls.conf"].map(
      (name) => readFile(path.join(templates, name), "utf8"),
    ),
  );
  const generation = createHash("sha256")
    .update(JSON.stringify(profile))
    .update(root);
  for (const source of sources) generation.update(source);
  for (const file of [profile.certificate, profile.upstreamCa]) {
    const info = await lstat(file);
    if (info.size > 131072) throw new GatewayError("invalid_profile");
    generation.update(await readFile(file));
  }
  const variables = {
    GW_ROOT: root,
    GW_BIND: profile.bind,
    GW_HTTP_PORT: String(profile.httpPort),
    GW_HTTPS_PORT: String(profile.httpsPort),
    GW_PUBLIC_PORT: profile.httpsPort === 443 ? "" : ":" + profile.httpsPort,
    GW_TENANT: profile.tenant,
    GW_ZONE: zone,
    GW_RATE: String(profile.rate),
    GW_BURST: String(profile.burst),
    GW_CONNECTIONS: String(profile.connections),
    GW_CERT: profile.certificate,
    GW_KEY: profile.key,
    GW_UPSTREAM_CA: profile.upstreamCa,
    GW_BFF_PORT: String(profile.bffPort),
    GW_EXT_ROUTES: extRoutes(profile, root, zone),
    GW_GENERATION: generation.digest("hex"),
  };
  const result = new Map();
  for (const [template, name] of [
    ["nginx.conf.template", "nginx.conf"],
    ["gw.conf.template", `jgw.d/gw.${profile.tenant}.conf`],
  ]) {
    const source = sources[template === "nginx.conf.template" ? 0 : 1];
    const rendered = await substitute(source, variables);
    if (
      typeof rendered !== "string" ||
      rendered.length < 64 ||
      rendered.includes("${GW_")
    )
      throw new GatewayError("substitution_failed");
    result.set(name, rendered);
  }
  result.set("snippets/tls.conf", sources[2]);
  result.set("empty-widget.js", "");
  return result;
}
async function safeDirectory(directory) {
  let ancestor = directory;
  while (true) {
    try {
      if ((await realpath(ancestor)) !== ancestor)
        throw new GatewayError("unsafe_target");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o755 });
  if (
    (await realpath(directory)) !== directory ||
    !(await lstat(directory)).isDirectory()
  )
    throw new GatewayError("unsafe_target");
}
async function previous(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131072)
      throw new GatewayError("unsafe_target");
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function writeAtomic(file, value) {
  if (value === undefined) {
    await rm(file, { force: true });
    return;
  }
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function nginxCommands(root, binary = "nginx") {
  return {
    validate: () =>
      execute(binary, ["-t", "-c", path.join(root, "nginx.conf")]),
    reload: () =>
      execute(binary, ["-s", "reload", "-c", path.join(root, "nginx.conf")]),
  };
}
// A successful signal command only acknowledges delivery. Observe the new worker.
export async function verifyGateway(files) {
  let checked = 0;
  for (const [name, content] of files) {
    if (!name.startsWith("jgw.d/") || content === undefined) continue;
    const text = content.toString();
    const port = text.match(
      /listen (?:127\.0\.0\.1|0\.0\.0\.0):([0-9]+) ssl;/,
    )?.[1];
    const host = text.match(/server_name (gw\.[a-z0-9-]+\.jgw\.test);/)?.[1];
    const cert = text.match(/ssl_certificate ([A-Za-z0-9_./-]+);/)?.[1];
    const generation = text.match(/X-JGW-Gateway-Config "([a-f0-9]{64})"/)?.[1];
    if (!port || !host || !cert || !generation)
      throw new GatewayError("activation_unconfirmed");
    const ca = await readFile(externalPath(cert));
    const deadline = Date.now() + 5000;
    let accepted = false;
    while (Date.now() < deadline) {
      accepted = await new Promise((resolve) => {
        const req = httpsRequest(
          {
            hostname: "127.0.0.1",
            port: Number(port),
            servername: host,
            ca,
            agent: false,
            path: "/internal",
            headers: { Host: `${host}:${port}` },
            timeout: 250,
          },
          (response) => {
            response.resume();
            response.on("end", () =>
              resolve(
                response.statusCode === 404 &&
                  response.headers["x-jgw-gateway-config"] === generation,
              ),
            );
            response.on("error", () => resolve(false));
          },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (accepted) break;
      await delay(60);
    }
    if (!accepted) throw new GatewayError("activation_unconfirmed");
    checked++;
  }
  if (!checked) throw new GatewayError("activation_unconfirmed");
}
// This operation is explicit; importing/rendering never reloads a host service.
export async function applyGateway(
  root,
  files,
  commands,
  { reload = true } = {},
) {
  externalPath(root);
  const names = [...files.keys()];
  if (
    !names.length ||
    names.some(
      (name) =>
        !/^(nginx\.conf|empty-widget\.js|snippets\/tls\.conf|jgw\.d\/gw\.[a-z0-9-]+\.conf)$/.test(
          name,
        ),
    )
  )
    throw new GatewayError("unsafe_target");
  await safeDirectory(root);
  const lock = path.join(root, ".jgw-gateway.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw new GatewayError("gateway_busy");
    throw error;
  }
  const backups = new Map();
  let changed = false,
    reloading = false;
  try {
    for (const subdirectory of [
      "jgw.d",
      "jweb.d",
      "snippets",
      "client-temp",
      "proxy-temp",
      "fastcgi-temp",
      "uwsgi-temp",
      "scgi-temp",
    ])
      await safeDirectory(path.join(root, subdirectory));
    for (const name of names)
      backups.set(name, await previous(path.join(root, name)));
    if (
      names.every((name) =>
        backups.get(name)?.equals(Buffer.from(files.get(name))),
      )
    ) {
      await commands.validate();
      if (reload) {
        await commands.ensureRunning?.();
        await verifyGateway(files);
      }
      return { changed: false, reloaded: false };
    }
    changed = true;
    for (const [name, content] of files)
      await writeAtomic(path.join(root, name), content);
    await commands.validate();
    if (reload) {
      reloading = true;
      await commands.reload();
      await verifyGateway(files);
    }
    return { changed: true, reloaded: reload };
  } catch (error) {
    if (changed) {
      try {
        for (const [name, content] of backups)
          await writeAtomic(path.join(root, name), content);
        if (reloading) {
          await commands.validate();
          await commands.reload();
          await verifyGateway(backups);
        }
      } catch {
        throw new GatewayError("rollback_failed");
      }
      throw new GatewayError(
        reloading ? "reload_failed_restored" : "validation_failed_restored",
      );
    }
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
