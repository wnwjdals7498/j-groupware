import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  Agent,
  FormData as UndiciFormData,
  fetch as undiciFetch,
} from "undici";
import type { MeResponse } from "@j-groupware/contracts";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { loadDatabaseConfig } from "../../apps/server/src/config.js";
import type { ServerConfig } from "../../apps/server/src/config.js";
import { migrate } from "../../apps/server/src/db/migrate.js";
import { OidcClient } from "../../apps/server/src/oidc.js";
import { createApp } from "../../apps/server/src/app.js";
import { digest } from "../../apps/server/src/security.js";
import type { ServiceEndpoints } from "../../apps/server/src/services.js";
import { AuthSubscriptionReader } from "../../apps/server/src/notification-projection.js";

export function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Integration requires ${name}; tests are not skipped.`);
  return value;
}
export async function integrationRuntime(
  options: {
    serviceEndpoints?: ServiceEndpoints;
    serviceEndpointsForTenant?: (
      tenant: string,
      index: number,
    ) => ServiceEndpoints;
    serviceCa?: string;
  } = {},
) {
  if (
    required("JGW_TEST_RUNTIME") !== "isolated-cloud" ||
    required("JAUTH_TEST_RUNTIME") !== "isolated-cloud"
  )
    throw new Error("Isolated cloud required.");
  const ca = await Promise.all(
    ["JAUTH_TLS_CERTIFICATE", "JGW_TLS_CERTIFICATE"].map((name) =>
      readFile(required(name), "utf8"),
    ),
  );
  if (options.serviceCa) ca.push(options.serviceCa);
  const agents: [Agent, Agent] = [true, false].map(
    (bridge) =>
      new Agent({
        connect: {
          ca,
          lookup: (host, opts, cb) => {
            const address =
              bridge && host.startsWith("gw.")
                ? required("JGW_TEST_BIND_IP")
                : "127.0.0.1";
            if (opts.all) cb(null, [{ address, family: 4 }]);
            else cb(null, address, 4);
          },
        },
      }),
  ) as [Agent, Agent];
  const fetchWith =
    (agent: Agent): typeof globalThis.fetch =>
    async (input, init) => {
      // Node's built-in FormData and this pinned undici have different brands.
      // Normalize only the transport adapter; still send real multipart bytes.
      let multipart: UndiciFormData | undefined;
      if (init?.body instanceof globalThis.FormData) {
        multipart = new UndiciFormData();
        for (const [name, value] of init.body.entries()) {
          if (typeof value === "string") multipart.append(name, value);
          else multipart.append(name, value, value.name);
        }
      }
      return (await undiciFetch(String(input), {
        ...init,
        ...(multipart ? { body: multipart } : {}),
        dispatcher: agent,
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    };
  const fetch = fetchWith(agents[0]),
    fetchLoopback = fetchWith(agents[1]);
  const pool = new Pool(loadDatabaseConfig());
  const authPool = new Pool({
    host: "127.0.0.1",
    port: 54230,
    database: "jauth",
    user: "jauth",
    password: required("JAUTH_DB_PASSWORD"),
  });
  const logs: string[] = [];
  const secretValues = new Set<string>();
  const children: ReturnType<typeof spawn>[] = [];
  const start = async (
    cwd: string,
    args: string[],
    url: string,
    env: NodeJS.ProcessEnv = process.env,
  ) => {
    const occupied = await new Promise<boolean>((resolve) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: Number(new URL(url).port),
      });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(500, () => done(false));
    });
    if (occupied)
      throw new Error(
        "Isolated service port already occupied. Existing process preserved.",
      );
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
    });
    child.stdout?.on("data", (b: Buffer) => logs.push(b.toString()));
    child.stderr?.on("data", (b: Buffer) => logs.push(b.toString()));
    children.push(child);
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw new Error("Compiled service stopped before readiness.");
      try {
        if ((await fetchLoopback(url, { signal: AbortSignal.timeout(500) })).ok)
          return child;
      } catch {
        /* bounded startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Compiled service did not become ready.");
  };
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill("SIGTERM");
      await done;
    }
  };
  try {
    await migrate(pool);
    const authRepository = fileURLToPath(
      new URL("../../../j-auth/", import.meta.url),
    );
    const preload = fileURLToPath(
      new URL("./resolve-test-hosts.mjs", import.meta.url),
    );
    await start(
      authRepository,
      [
        `--env-file=${required("JAUTH_TEST_ENV")}`,
        "--import",
        preload,
        "apps/server/dist/main.js",
      ],
      "https://jauth.jgw.test:54231/health/ready",
    );
    const kc = required("KC_PUBLIC_URL");
    let keycloakReady = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        keycloakReady = (
          await fetch(kc + "/realms/master/.well-known/openid-configuration", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        /* bounded Keycloak startup */
      }
      if (keycloakReady) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!keycloakReady)
      throw new Error("Actual Keycloak did not become ready.");
    const bootstrap = await fetch(
      kc + "/realms/master/protocol/openid-connect/token",
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: "admin-cli",
          grant_type: "password",
          username: required("KC_BOOTSTRAP_ADMIN_USERNAME"),
          password: required("KC_BOOTSTRAP_ADMIN_PASSWORD"),
        }),
      },
    );
    if (!bootstrap.ok)
      throw new Error("Fixture bootstrap failed: " + bootstrap.status);
    const master = ((await bootstrap.json()) as { access_token: string })
      .access_token;
    const operatorResponse = await fetch(
      kc + "/realms/operator/protocol/openid-connect/token",
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: "j-console",
          client_secret: required("JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET"),
          grant_type: "password",
          username: "op-admin",
          password: required("JGW_OPERATOR_OP_ADMIN_PASSWORD"),
          scope: "openid",
        }),
      },
    );
    if (!operatorResponse.ok) throw new Error("Fixture operator login failed.");
    const operator = (
      (await operatorResponse.json()) as { access_token: string }
    ).access_token;
    secretValues.add(master);
    secretValues.add(operator);
    const admin = async (path: string, init: RequestInit = {}) =>
      fetch(kc + path, {
        ...init,
        headers: {
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          Authorization: "Bearer " + master,
          ...init.headers,
        },
        signal: AbortSignal.timeout(10000),
      });
    const fixtures: {
      tenant: string;
      password: string;
      secrets: { clientSecret: string; serviceKey: string };
      origin: string;
      config: Pick<
        ServerConfig,
        "tenant" | "origin" | "keycloakOrigin" | "clientSecret"
      >;
      app: ReturnType<typeof createApp>;
      clientId: string;
      memberAuth: {
        origin: string;
        serviceKey: string;
        fetch: typeof globalThis.fetch;
      };
    }[] = [];
    const closed: string[] = [];
    const logoutTokens: string[] = [];
    const incoming: { method: string | undefined; status: number }[] = [];
    let refreshCount = 0,
      failRefresh = false,
      serviceTokenCount = 0,
      failServiceToken = false;
    let serviceTokenGate:
      { arrived: () => void; ready: Promise<void> } | undefined;
    const owned: string[] = [];
    let memberResponseGate:
      { arrived: () => void; ready: Promise<void> } | undefined;
    let profileResponseGate:
      { arrived: () => void; ready: Promise<void> } | undefined;
    let loginResponseGate:
      { arrived: () => void; ready: Promise<void> } | undefined;
    const memberCalls: {
      method: string;
      path: string;
      authorizationHash: string;
      serviceKeyHash: string;
      cookie: boolean;
    }[] = [];
    try {
      for (const [index, key] of [
        "JGW_TEST_TENANT_A",
        "JGW_TEST_TENANT_B",
      ].entries()) {
        const tenant = required(key);
        if (!/^bff-[ab]-[a-f0-9]{8}$/.test(tenant))
          throw new Error("Unexpected fixture tenant.");
        if (
          (
            await authPool.query("SELECT 1 FROM tenants WHERE tenant_id=$1", [
              tenant,
            ])
          ).rowCount ||
          (await admin("/admin/realms/tenant-" + tenant)).status !== 404
        )
          throw new Error("Refusing to replace an existing fixture tenant.");
        const password = randomBytes(24).toString("base64url");
        const result = await fetch(
          "https://jauth.jgw.test:54231/auth/tenants",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + operator,
              "X-JGW-Service-Key": required("JAUTH_CONSOLE_SERVICE_KEY"),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              tenantId: tenant,
              adminUsername: "owner",
              adminPassword: password,
            }),
          },
        );
        if (result.status !== 201)
          throw new Error(
            "Real j-auth customer creation failed: " + result.status,
          );
        owned.push(tenant);
        const secrets = (await result.json()) as {
          clientSecret: string;
          serviceKey: string;
        };
        for (const value of [
          password,
          secrets.clientSecret,
          secrets.serviceKey,
        ])
          secretValues.add(value);
        const prefix = "/admin/realms/tenant-" + tenant;
        const clients = (await (
          await admin(prefix + "/clients?clientId=j-groupware")
        ).json()) as { id: string; attributes: Record<string, string> }[];
        const client = clients[0]!;
        const origin = `https://gw.${tenant}.jgw.test:${54233 + index}`;
        const changed = await admin(prefix + "/clients/" + client.id, {
          method: "PUT",
          body: JSON.stringify({
            ...client,
            rootUrl: origin,
            baseUrl: origin,
            redirectUris: [origin + "/auth/callback"],
            webOrigins: [origin],
            attributes: {
              ...client.attributes,
              "post.logout.redirect.uris": origin + "/",
              "backchannel.logout.url": origin + "/auth/backchannel-logout",
            },
          }),
        });
        if (changed.status !== 204)
          throw new Error("Fixture callback configuration failed.");
        const config = {
          tenant,
          origin,
          keycloakOrigin: kc,
          clientSecret: secrets.clientSecret,
        };
        const transport: typeof globalThis.fetch = async (input, init) => {
          if (
            String(input).endsWith("/token") &&
            init?.body instanceof URLSearchParams &&
            init.body.get("grant_type") ===
              "urn:ietf:params:oauth:grant-type:token-exchange"
          ) {
            serviceTokenCount++;
            if (failServiceToken)
              throw new Error(
                "Injected transport failure before token exchange",
              );
          }
          if (
            String(input).endsWith("/token") &&
            init?.body instanceof URLSearchParams &&
            init.body.get("grant_type") === "refresh_token"
          ) {
            refreshCount++;
            if (failRefresh)
              throw new Error(
                "Injected transport failure before refresh request",
              );
          }
          const response = await fetch(input, init);
          if (
            init?.body instanceof URLSearchParams &&
            init.body.get("grant_type") === "authorization_code" &&
            loginResponseGate
          ) {
            const gate = loginResponseGate;
            loginResponseGate = undefined;
            gate.arrived();
            await gate.ready;
          }
          if (
            init?.body instanceof URLSearchParams &&
            init.body.get("grant_type") ===
              "urn:ietf:params:oauth:grant-type:token-exchange" &&
            serviceTokenGate
          ) {
            const gate = serviceTokenGate;
            serviceTokenGate = undefined;
            gate.arrived();
            await gate.ready;
          }
          return response;
        };
        const oidc = new OidcClient(config, { fetch: transport });
        const memberTransport: typeof globalThis.fetch = async (
          input,
          init,
        ) => {
          const headers = new Headers(init?.headers);
          memberCalls.push({
            method: init?.method ?? "GET",
            path: new URL(String(input)).pathname,
            authorizationHash: digest(headers.get("authorization") ?? ""),
            serviceKeyHash: digest(headers.get("X-JGW-Service-Key") ?? ""),
            cookie: headers.has("cookie"),
          });
          const response = await fetch(input, init);
          if (
            init?.method === "POST" &&
            response.status === 201 &&
            memberResponseGate
          ) {
            const gate = memberResponseGate;
            memberResponseGate = undefined;
            gate.arrived();
            await gate.ready;
          }
          if (
            init?.method === "GET" &&
            response.status === 200 &&
            new URL(String(input)).pathname.startsWith("/auth/members/") &&
            profileResponseGate
          ) {
            const gate = profileResponseGate;
            profileResponseGate = undefined;
            gate.arrived();
            await gate.ready;
          }
          return response;
        };
        const memberAuth = {
          origin: "https://jauth.jgw.test:54231",
          serviceKey: secrets.serviceKey,
          fetch: memberTransport,
        };
        const [cert, keyMaterial] = await Promise.all([
          readFile(required("JGW_TLS_CERTIFICATE")),
          readFile(required("JGW_TLS_KEY")),
        ]);
        const app = createApp({
          pool,
          config,
          oidc,
          memberAuth,
          ...(options.serviceEndpoints || options.serviceEndpointsForTenant
            ? {
                serviceEndpoints:
                  options.serviceEndpointsForTenant?.(tenant, index) ??
                  options.serviceEndpoints!,
              }
            : {}),
          serviceFetch: fetchLoopback,
          https: { cert, key: keyMaterial, minVersion: "TLSv1.2" },
          onSessionEnd: (hashes) => closed.push(...hashes),
        });
        app.server.on("request", (request, response) => {
          if (request.url?.startsWith("/auth/backchannel-logout"))
            response.once("finish", () =>
              incoming.push({
                method: request.method,
                status: response.statusCode,
              }),
            );
        });
        app.addHook("preHandler", async (request) => {
          if (request.routeOptions.url === "/auth/backchannel-logout") {
            const token = (request.body as { logout_token: string })
              .logout_token;
            logoutTokens.push(token);
            secretValues.add(token);
          }
        });
        await app.listen({
          host: required("JGW_TEST_BIND_IP"),
          port: 54233 + index,
        });
        fixtures.push({
          tenant,
          password,
          secrets,
          origin,
          config,
          app,
          clientId: client.id,
          memberAuth,
        });
      }
    } catch (error) {
      for (const fixture of fixtures) await fixture.app.close();
      for (const tenant of owned) {
        await admin("/admin/realms/tenant-" + tenant, { method: "DELETE" });
        await authPool.query("DELETE FROM tenants WHERE tenant_id=$1", [
          tenant,
        ]);
      }
      throw error;
    }
    const members = async (
      index: number,
      path: string,
      body?: unknown,
      method = "POST",
    ) => {
      const fixture = fixtures[index]!;
      const browser = new Browser(fetch, fixture.origin);
      await browser.login(fixture.password);
      const cookie = browser.cookies
        .get(new URL(fixture.origin).origin)
        ?.get(SESSION_POLICY.cookie);
      const row = (
        await pool.query<{ access_token: string }>(
          "SELECT access_token FROM sessions WHERE tenant_id=$1 AND session_hash=$2",
          [fixture.tenant, digest(cookie!)],
        )
      ).rows[0]!;
      secretValues.add(row.access_token);
      return await fetch("https://jauth.jgw.test:54231/auth/members" + path, {
        method,
        headers: {
          Authorization: "Bearer " + row.access_token,
          "X-JGW-Service-Key": fixture.secrets.serviceKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    return {
      pool,
      authPool,
      fetch,
      fetchLoopback,
      fixtures,
      memberCalls,
      holdNextMemberResponse: () => {
        let arrived!: () => void, release!: () => void;
        const arrival = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        memberResponseGate = { arrived, ready };
        return { arrival, release };
      },
      holdNextProfileResponse: () => {
        let arrived!: () => void, release!: () => void;
        const arrival = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        profileResponseGate = { arrived, ready };
        return { arrival, release };
      },
      holdNextLoginResponse: () => {
        let arrived!: () => void, release!: () => void;
        const arrival = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        loginResponseGate = { arrived, ready };
        return { arrival, release };
      },
      setBackchannel: async (index: number, enabled: boolean) => {
        const fixture = fixtures[index]!;
        const path = `/admin/realms/tenant-${fixture.tenant}/clients/${fixture.clientId}`;
        const client = (await (await admin(path)).json()) as {
          attributes: Record<string, string>;
        };
        const result = await admin(path, {
          method: "PUT",
          body: JSON.stringify({
            ...client,
            attributes: {
              ...client.attributes,
              "backchannel.logout.url": enabled
                ? fixture.origin + "/auth/backchannel-logout"
                : "",
            },
          }),
        });
        if (result.status !== 204)
          throw new Error("Owned fixture backchannel configuration failed");
      },
      admin,
      logs,
      secretValues,
      logoutTokens,
      incoming,
      closed,
      hostRequest: async (origin: string, host: string, forwarded: string) =>
        await new Promise<number>((resolve, reject) => {
          const request = httpsRequest(
            new URL("/api/me", origin),
            {
              ca,
              servername: new URL(origin).hostname,
              headers: { Host: host, "X-Forwarded-Host": forwarded },
              lookup: (_host, opts, cb) => {
                const address = required("JGW_TEST_BIND_IP");
                if (opts.all) cb(null, [{ address, family: 4 }]);
                else cb(null, address, 4);
              },
            },
            (response) => {
              response.resume();
              resolve(response.statusCode!);
            },
          );
          request.once("error", reject);
          request.end();
        }),
      members,
      get refreshCount() {
        return refreshCount;
      },
      get serviceTokenCount() {
        return serviceTokenCount;
      },
      set failServiceToken(value: boolean) {
        failServiceToken = value;
      },
      holdNextServiceToken: () => {
        let arrived!: () => void, release!: () => void;
        const arrival = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        serviceTokenGate = { arrived, ready };
        return { arrival, release };
      },
      subscribe: async (index: number, service: string, method = "PUT") => {
        const fixture = fixtures[index]!;
        return await fetch(
          `https://jauth.jgw.test:54231/auth/tenants/${fixture.tenant}/services/${service}`,
          {
            method,
            headers: {
              Authorization: "Bearer " + operator,
              "X-JGW-Service-Key": required("JAUTH_CONSOLE_SERVICE_KEY"),
            },
          },
        );
      },
      subscriptionSnapshot: async (
        index: number,
        signal: AbortSignal,
        transport: typeof globalThis.fetch = fetch,
      ) => {
        const reader = new AuthSubscriptionReader({
          origin: "https://jauth.jgw.test:54231",
          credentials: async () => ({
            bearer: operator,
            serviceKey: required("JAUTH_CONSOLE_SERVICE_KEY"),
          }),
          fetch: transport,
        });
        return reader.read(fixtures[index]!.tenant, signal);
      },
      set failRefresh(value: boolean) {
        failRefresh = value;
      },
      startCompiled: async () => {
        const fixture = fixtures[0]!;
        const envfile =
          required("JGW_TEST_ENV") + "." + fixture.tenant + ".server.env";
        const values = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) =>
                !/^(JAUTH_|KC_)/.test(name) ||
                [
                  "JAUTH_PUBLIC_URL",
                  "KC_PUBLIC_URL",
                  "JAUTH_TLS_CERTIFICATE",
                ].includes(name),
            ),
          ),
          JGW_TENANT: fixture.tenant,
          JGW_PUBLIC_ORIGIN: fixture.origin,
          JGW_CLIENT_SECRET: fixture.secrets.clientSecret,
          JGW_SERVICE_KEY: fixture.secrets.serviceKey,
          JAUTH_PUBLIC_URL: fixture.memberAuth.origin,
          ...(options.serviceEndpoints?.["j-messenger"]
            ? {
                JGW_SERVICE_MESSENGER_URL:
                  options.serviceEndpoints["j-messenger"],
              }
            : {}),
          ...(options.serviceEndpoints?.["j-approval"]
            ? {
                JGW_SERVICE_APPROVAL_URL:
                  options.serviceEndpoints["j-approval"],
              }
            : {}),
        };
        await writeFile(
          envfile,
          Object.entries(values)
            .filter(
              ([key, value]) =>
                value !== undefined &&
                /^(JGW_|JAUTH_|KC_|NODE_EXTRA)/.test(key),
            )
            .map(([key, value]) => `${key}=${value}\n`)
            .join(""),
          { mode: 0o600 },
        );
        return await start(
          fileURLToPath(new URL("../../", import.meta.url)),
          [
            `--env-file=${envfile}`,
            "--import",
            preload,
            "apps/server/dist/main.js",
          ],
          fixture.origin + "/health/ready",
          values,
        );
      },
      stop,
      close: async () => {
        for (const fixture of fixtures) await fixture.app.close();
        for (const tenant of owned) {
          await admin("/admin/realms/tenant-" + tenant, { method: "DELETE" });
          await authPool.query("DELETE FROM tenants WHERE tenant_id=$1", [
            tenant,
          ]);
          await pool.query(
            "UPDATE organization_departments SET head_member_id=NULL WHERE tenant_id=$1",
            [tenant],
          );
          for (const table of [
            "sessions",
            "notification_reads",
            "notifications",
            "notification_services",
            "notification_projection_state",
            "login_flows",
            "logout_events",
            "board_posts",
            "organization_members",
            "organization_departments",
            "organization_positions",
            "organization_state",
            "member_session_ends",
          ])
            await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
              tenant,
            ]);
        }
        for (const child of children) await stop(child);
        await Promise.all([
          pool.end(),
          authPool.end(),
          ...agents.map((agent) => agent.close()),
        ]);
      },
    };
  } catch (error) {
    for (const child of children) await stop(child).catch(() => undefined);
    await Promise.allSettled([
      pool.end(),
      authPool.end(),
      ...agents.map((agent) => agent.close()),
    ]);
    throw error;
  }
}
export type Runtime = Awaited<ReturnType<typeof integrationRuntime>>;
export class Browser {
  readonly cookies = new Map<string, Map<string, string>>();
  constructor(
    readonly fetch: typeof globalThis.fetch,
    readonly origin: string,
  ) {}
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.origin),
      jar = this.cookies.get(url.origin) ?? new Map<string, string>();
    const response = await this.fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        Cookie: [...jar].map(([key, value]) => key + "=" + value).join("; "),
        ...init.headers,
      },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    this.cookies.set(url.origin, jar);
    return response;
  }
  async begin() {
    const response = await this.request("/auth/login");
    if (response.status !== 302)
      throw new Error("BFF login start failed " + response.status);
    return response.headers.get("location")!;
  }
  async code(authorization: string, password: string, username = "owner") {
    const form = await this.request(authorization);
    if (form.status === 302) {
      const callback = form.headers.get("location")!;
      if (new URL(callback).origin !== this.origin)
        throw new Error("Unexpected SSO callback.");
      return callback;
    }
    const html = await form.text();
    const action = html
      .match(/<form\b[^>]*id="kc-form-login"[^>]*>/)?.[0]
      ?.match(/action="([^"]+)"/)?.[1]
      ?.replaceAll("&amp;", "&");
    if (
      form.status !== 200 ||
      !action ||
      new URL(action).origin !== new URL(authorization).origin
    )
      throw new Error("Actual Keycloak login form failed.");
    const result = await this.request(action, {
      method: "POST",
      body: new URLSearchParams({ username, password, credentialId: "" }),
    });
    if (result.status !== 302)
      throw new Error("Keycloak credential login failed " + result.status);
    return result.headers.get("location")!;
  }
  async login(password: string, username = "owner") {
    const callback = await this.code(await this.begin(), password, username);
    const response = await this.request(callback);
    if (response.status !== 302)
      throw new Error(
        "BFF callback failed " +
          response.status +
          " " +
          (await response.text()),
      );
    return response;
  }
  async me(): Promise<MeResponse> {
    const response = await this.request("/api/me");
    if (response.status !== 200)
      throw new Error("me failed " + response.status);
    return (await response.json()) as MeResponse;
  }
  async change(path: string, body: unknown, method = "POST") {
    const me = await this.me();
    return this.request(path, {
      method,
      headers: {
        Origin: this.origin,
        "x-csrf-token": me.csrfToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}
