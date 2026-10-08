import Fastify, { LogController } from "fastify";
import type {
  FastifyRequest,
  FastifyServerOptions,
  FastifyError,
} from "fastify";
import type { ServerOptions as HttpsOptions } from "node:https";
import type { Pool } from "pg";
import { ROUTES, visibleMenus } from "@j-groupware/permissions";
import type { Access } from "@j-groupware/permissions";
import { SESSION_POLICY } from "@j-groupware/contracts";
import type { CreateBoardPost } from "@j-groupware/contracts";
import type { ServerConfig } from "./config.js";
import { OidcClient } from "./oidc.js";
import { SessionStore } from "./db/sessions.js";
import type { SessionRow } from "./db/sessions.js";
import { BoardStore } from "./db/board.js";
import { ApiError, unavailable } from "./errors.js";
import { cookieValue, cookie, checkCsrf } from "./security.js";
import { ServiceTokens } from "./service-tokens.js";
import { ServiceClient } from "./services.js";
import type { ServiceEndpoints } from "./services.js";
import { Members } from "./members.js";
import type { MemberAuth } from "./members.js";
import { registerMemberRoutes } from "./member-routes.js";
import { OrganizationStore } from "./db/organization.js";
import { registerOrganizationRoutes } from "./organization-routes.js";
import websocket from "@fastify/websocket";
import { RealtimeSessions } from "./realtime-sessions.js";
import { registerRealtimeRoutes } from "./realtime-routes.js";
import { registerApprovalRoutes } from "./approval-routes.js";
import { registerMessengerRoutes } from "./messenger-routes.js";
import { registerMailRoutes } from "./mail-routes.js";
import { registerTalkRoutes } from "./talk-routes.js";
import { registerCustomerAuthRoutes } from "./customer-auth-routes.js";
import { NotificationStore } from "./db/notifications.js";
import { registerNotificationRoutes } from "./notification-routes.js";

export function createApp(options: {
  pool: Pool;
  config: Pick<
    ServerConfig,
    "tenant" | "origin" | "keycloakOrigin" | "clientSecret"
  >;
  oidc?: OidcClient;
  https?: HttpsOptions;
  logger?: FastifyServerOptions["logger"];
  onSessionEnd?: (hashes: readonly string[]) => void;
  serviceEndpoints?: ServiceEndpoints;
  serviceFetch?: typeof globalThis.fetch;
  memberAuth?: MemberAuth;
}) {
  const app = Fastify({
    exposeHeadRoutes: false,
    trustProxy: false,
    bodyLimit: 65536,
    ajv: { customOptions: { removeAdditional: false } },
    ...(options.https ? { https: options.https } : {}),
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const oidc = options.oidc ?? new OidcClient(options.config);
  const realtime = new RealtimeSessions(options.pool, options.config.tenant);
  const notifications = new NotificationStore(
    options.pool,
    options.config.tenant,
  );
  const sessions = new SessionStore(
    options.pool,
    options.config.tenant,
    oidc,
    (hashes) => {
      realtime.end(hashes);
      options.onSessionEnd?.(hashes);
    },
  );
  const board = new BoardStore(options.pool, options.config.tenant);
  const identities = new WeakMap<FastifyRequest, SessionRow>();
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      const parameters = new URLSearchParams(String(body));
      if (parameters.getAll("logout_token").length !== 1) {
        done(new ApiError(400, "invalid_input", "Invalid logout request."));
        return;
      }
      done(null, { logout_token: parameters.get("logout_token") });
    },
  );
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    if (
      request.headers.host?.toLowerCase() !==
      new URL(options.config.origin).host
    )
      throw new ApiError(400, "invalid_input", "Unregistered host.");
    if (
      request.headers.upgrade?.toLowerCase() === "websocket" &&
      request.routeOptions.url !== "/api/messenger/ws"
    )
      throw new ApiError(400, "invalid_input", "Unregistered websocket path.");
  });
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const access = (ROUTES as Record<string, Access>)[
        `${method} ${route.url}`
      ];
      if (!access)
        throw new Error("Route must declare access in the permission table.");
      if (access.kind === "session") {
        const guard = async (request: FastifyRequest) => {
          const identity = await sessions.authenticate(
            cookieValue(request.headers.cookie, SESSION_POLICY.cookie),
          );
          identities.set(request, identity);
          if (access.role && !identity.roles.includes(access.role))
            throw new ApiError(403, "forbidden", "Permission denied.");
          if (!["GET", "HEAD", "OPTIONS"].includes(method))
            checkCsrf(
              request.headers,
              options.config.origin,
              identity.csrf_token,
            );
        };
        const prior = route.preHandler
          ? Array.isArray(route.preHandler)
            ? route.preHandler
            : [route.preHandler]
          : [];
        route.preHandler = [guard, ...prior];
      }
    }
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const safe =
      error instanceof ApiError
        ? error
        : "validation" in error ||
            ("statusCode" in error &&
              [400, 413, 415].includes(Number(error.statusCode)))
          ? new ApiError(
              Number(error.statusCode ?? 400),
              "invalid_input",
              "Invalid request.",
            )
          : unavailable();
    if (
      safe.status === 401 &&
      (ROUTES as Record<string, Access>)[
        `${request.method} ${request.routeOptions.url}`
      ]?.kind === "session"
    )
      reply.header("Set-Cookie", cookie(SESSION_POLICY.cookie, "", 0));
    // Only a safe code is logged. URLs, headers, bodies and exception messages may contain secrets.
    if (safe.status === 503)
      request.log.warn(
        { code: safe.code, requestId: request.id },
        "Request unavailable",
      );
    reply
      .code(safe.status)
      .send({ code: safe.code, message: safe.message, requestId: request.id });
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/", async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      )
      .send(
        '<!doctype html><html lang="ko"><meta charset="utf-8"><title>j-groupware</title><h1>j-groupware</h1><a href="/auth/login">로그인</a></html>',
      ),
  );
  app.get("/health/ready", async () => {
    await options.pool.query("SELECT 1");
    await realtime.ready();
    return { status: "ok" };
  });
  app.get(
    "/auth/login",
    {
      schema: { querystring: { type: "object", additionalProperties: false } },
    },
    async (request, reply) => {
      const start = await sessions.startLogin(
        cookieValue(request.headers.cookie, SESSION_POLICY.flowCookie),
      );
      reply.header(
        "Set-Cookie",
        cookie(
          SESSION_POLICY.flowCookie,
          start.flow,
          SESSION_POLICY.loginLifetimeSeconds,
        ),
      );
      return reply.redirect(start.url);
    },
  );
  app.get<{
    Querystring: {
      state: string;
      code?: string;
      error?: string;
      error_description?: string;
      session_state?: string;
      iss?: string;
    };
  }>(
    "/auth/callback",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["state"],
          additionalProperties: false,
          properties: {
            state: { type: "string", maxLength: 128 },
            code: { type: "string", maxLength: 2048 },
            error: { type: "string", maxLength: 128 },
            error_description: { type: "string", maxLength: 2048 },
            session_state: { type: "string", maxLength: 256 },
            iss: { type: "string", maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const state = await sessions.consumeLogin(
        cookieValue(request.headers.cookie, SESSION_POLICY.flowCookie),
        request.query.state,
      );
      reply.header("Set-Cookie", cookie(SESSION_POLICY.flowCookie, "", 0));
      if (
        request.query.error ||
        !request.query.code ||
        (request.query.iss !== undefined && request.query.iss !== oidc.issuer)
      )
        throw new ApiError(
          400,
          "invalid_input",
          "Login was cancelled or rejected.",
        );
      const result = await oidc.exchange(
        request.query.code,
        state.verifier,
        state.nonce,
      );
      const session = await sessions.create(
        result.tokens,
        result.identity,
        state.nonce,
        state.started_at,
        cookieValue(request.headers.cookie, SESSION_POLICY.cookie),
      );
      reply.header("Set-Cookie", [
        cookie(SESSION_POLICY.flowCookie, "", 0),
        cookie(SESSION_POLICY.cookie, session, SESSION_POLICY.maxSeconds),
      ]);
      return reply.redirect(options.config.origin + "/");
    },
  );
  app.get("/api/me", async (request) => {
    const row = identities.get(request)!;
    return {
      tenant: row.tenant_id,
      subject: row.subject,
      username: row.username,
      roles: row.roles,
      menus: visibleMenus(row.roles),
      csrfToken: row.csrf_token,
    };
  });
  app.post("/auth/logout", async (request, reply) => {
    await sessions.end(
      cookieValue(request.headers.cookie, SESSION_POLICY.cookie)!,
    );
    reply.header("Set-Cookie", cookie(SESSION_POLICY.cookie, "", 0));
    return reply.code(303).redirect(oidc.logoutUrl());
  });
  app.post<{ Body: { logout_token: string } }>(
    "/auth/backchannel-logout",
    {
      schema: {
        body: {
          type: "object",
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
  app.get<{ Querystring: { cursor?: string } }>(
    "/api/board/posts",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { cursor: { type: "string", maxLength: 512 } },
        },
      },
    },
    async (request) => await board.list(request.query.cursor),
  );
  app.get<{ Params: { id: string } }>(
    "/api/board/posts/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: {
              type: "string",
              pattern: "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$",
            },
          },
        },
      },
    },
    async (request) => await board.read(request.params.id),
  );
  app.post<{ Body: CreateBoardPost }>(
    "/api/board/posts",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "body"],
          additionalProperties: false,
          properties: {
            title: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              pattern: "\\S",
            },
            body: {
              type: "string",
              minLength: 1,
              maxLength: 20000,
              pattern: "\\S",
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await board.create(identities.get(request)!.subject, request.body),
        ),
  );
  const members = new Members(
    options.pool,
    options.config.tenant,
    sessions,
    options.memberAuth,
  );
  registerMemberRoutes(app, members, (request) => identities.get(request)!);
  registerNotificationRoutes(app, notifications, (request) =>
    identities.get(request)!,
  );
  registerOrganizationRoutes(
    app,
    new OrganizationStore(options.pool, options.config.tenant),
    members,
    (request) => identities.get(request)!,
  );
  const serviceTokens = new ServiceTokens(sessions, oidc);
  const services = new ServiceClient(
    serviceTokens,
    options.serviceEndpoints ?? {},
    options.serviceFetch,
  );
  registerApprovalRoutes(
    app,
    services,
    new OrganizationStore(options.pool, options.config.tenant),
    (request) => identities.get(request)!,
  );
  registerMessengerRoutes(app, services, (request) => identities.get(request)!);
  registerMailRoutes(app, services);
  registerTalkRoutes(app, services);
  registerCustomerAuthRoutes(app, services);
  app.register(websocket, {
    options: { maxPayload: 1048576, perMessageDeflate: false },
    errorHandler: (_error, socket) => socket.terminate(),
  });
  app.register(async (scope) =>
    registerRealtimeRoutes(
      scope,
      realtime,
      serviceTokens,
      options.serviceEndpoints ?? {},
      options.config.origin,
      notifications,
    ),
  );
  app.addHook("onReady", () => realtime.ready());
  let purging = false;
  const purge = () => {
    if (purging) return;
    purging = true;
    void notifications
      .purge()
      .catch(() => undefined)
      .finally(() => {
        purging = false;
      });
  };
  let purgeTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    await notifications.purge();
    purgeTimer = setInterval(purge, 60000);
    purgeTimer.unref();
  });
  app.addHook("preClose", async () => {
    if (purgeTimer) clearInterval(purgeTimer);
  });
  app.addHook("preClose", () => realtime.stop());
  return Object.assign(app, {
    realtime,
    serviceTokens,
    services,
  });
}
