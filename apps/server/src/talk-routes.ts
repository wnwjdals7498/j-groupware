import type { FastifyInstance, FastifyRequest } from "fastify";
import { SESSION_POLICY } from "@j-groupware/contracts";
import type { ServiceClient } from "./services.js";
import { cookieValue } from "./security.js";
import { ApiError, unavailable } from "./errors.js";
const uuidPattern = "^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$";
const uuid = { type: "string", pattern: uuidPattern };
const empty = { type: "object", additionalProperties: false };
const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: uuid },
};
const page = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    after: uuid,
  },
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Record<string, unknown>;
};
const string = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length > max) throw unavailable();
  return value;
};
const id = (value: unknown) => {
  const v = string(value, 36);
  if (!new RegExp(uuidPattern).test(v)) throw unavailable();
  return v;
};
const date = (value: unknown) => {
  const v = string(value, 32);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw unavailable();
  return v;
};
const status = (value: unknown) => {
  const v = string(value, 16);
  if (!["waiting", "in_progress", "closed"].includes(v)) throw unavailable();
  return v;
};
const nullableId = (value: unknown) => (value === null ? null : id(value));
function room(value: unknown, summary = false) {
  const row = record(value);
  const base = {
    id: id(row.id),
    status: status(row.status),
    assignedMemberId: nullableId(row.assignedMemberId),
  };
  if (summary) return { ...base, createdAt: date(row.createdAt) };
  const guestId = row.guestId === null ? null : string(row.guestId, 128);
  return { ...base, guestId };
}
function message(value: unknown) {
  const row = record(value),
    text = string(row.text, 4096);
  if (!text || Buffer.byteLength(text) > 4096) throw unavailable();
  return {
    id: id(row.id),
    text,
    senderMemberId: id(row.senderMemberId),
    createdAt: date(row.createdAt),
  };
}
function paged(
  value: unknown,
  limit: number,
  map: (value: unknown) => unknown,
) {
  const row = record(value);
  if (!Array.isArray(row.items) || row.items.length > limit)
    throw unavailable();
  return {
    items: row.items.map(map),
    next: row.next === null ? null : id(row.next),
  };
}
export async function decodeTalkResponse<T>(
  response: Response,
  expected: number,
  map: (value: unknown) => T,
): Promise<T> {
  if (response.status !== expected) {
    await response.body?.cancel();
    const known: Record<number, [string, string]> = {
      400: ["invalid_input", "Invalid talk request."],
      401: ["unauthenticated", "Talk authentication failed."],
      403: ["forbidden", "Permission denied."],
      404: ["not_found", "Room not found."],
      409: ["conflict", "Room changed or request id conflicts."],
      429: ["rate_limited", "Please try again later."],
    };
    const e = known[response.status];
    if (e) throw new ApiError(response.status, ...e);
    throw unavailable();
  }
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
    return map(JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    await reader.cancel().catch(() => undefined);
    throw unavailable();
  } finally {
    reader.releaseLock();
  }
}
export function registerTalkRoutes(
  app: FastifyInstance,
  services: Pick<ServiceClient, "request">,
) {
  const session = (r: FastifyRequest) =>
    cookieValue(r.headers.cookie, SESSION_POLICY.cookie);
  const call = (
    r: FastifyRequest,
    path: string,
    body?: unknown,
    method: "GET" | "POST" | "DELETE" = "GET",
  ) =>
    services.request(session(r), "j-talk", path, {
      method,
      ...(body === undefined ? {} : { body }),
    });
  app.get<{ Querystring: { limit: number; after?: string; status?: string } }>(
    "/api/talk/rooms",
    {
      schema: {
        querystring: {
          ...page,
          properties: {
            ...page.properties,
            status: {
              type: "string",
              enum: ["waiting", "in_progress", "closed"],
            },
          },
        },
      },
    },
    async (r) => {
      const q = new URLSearchParams({ limit: String(r.query.limit) });
      if (r.query.after) q.set("after", r.query.after);
      if (r.query.status) q.set("status", r.query.status);
      return decodeTalkResponse(await call(r, "/talk/rooms?" + q), 200, (v) =>
        paged(v, r.query.limit, (x) => room(x, true)),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/talk/rooms/:id",
    { schema: { params, querystring: empty } },
    async (r) =>
      decodeTalkResponse(
        await call(r, "/talk/rooms/" + r.params.id),
        200,
        (v) => {
          const value = room(v);
          if (value.id !== r.params.id) throw unavailable();
          return value;
        },
      ),
  );
  app.get<{
    Params: { id: string };
    Querystring: { limit: number; after?: string };
  }>(
    "/api/talk/rooms/:id/messages",
    { schema: { params, querystring: page } },
    async (r) => {
      const q = new URLSearchParams({ limit: String(r.query.limit) });
      if (r.query.after) q.set("after", r.query.after);
      return decodeTalkResponse(
        await call(r, "/talk/rooms/" + r.params.id + "/messages?" + q),
        200,
        (v) => paged(v, r.query.limit, message),
      );
    },
  );
  for (const action of ["assign-self", "close"] as const)
    app.post<{ Params: { id: string } }>(
      "/api/talk/rooms/:id/" + action,
      { schema: { params, querystring: empty, body: empty } },
      async (r) =>
        decodeTalkResponse(
          await call(
            r,
            "/talk/rooms/" + r.params.id + "/" + action,
            {},
            "POST",
          ),
          200,
          (v) => {
            const row = record(v);
            if (
              id(row.id) !== r.params.id ||
              row.status !== (action === "close" ? "closed" : "in_progress")
            )
              throw unavailable();
            return action === "close"
              ? { id: r.params.id, status: "closed" }
              : {
                  id: r.params.id,
                  status: "in_progress",
                  assignedMemberId: id(row.assignedMemberId),
                };
          },
        ),
    );
  app.post<{
    Params: { id: string };
    Body: { requestId: string; text: string };
  }>(
    "/api/talk/rooms/:id/messages",
    {
      schema: {
        params,
        querystring: empty,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["requestId", "text"],
          properties: {
            requestId: uuid,
            text: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    async (r) => {
      if (!r.body.text.trim() || Buffer.byteLength(r.body.text) > 4096)
        throw new ApiError(
          400,
          "invalid_input",
          "Text must contain 1–4096 bytes.",
        );
      return decodeTalkResponse(
        await call(
          r,
          "/talk/rooms/" + r.params.id + "/messages",
          r.body,
          "POST",
        ),
        200,
        (v) => {
          const row = record(v);
          if (row.delivery !== "pending") throw unavailable();
          return { id: id(row.id), delivery: "pending" };
        },
      );
    },
  );
  app.get<{ Querystring: { limit: number; after?: string } }>(
    "/api/talk/settings/origins",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
            after: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (r) => {
      const q = new URLSearchParams({ limit: String(r.query.limit) });
      if (r.query.after) q.set("after", r.query.after);
      return decodeTalkResponse(
        await call(r, "/talk/settings/origins?" + q),
        200,
        (v) => {
          const row = record(v);
          if (!Array.isArray(row.items) || row.items.length > r.query.limit)
            throw unavailable();
          return {
            items: row.items.map((x) => string(x, 2048)),
            next: row.next === null ? null : string(row.next, 2048),
          };
        },
      );
    },
  );
  for (const method of ["POST", "DELETE"] as const)
    app.route<{ Body: { origin: string } }>({
      method,
      url: "/api/talk/settings/origins",
      schema: {
        querystring: empty,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["origin"],
          properties: { origin: { type: "string", maxLength: 2048 } },
        },
      },
      handler: async (r, reply) => {
        const response = await call(
          r,
          "/talk/settings/origins",
          r.body,
          method,
        );
        if (method === "DELETE") {
          if (response.status !== 204)
            await decodeTalkResponse(response, 204, () => undefined);
          else await response.body?.cancel();
          return reply.code(204).send();
        }
        return reply.code(201).send(
          await decodeTalkResponse(response, 201, (v) => {
            const row = record(v);
            if (row.origin !== r.body.origin) throw unavailable();
            return { origin: r.body.origin };
          }),
        );
      },
    });
  for (const method of ["GET", "POST"] as const)
    app.route({
      method,
      url: "/api/talk/settings/widget-key",
      schema: {
        querystring: empty,
        ...(method === "POST" ? { body: empty } : {}),
      },
      handler: async (r) =>
        decodeTalkResponse(
          await call(
            r,
            "/talk/settings/widget-key",
            method === "POST" ? {} : undefined,
            method,
          ),
          200,
          (v) => {
            const row = record(v),
              previousValidUntil =
                row.previousValidUntil === null
                  ? null
                  : date(row.previousValidUntil);
            if (method === "POST") {
              const key = string(row.key, 43);
              if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw unavailable();
              return { key, previousValidUntil };
            }
            if (typeof row.issued !== "boolean") throw unavailable();
            return { issued: row.issued, previousValidUntil };
          },
        ),
    });
}
