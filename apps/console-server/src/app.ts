import Fastify, { LogController } from "fastify";
import type {
  FastifyServerOptions,
  FastifyError,
  FastifyRequest,
} from "fastify";
import type { ServerOptions as HttpsOptions } from "node:https";
import type { Pool } from "pg";
import {
  OidcClient,
  SessionStore,
  ApiError,
  unavailable,
  cookieValue,
  cookie,
  checkCsrf,
} from "@j-groupware/bff-auth";
import type { OidcConfig, SessionRow } from "@j-groupware/bff-auth";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { ConsoleCustomers } from "./customers.js";
import { registerCustomerRoutes } from "./customer-routes.js";
import type { AuthControl } from "./auth-control.js";
export const CONSOLE_COOKIES = {
  session: "__Host-jgw-console-session",
  flow: "__Host-jgw-console-login",
} as const;
const ROUTES: Record<string, "public" | "session" | "write" | "agent"> = {
  "GET /console/api/customers": "session",
  "GET /console/api/customers/:tenant": "session",
  "POST /console/api/customers": "write",
  "PUT /console/api/customers/:tenant/services/:service": "write",
  "POST /console/api/customers/:tenant/reconcile": "write",
  "POST /console/api/customers/:tenant/agent-key": "write",
  "POST /console/api/customers/:tenant/bootstrap/reset": "write",
  "DELETE /console/api/customers/:tenant/agent-key": "write",
  "GET /console/api/agent/desired-state": "agent",
  "POST /console/api/agent/status": "agent",
  "GET /": "public",
  "GET /health/live": "public",
  "GET /health/ready": "public",
  "GET /auth/login": "public",
  "GET /auth/callback": "public",
  "POST /auth/backchannel-logout": "public",
  "GET /console/api/me": "session",
  "POST /auth/logout": "session",
};
export function createConsoleApp(options: {
  pool: Pool;
  config: OidcConfig;
  oidc?: OidcClient;
  https?: HttpsOptions;
  logger?: FastifyServerOptions["logger"];
  authControl?: AuthControl;
}) {
  if (options.config.tenant !== "operator")
    throw new Error("Console requires operator realm.");
  const app = Fastify({
    exposeHeadRoutes: false,
    trustProxy: false,
    bodyLimit: 32768,
    ajv: { customOptions: { removeAdditional: false } },
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    ...(options.https ? { https: options.https } : {}),
  });
  const identities = new WeakMap<FastifyRequest, SessionRow>();
  const oidc = options.oidc ?? new OidcClient(options.config),
    sessions = new SessionStore(options.pool, "operator", oidc);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      const p = new URLSearchParams(String(body));
      if (
        p.getAll("logout_token").length !== 1 ||
        [...p.keys()].some((k) => k !== "logout_token")
      )
        return done(
          new ApiError(400, "invalid_input", "Invalid logout request."),
        );
      done(null, { logout_token: p.get("logout_token") });
    },
  );
  app.addHook("onRoute", (route) => {
    const access = ROUTES[`${route.method} ${route.url}`];
    if (!access) throw new Error("Console route access must be declared.");
    if (access === "session" || access === "write")
      route.preHandler = async (request) => {
        const identity = await sessions.authenticate(
          cookieValue(request.headers.cookie, CONSOLE_COOKIES.session),
        );
        identities.set(request, identity);
        if (!identity.roles.includes("customer:read"))
          throw new ApiError(403, "forbidden", "Operator role required.");
        if (access === "write" && !identity.roles.includes("customer:write"))
          throw new ApiError(403, "forbidden", "Operator write role required.");
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
          checkCsrf(
            request.headers,
            options.config.origin,
            identity.csrf_token,
          );
      };
  });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    if (
      request.headers.host !== new URL(options.config.origin).host ||
      (request.headers.authorization &&
        ROUTES[`${request.method} ${request.routeOptions.url}`] !== "agent") ||
      request.headers.upgrade
    )
      throw new ApiError(400, "invalid_input", "Invalid console request.");
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const safe =
      error instanceof ApiError
        ? error
        : "validation" in error ||
            [400, 413, 415].includes(Number(error.statusCode))
          ? new ApiError(
              Number(error.statusCode ?? 400),
              "invalid_input",
              "Invalid request.",
            )
          : unavailable();
    if (safe.status === 401)
      reply.header("Set-Cookie", cookie(CONSOLE_COOKIES.session, "", 0));
    if (safe.status === 503)
      request.log.warn(
        { code: safe.code, requestId: request.id },
        "Console unavailable",
      );
    reply
      .code(safe.status)
      .send({ code: safe.code, message: safe.message, requestId: request.id });
  });
  app.get("/", async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      )
      .send(
        '<!doctype html><html lang="ko"><meta charset="utf-8"><title>운영 콘솔</title><a href="/auth/login">로그인</a></html>',
      ),
  );
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await options.pool.query("SELECT checksum FROM schema_migrations LIMIT 1");
    return { status: "ok" };
  });
  app.get(
    "/auth/login",
    {
      schema: { querystring: { type: "object", additionalProperties: false } },
    },
    async (request, reply) => {
      const flow = await sessions.startLogin(
        cookieValue(request.headers.cookie, CONSOLE_COOKIES.flow),
      );
      reply.header(
        "Set-Cookie",
        cookie(
          CONSOLE_COOKIES.flow,
          flow.flow,
          SESSION_POLICY.loginLifetimeSeconds,
        ),
      );
      return reply.redirect(flow.url);
    },
  );
  app.get<{
    Querystring: {
      state: string;
      code?: string;
      iss?: string;
      error?: string;
      error_description?: string;
      session_state?: string;
    };
  }>(
    "/auth/callback",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["state"],
          properties: {
            state: { type: "string", maxLength: 128 },
            code: { type: "string", maxLength: 2048 },
            iss: { type: "string", maxLength: 1024 },
            error: { type: "string", maxLength: 128 },
            error_description: { type: "string", maxLength: 2048 },
            session_state: { type: "string", maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const flow = await sessions.consumeLogin(
        cookieValue(request.headers.cookie, CONSOLE_COOKIES.flow),
        request.query.state,
      );
      reply.header("Set-Cookie", cookie(CONSOLE_COOKIES.flow, "", 0));
      if (
        request.query.error ||
        !request.query.code ||
        (request.query.iss !== undefined && request.query.iss !== oidc.issuer)
      )
        throw new ApiError(400, "invalid_input", "Login rejected.");
      const result = await oidc.exchange(
        request.query.code,
        flow.verifier,
        flow.nonce,
      );
      if (
        !result.identity.roles.includes("customer:read") ||
        result.identity.username.startsWith("service-account-")
      )
        throw new ApiError(403, "forbidden", "Operator role required.");
      const session = await sessions.create(
        result.tokens,
        result.identity,
        flow.nonce,
        flow.started_at,
        cookieValue(request.headers.cookie, CONSOLE_COOKIES.session),
      );
      reply.header("Set-Cookie", [
        cookie(CONSOLE_COOKIES.flow, "", 0),
        cookie(CONSOLE_COOKIES.session, session, SESSION_POLICY.maxSeconds),
      ]);
      return reply.redirect(options.config.origin + "/");
    },
  );
  app.get("/console/api/me", async (request) => {
    const row = identities.get(request)!;
    return {
      tenant: "operator",
      subject: row.subject,
      username: row.username,
      roles: row.roles.filter((x) =>
        ["customer:read", "customer:write"].includes(x),
      ),
      csrfToken: row.csrf_token,
    };
  });
  app.post(
    "/auth/logout",
    { schema: { body: { type: "object", additionalProperties: false } } },
    async (request, reply) => {
      await sessions.end(
        cookieValue(request.headers.cookie, CONSOLE_COOKIES.session)!,
      );
      reply.header("Set-Cookie", cookie(CONSOLE_COOKIES.session, "", 0));
      return reply.code(303).redirect(oidc.logoutUrl());
    },
  );
  app.post<{ Body: { logout_token: string } }>(
    "/auth/backchannel-logout",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["logout_token"],
          properties: {
            logout_token: { type: "string", minLength: 1, maxLength: 16384 },
          },
        },
      },
    },
    async (request, reply) => {
      await sessions.backchannel(request.body.logout_token);
      return reply.code(200).send();
    },
  );
  registerCustomerRoutes(
    app,
    new ConsoleCustomers(
      options.pool,
      options.config.origin,
      options.authControl,
    ),
    (r) => identities.get(r)!,
  );
  return app;
}
