import type { FastifyInstance, FastifyRequest } from "fastify";
import { SESSION_POLICY } from "@j-groupware/contracts";
import {
  TALK_MEMBER_SCHEMAS,
  TALK_UUID_PATTERN,
  TALK_ROOM_STATUSES,
  TALK_MEMBER_LIMITS,
  TALK_VISITOR_POLICY,
} from "@j-talk/contracts";
import type {
  TalkRoomStatus,
  TalkReplyResult,
  TalkAssignmentResult,
} from "@j-talk/contracts";
import type { ServiceClient } from "./services.js";
import type { TalkAssignments } from "./talk-assignments.js";
import type { SessionRow } from "./db/sessions.js";
import { cookieValue } from "./security.js";
import { ApiError, unavailable } from "./errors.js";
import {
  decodeCustomerAuthResponse,
  decodeGuest,
} from "./customer-auth-routes.js";
const uuidPattern = TALK_UUID_PATTERN;
const { empty, roomParams: params, page } = TALK_MEMBER_SCHEMAS;
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
const status = (value: unknown): TalkRoomStatus => {
  const v = string(value, 16);
  if (!TALK_ROOM_STATUSES.includes(v as TalkRoomStatus)) throw unavailable();
  return v as TalkRoomStatus;
};
const nullableId = (value: unknown) => (value === null ? null : id(value));
function room(value: unknown, summary = false) {
  const row = record(value);
  const base = {
    id: id(row.id),
    status: status(row.status),
    assignedMemberId: nullableId(row.assignedMemberId),
  };
  const guestId = row.guestId === null ? null : string(row.guestId, 128);
  if (guestId !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(guestId))
    throw unavailable();
  return summary
    ? { ...base, guestId, createdAt: date(row.createdAt) }
    : { ...base, guestId };
}
function message(value: unknown) {
  const row = record(value),
    text = string(row.text, 4096);
  if (!text || Buffer.byteLength(text) > 4096) throw unavailable();
  const senderMemberId = nullableId(row.senderMemberId),
    senderVisitorId =
      row.senderVisitorId === undefined
        ? null
        : nullableId(row.senderVisitorId);
  if ((senderMemberId === null) === (senderVisitorId === null))
    throw unavailable();
  return {
    id: id(row.id),
    text,
    senderMemberId,
    senderVisitorId,
    createdAt: date(row.createdAt),
  };
}
function paged<T>(value: unknown, limit: number, map: (value: unknown) => T) {
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
  canReadGuests: (request: FastifyRequest) => boolean = () => false,
  assignments?: TalkAssignments,
  identity?: (request: FastifyRequest) => SessionRow,
) {
  const session = (r: FastifyRequest) =>
    cookieValue(r.headers.cookie, SESSION_POLICY.cookie);
  app.get<{ Querystring: { cursor?: string } }>(
    "/api/talk/sync",
    {
      schema: {
        querystring: {
          ...empty,
          properties: {
            cursor: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
      },
    },
    async (r) => {
      const suffix = r.query.cursor
        ? "?" + new URLSearchParams({ cursor: r.query.cursor })
        : "";
      return decodeTalkResponse(
        await services.request(session(r), "j-talk", "/talk/sync" + suffix),
        200,
        (v) => {
          const row = record(v),
            cursor = string(row.cursor, 2048);
          if (
            !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor) ||
            typeof row.hasMore !== "boolean" ||
            !Array.isArray(row.items) ||
            row.items.length > TALK_VISITOR_POLICY.page
          )
            throw unavailable();
          return {
            cursor,
            hasMore: row.hasMore,
            items: row.items.map((value) => {
              const event = record(value),
                type = string(event.type, 16);
              if (
                ![
                  "talk.new",
                  "talk.assigned",
                  "talk.message",
                  "talk.closed",
                ].includes(type) ||
                (type === "talk.message") !== (event.message !== null)
              )
                throw unavailable();
              return {
                id: id(event.id),
                roomId: id(event.roomId),
                type,
                message: event.message === null ? null : message(event.message),
              };
            }),
          };
        },
      );
    },
  );
  async function guestNames<T extends { guestId: string | null }>(
    request: FastifyRequest,
    rooms: T[],
  ): Promise<(T & { guestName?: string | null })[]> {
    // Permission is checked before any lookup or customer-auth token exchange.
    if (!canReadGuests(request)) return rooms;
    const names = new Map<string, string | null>();
    for (const room of rooms)
      if (room.guestId !== null && new RegExp(uuidPattern).test(room.guestId))
        names.set(room.guestId, null);
    const ids = [...names.keys()],
      controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(4, ids.length) },
      async () => {
        for (;;) {
          signal.throwIfAborted();
          const guestId = ids[next++];
          if (guestId === undefined) return;
          try {
            const response = await services.request(
              session(request),
              "j-customer-auth-db",
              "/customer-auth/guests/" + guestId,
              { signal },
            );
            if (response.status === 404) {
              await response.body?.cancel();
              continue;
            }
            const guest = await decodeCustomerAuthResponse(
              response,
              200,
              decodeGuest,
            );
            if (guest.id !== guestId) throw unavailable();
            names.set(guestId, guest.name);
          } catch (error) {
            controller.abort();
            throw error;
          }
        }
      },
    );
    const outcomes = await Promise.allSettled(workers);
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw unavailable();
    return rooms.map((room) => ({
      ...room,
      guestName:
        room.guestId === null ? null : (names.get(room.guestId) ?? null),
    }));
  }
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
  app.get<{ Querystring: { cursor?: string } }>(
    "/api/talk/assignees",
    {
      schema: { querystring: TALK_MEMBER_SCHEMAS.assignees },
    },
    (r) => {
      if (!assignments || !identity) throw unavailable();
      return assignments.list(identity(r), r.query.cursor);
    },
  );
  app.post<{ Params: { id: string }; Body: { memberId: string } }>(
    "/api/talk/rooms/:id/assign",
    {
      schema: {
        params,
        querystring: empty,
        body: TALK_MEMBER_SCHEMAS.assign,
      },
    },
    async (r) => {
      if (!assignments || !identity) throw unavailable();
      const proof = await assignments.authorize(
        identity(r),
        r.params.id,
        r.body.memberId,
      );
      return decodeTalkResponse(
        await call(r, "/talk/rooms/" + r.params.id + "/assign", proof, "POST"),
        200,
        (value) => {
          const v = record(value);
          if (
            id(v.id) !== r.params.id ||
            v.status !== "in_progress" ||
            id(v.assignedMemberId) !== r.body.memberId
          )
            throw unavailable();
          return {
            id: r.params.id,
            status: "in_progress" as const,
            assignedMemberId: r.body.memberId,
            occurrenceId: id(v.occurrenceId),
          };
        },
      );
    },
  );
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
              enum: TALK_ROOM_STATUSES,
            },
          },
        },
      },
    },
    async (r) => {
      const q = new URLSearchParams({ limit: String(r.query.limit) });
      if (r.query.after) q.set("after", r.query.after);
      if (r.query.status) q.set("status", r.query.status);
      const result = await decodeTalkResponse(
        await call(r, "/talk/rooms?" + q),
        200,
        (v) => paged(v, r.query.limit, (x) => room(x, true)),
      );
      return { ...result, items: await guestNames(r, result.items) };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/talk/rooms/:id",
    { schema: { params, querystring: empty } },
    async (r) => {
      const result = await decodeTalkResponse(
        await call(r, "/talk/rooms/" + r.params.id),
        200,
        (v) => {
          const value = room(v);
          if (value.id !== r.params.id) throw unavailable();
          return value;
        },
      );
      return (await guestNames(r, [result]))[0];
    },
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
      async (r) => {
        let body: unknown = {},
          downstream = action as string;
        if (action === "assign-self") {
          if (!assignments || !identity) throw unavailable();
          body = await assignments.authorize(
            identity(r),
            r.params.id,
            identity(r).subject,
          );
          downstream = "assign";
        }
        return decodeTalkResponse(
          await call(
            r,
            "/talk/rooms/" + r.params.id + "/" + downstream,
            body,
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
              : ({
                  id: r.params.id,
                  status: "in_progress",
                  assignedMemberId: id(row.assignedMemberId),
                  occurrenceId: id(row.occurrenceId),
                } satisfies TalkAssignmentResult);
          },
        );
      },
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
        body: TALK_MEMBER_SCHEMAS.reply,
      },
    },
    async (r) => {
      if (
        !r.body.text.trim() ||
        Buffer.byteLength(r.body.text) > TALK_MEMBER_LIMITS.textBytes
      )
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
          return {
            id: id(row.id),
            delivery: "pending",
          } satisfies TalkReplyResult;
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
