import { randomUUID } from "node:crypto";
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import { SESSION_POLICY } from "@j-groupware/contracts";
import type { SessionRow } from "./db/sessions.js";
import type { ServiceClient } from "./services.js";
import { ApiError, unavailable } from "./errors.js";
import { cookie, cookieValue } from "./security.js";

const base = "/api/messenger/api/v1";
const empty = { type: "object", additionalProperties: false };
const decimalSchema = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
const uuidSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$",
};
const cursorSchema = { type: "string", minLength: 1, maxLength: 4096 };
const limitSchema = { type: "integer", minimum: 1, maximum: 100 };
const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: decimalSchema },
};
const query = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", additionalProperties: false, properties, required });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw unavailable();
  return value;
};
const decimal = (value: unknown, zero = false): string => {
  const result = text(value, 19);
  if (
    !(zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(result) ||
    BigInt(result) > 9223372036854775807n
  )
    throw unavailable();
  return result;
};
const uuid = (value: unknown): string => {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result))
    throw unavailable();
  return result;
};
const date = (value: unknown): string => {
  const result = text(value, 32);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw unavailable();
  return result;
};
const array = <T>(value: unknown, map: (value: unknown) => T): T[] => {
  if (!Array.isArray(value)) throw unavailable();
  return value.map(map);
};
const conversation = (value: unknown) => {
  const row = object(value);
  if (!["direct", "group"].includes(String(row.kind))) throw unavailable();
  return {
    id: decimal(row.id),
    kind: row.kind,
    title: row.title === null ? null : text(row.title, 200),
    memberIds: array(row.memberIds, (v) => decimal(v)),
    createdAt: date(row.createdAt),
    lastMessageAt: row.lastMessageAt === null ? null : date(row.lastMessageAt),
  };
};
const message = (value: unknown) => {
  const row = object(value);
  if (
    typeof row.contentExpired !== "boolean" ||
    row.contentExpired !== (row.text === null)
  )
    throw unavailable();
  return {
    id: decimal(row.id),
    conversationId: decimal(row.conversationId),
    senderId: decimal(row.senderId),
    clientMessageId: uuid(row.clientMessageId),
    text: row.text === null ? null : text(row.text, 4000),
    contentExpired: row.contentExpired,
    fileIds: array(row.fileIds, uuid),
    createdAt: date(row.createdAt),
  };
};
const receipt = (value: unknown) => {
  const row = object(value);
  return {
    conversationId: decimal(row.conversationId),
    userId: decimal(row.userId),
    lastReadMessageId:
      row.lastReadMessageId === null ? null : decimal(row.lastReadMessageId),
  };
};
const event = (value: unknown) => {
  const row = object(value);
  let data: unknown;
  switch (row.type) {
    case "message.created.v1":
      data = message(row.data);
      break;
    case "conversation.created.v1":
      data = conversation(row.data);
      break;
    case "receipt.updated.v1":
      data = { receipts: array(object(row.data).receipts, receipt) };
      break;
    case "message.deleted.v1": {
      const source = object(row.data);
      if (source.contentExpired !== true) throw unavailable();
      data = {
        messageId: decimal(source.messageId),
        contentExpired: true,
        fileIds: array(source.fileIds, uuid),
      };
      break;
    }
    default:
      throw unavailable();
  }
  return {
    eventId: decimal(row.eventId),
    type: row.type,
    occurredAt: date(row.occurredAt),
    ...(row.conversationId === undefined
      ? {}
      : { conversationId: decimal(row.conversationId) }),
    data,
  };
};
const page = (value: unknown, map: (value: unknown) => unknown) => {
  const row = object(value),
    info = object(row.page);
  if (!Array.isArray(row.data) || row.data.length > 100) throw unavailable();
  return {
    data: row.data.map(map),
    page: {
      nextCursor: info.nextCursor === null ? null : text(info.nextCursor, 4096),
    },
    snapshotCursor: text(row.snapshotCursor, 4096),
    snapshotPosition: decimal(row.snapshotPosition, true),
  };
};
async function json(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    throw unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1048576) throw unavailable();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => undefined);
    throw unavailable();
  } finally {
    reader.releaseLock();
  }
}
async function decode(
  response: Response,
  statuses: readonly number[],
  project: (value: unknown) => unknown,
): Promise<{ status: number; body: unknown }> {
  if (!statuses.includes(response.status)) {
    const codes: Record<number, string> = {
      400: "bad_request",
      401: "unauthorized",
      403: "forbidden",
      404: "not_found",
      409: "conflict",
      413: "too_large",
      429: "rate_limited",
    };
    if (response.status === 410) {
      const error = object(object(await json(response)).error);
      if (
        !["sync_reset_required", "message_expired"].includes(String(error.code))
      )
        throw unavailable();
      throw new ApiError(
        410,
        String(error.code),
        "메신저 요청을 다시 확인하세요.",
      );
    }
    await response.body?.cancel();
    if (codes[response.status])
      throw new ApiError(
        response.status,
        codes[response.status]!,
        "메신저 요청을 처리할 수 없습니다.",
      );
    throw unavailable();
  }
  return { status: response.status, body: project(await json(response)) };
}
export function registerMessengerRoutes(
  app: FastifyInstance,
  services: ServiceClient,
  identity: (request: FastifyRequest) => SessionRow,
) {
  app.register(async (scope) => {
    scope.addHook("onRequest", async (request, reply) => {
      request.id = randomUUID();
      reply.header("X-Request-Id", request.id);
    });
    // Native client wire errors; parent authentication/role/CSRF guards still apply.
    scope.setErrorHandler<FastifyError>((error, request, reply) => {
      const safe =
        error instanceof ApiError
          ? error
          : "validation" in error ||
              [400, 413, 415].includes(Number(error.statusCode))
            ? new ApiError(
                Number(error.statusCode ?? 400),
                "bad_request",
                "요청이 올바르지 않습니다.",
              )
            : unavailable();
      const code =
        safe.code === "unauthenticated"
          ? "unauthorized"
          : safe.code === "invalid_input"
            ? "bad_request"
            : safe.code;
      if (safe.status === 401)
        reply.header("Set-Cookie", cookie(SESSION_POLICY.cookie, "", 0));
      if (safe.status === 503)
        request.log.warn(
          { code, requestId: request.id },
          "Messenger unavailable",
        );
      reply.code(safe.status).send({
        error: { code, message: safe.message, requestId: request.id },
      });
    });
    const call = async (
      request: FastifyRequest,
      path: string,
      project: (value: unknown) => unknown,
      method: "GET" | "POST" | "PUT" = "GET",
      body?: unknown,
      statuses: readonly number[] = [200],
    ) => {
      if (request.raw.aborted) throw unavailable();
      const abort = new AbortController();
      const aborted = () => abort.abort();
      request.raw.once("aborted", aborted);
      try {
        return await decode(
          await services.request(
            cookieValue(request.headers.cookie, SESSION_POLICY.cookie),
            "j-messenger",
            path,
            {
              method,
              ...(body === undefined ? {} : { body }),
              signal: abort.signal,
            },
          ),
          statuses,
          project,
        );
      } finally {
        request.raw.off("aborted", aborted);
      }
    };
    const inputId = (value: string) => {
      if (BigInt(value) > 9223372036854775807n)
        throw new ApiError(400, "bad_request", "식별자가 올바르지 않습니다.");
      return value;
    };
    const suffix = (values: Record<string, string | number | undefined>) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(values))
        if (value !== undefined) query.set(key, String(value));
      return query.size ? "?" + query : "";
    };
    scope.get(
      base + "/me",
      { schema: { querystring: empty } },
      async (request) =>
        (
          await call(request, "/api/v1/me", (value) => {
            const row = object(object(value).data),
              features = object(row.enabledFeatures);
            if (
              row.serverId !== identity(request).tenant_id ||
              typeof features.receipts !== "boolean"
            )
              throw unavailable();
            return {
              data: {
                id: decimal(row.id),
                serverId: row.serverId,
                displayName: text(row.displayName, 128),
                enabledFeatures: {
                  files: false,
                  receipts: features.receipts,
                  retention: false,
                  notifications: false,
                  nativeSessions: false,
                  developmentAuth: false,
                  adminRetention: false,
                },
              },
            };
          })
        ).body,
    );
    scope.get<{ Querystring: { cursor?: string; limit?: number } }>(
      base + "/users",
      {
        schema: {
          querystring: query({ cursor: cursorSchema, limit: limitSchema }),
        },
      },
      async (request) =>
        (
          await call(
            request,
            "/api/v1/users" + suffix(request.query),
            (value) =>
              page(value, (item) => {
                const user = object(item);
                return {
                  id: decimal(user.id),
                  displayName: text(user.displayName, 128),
                };
              }),
          )
        ).body,
    );
    scope.get<{ Querystring: { cursor?: string; limit?: number } }>(
      base + "/conversations",
      {
        schema: {
          querystring: query({ cursor: cursorSchema, limit: limitSchema }),
        },
      },
      async (request) =>
        (
          await call(
            request,
            "/api/v1/conversations" + suffix(request.query),
            (value) => page(value, conversation),
          )
        ).body,
    );
    scope.post<{
      Body: {
        kind: "direct" | "group";
        memberIds: string[];
        title?: string;
        clientRequestId: string;
      };
    }>(
      base + "/conversations",
      {
        schema: {
          querystring: empty,
          body: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "memberIds", "clientRequestId"],
            properties: {
              kind: { enum: ["direct", "group"] },
              memberIds: {
                type: "array",
                minItems: 1,
                uniqueItems: true,
                items: decimalSchema,
              },
              title: { type: "string", maxLength: 200 },
              clientRequestId: uuidSchema,
            },
          },
        },
      },
      async (request, reply) => {
        request.body.memberIds.forEach(inputId);
        const result = await call(
          request,
          "/api/v1/conversations",
          (value) => ({ data: conversation(object(value).data) }),
          "POST",
          request.body,
          [200, 201],
        );
        return reply.code(result.status).send(result.body);
      },
    );
    scope.get<{
      Params: { id: string };
      Querystring: { before?: string; after?: string; limit?: number };
    }>(
      base + "/conversations/:id/messages",
      {
        schema: {
          params,
          querystring: query({
            before: decimalSchema,
            after: decimalSchema,
            limit: limitSchema,
          }),
        },
      },
      async (request) => {
        if (request.query.before) inputId(request.query.before);
        if (request.query.after) inputId(request.query.after);
        return (
          await call(
            request,
            `/api/v1/conversations/${inputId(request.params.id)}/messages` +
              suffix(request.query),
            (value) => page(value, message),
          )
        ).body;
      },
    );
    scope.post<{
      Params: { id: string };
      Body: { clientMessageId: string; text: string; fileIds?: string[] };
    }>(
      base + "/conversations/:id/messages",
      {
        schema: {
          params,
          querystring: empty,
          body: {
            type: "object",
            additionalProperties: false,
            required: ["clientMessageId", "text"],
            properties: {
              clientMessageId: uuidSchema,
              text: { type: "string", minLength: 1 },
              fileIds: { type: "array", maxItems: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const text = request.body.text.trim();
        if (
          !text ||
          text.length > 4000 ||
          Buffer.from(request.body.text, "utf8").toString("utf8") !==
            request.body.text
        )
          throw new ApiError(400, "bad_request", "메시지가 올바르지 않습니다.");
        const result = await call(
          request,
          `/api/v1/conversations/${inputId(request.params.id)}/messages`,
          (value) => ({ data: message(object(value).data) }),
          "POST",
          { ...request.body, text },
          [200, 201],
        );
        return reply.code(result.status).send(result.body);
      },
    );
    scope.get<{
      Querystring: { after: string; through?: string; limit?: number };
    }>(
      base + "/sync",
      {
        schema: {
          querystring: query(
            { after: cursorSchema, through: cursorSchema, limit: limitSchema },
            ["after"],
          ),
        },
      },
      async (request) =>
        (
          await call(
            request,
            "/api/v1/sync" + suffix(request.query),
            (value) => {
              const row = object(value);
              if (
                typeof row.hasMore !== "boolean" ||
                !Array.isArray(row.data) ||
                row.data.length > 100
              )
                throw unavailable();
              return {
                data: row.data.map(event),
                nextCursor: text(row.nextCursor, 4096),
                hasMore: row.hasMore,
                through: text(row.through, 4096),
                throughPosition: decimal(row.throughPosition, true),
                scannedThrough: decimal(row.scannedThrough, true),
              };
            },
          )
        ).body,
    );
    scope.put<{ Params: { id: string }; Body: { lastReadMessageId: string } }>(
      base + "/conversations/:id/read",
      {
        schema: {
          params,
          querystring: empty,
          body: {
            type: "object",
            additionalProperties: false,
            required: ["lastReadMessageId"],
            properties: { lastReadMessageId: decimalSchema },
          },
        },
      },
      async (request) =>
        (
          await call(
            request,
            `/api/v1/conversations/${inputId(request.params.id)}/read`,
            (value) => {
              const row = object(value);
              return {
                data: receipt(row.data),
                ...(row.snapshotCursor === undefined
                  ? {}
                  : { snapshotCursor: text(row.snapshotCursor, 4096) }),
              };
            },
            "PUT",
            { lastReadMessageId: inputId(request.body.lastReadMessageId) },
          )
        ).body,
    );
    scope.get<{ Params: { id: string } }>(
      base + "/conversations/:id/read",
      { schema: { params, querystring: empty } },
      async (request) =>
        (
          await call(
            request,
            `/api/v1/conversations/${inputId(request.params.id)}/read`,
            (value) => {
              const row = object(value);
              return {
                data: array(row.data, receipt),
                snapshotCursor: text(row.snapshotCursor, 4096),
                snapshotPosition: decimal(row.snapshotPosition, true),
              };
            },
          )
        ).body,
    );
  });
}
