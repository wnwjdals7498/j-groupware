import type { FastifyInstance, FastifyRequest } from "fastify";
import { APPROVAL_PATHS, APPROVAL_LIMITS } from "@j-approval/contracts";
import type {
  SubmitDocument,
  DecideDocument,
  ApprovalListView,
} from "@j-approval/contracts";
import type { OrganizationStore } from "./db/organization.js";
import type { SessionRow } from "./db/sessions.js";
import type { ServiceClient } from "./services.js";
import { ApiError, unavailable } from "./errors.js";
import { cookieValue } from "./security.js";
import { SESSION_POLICY } from "@j-groupware/contracts";

const id = {
  type: "string",
  pattern: "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$",
};
const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id },
};
const revision = { type: "integer", minimum: 0, maximum: 2147483647 };
const cursor = {
  type: "string",
  minLength: 1,
  maxLength: 2048,
  pattern: "^[A-Za-z0-9_-]+$",
};
const empty = { type: "object", additionalProperties: false };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Record<string, unknown>;
}
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length > max) throw unavailable();
  return value;
};
const integer = (value: unknown, min: number, max: number) => {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw unavailable();
  return Number(value);
};
const timestamp = (value: unknown) => {
  const result = text(value, 32);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw unavailable();
  return result;
};
function summary(value: unknown) {
  const row = object(value),
    status = text(row.status, 8);
  if (
    !["pending", "approved", "rejected"].includes(status) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(String(row.id)) ||
    (status !== "pending" && row.currentStage !== null)
  )
    throw unavailable();
  return {
    id: text(row.id, 36),
    authorId: text(row.authorId, 128),
    title: text(row.title, APPROVAL_LIMITS.title),
    status,
    currentStage:
      status === "pending" ? integer(row.currentStage, 1, 32) : null,
    revision: integer(row.revision, 0, 2147483647),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  };
}
function document(value: unknown) {
  const row = object(value);
  if (
    !Array.isArray(row.memberIds) ||
    row.memberIds.length < 1 ||
    row.memberIds.length > 32
  )
    throw unavailable();
  return {
    ...summary(row),
    body: text(row.body, APPROVAL_LIMITS.body),
    memberIds: row.memberIds.map((v) => text(v, 128)),
  };
}
function history(value: unknown) {
  const row = object(value),
    action = text(row.action, 9);
  if (
    !/^[1-9][0-9]{0,18}$/.test(String(row.id)) ||
    !["submitted", "viewed", "approved", "rejected"].includes(action)
  )
    throw unavailable();
  return {
    id: text(row.id, 19),
    action,
    actorId: text(row.actorId, 128),
    stage: row.stage === null ? null : integer(row.stage, 1, 32),
    reason:
      row.reason === null ? null : text(row.reason, APPROVAL_LIMITS.reason),
    createdAt: timestamp(row.createdAt),
  };
}
function page(value: unknown, item: (value: unknown) => unknown) {
  const row = object(value);
  if (!Array.isArray(row.items) || row.items.length > 50) throw unavailable();
  return {
    items: row.items.map(item),
    nextCursor: row.nextCursor === null ? null : text(row.nextCursor, 2048),
  };
}
async function decode(
  response: Response,
  expected: number,
  map: (value: unknown) => unknown,
) {
  if (response.status !== expected) {
    await response.body?.cancel();
    const errors: Record<number, [string, string]> = {
      400: ["invalid_input", "Invalid approval request."],
      401: ["unauthenticated", "Approval authentication failed."],
      403: ["forbidden", "Permission denied."],
      404: ["not_found", "Document not found."],
      409: ["conflict", "Document changed or is already completed."],
    };
    const error = errors[response.status];
    if (error) throw new ApiError(response.status, ...error);
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
      const { value, done } = await reader.read();
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
export function registerApprovalRoutes(
  app: FastifyInstance,
  services: ServiceClient,
  organization: OrganizationStore,
  identity: (request: FastifyRequest) => SessionRow,
) {
  const session = (request: FastifyRequest) =>
    cookieValue(request.headers.cookie, SESSION_POLICY.cookie);
  app.post<{ Body: SubmitDocument }>(
    "/api/approval/documents",
    {
      schema: {
        querystring: empty,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body", "memberIds"],
          properties: {
            title: {
              type: "string",
              minLength: 1,
              maxLength: APPROVAL_LIMITS.title,
              pattern: "\\S",
            },
            body: {
              type: "string",
              minLength: 1,
              maxLength: APPROVAL_LIMITS.body,
              pattern: "\\S",
            },
            memberIds: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^(?!\\.\\.?$)(?=.*\\S)[^\\x00-\\x1f\\x7f-\\x9f]+$",
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.raw.aborted || reply.raw.destroyed)
        throw new DOMException("Request aborted", "AbortError");
      const line = await organization.validateApproval(
        identity(request).subject,
        request.body.memberIds,
      );
      return reply.code(201).send(
        await decode(
          await services.request(
            session(request),
            "j-approval",
            APPROVAL_PATHS.documents,
            {
              method: "POST",
              body: {
                title: request.body.title,
                body: request.body.body,
                memberIds: line.memberIds,
              },
            },
          ),
          201,
          document,
        ),
      );
    },
  );
  app.get<{ Querystring: { view: ApprovalListView; cursor?: string } }>(
    "/api/approval/documents",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["view"],
          properties: {
            view: {
              type: "string",
              enum: ["authored", "pending", "processed"],
            },
            cursor,
          },
        },
      },
    },
    async (request) => {
      const query = new URLSearchParams({ view: request.query.view });
      if (request.query.cursor) query.set("cursor", request.query.cursor);
      return decode(
        await services.request(
          session(request),
          "j-approval",
          APPROVAL_PATHS.documents + "?" + query,
        ),
        200,
        (value) => page(value, summary),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/approval/documents/:id",
    { schema: { params, querystring: empty } },
    async (request) =>
      decode(
        await services.request(
          session(request),
          "j-approval",
          APPROVAL_PATHS.document(request.params.id),
        ),
        200,
        document,
      ),
  );
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    "/api/approval/documents/:id/history",
    {
      schema: {
        params,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { cursor },
        },
      },
    },
    async (request) =>
      decode(
        await services.request(
          session(request),
          "j-approval",
          APPROVAL_PATHS.history(request.params.id) +
            (request.query.cursor
              ? "?" + new URLSearchParams({ cursor: request.query.cursor })
              : ""),
        ),
        200,
        (value) => page(value, history),
      ),
  );
  app.post<{ Params: { id: string }; Body: DecideDocument }>(
    "/api/approval/documents/:id/decisions",
    {
      schema: {
        params,
        querystring: empty,
        body: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["revision", "action"],
              properties: { revision, action: { const: "approve" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["revision", "action", "reason"],
              properties: {
                revision,
                action: { const: "reject" },
                reason: {
                  type: "string",
                  minLength: 1,
                  maxLength: APPROVAL_LIMITS.reason,
                  pattern: "\\S",
                },
              },
            },
          ],
        },
      },
    },
    async (request, reply) => {
      if (request.raw.aborted || reply.raw.destroyed)
        throw new DOMException("Request aborted", "AbortError");
      return decode(
        await services.request(
          session(request),
          "j-approval",
          APPROVAL_PATHS.decisions(request.params.id),
          { method: "POST", body: request.body },
        ),
        200,
        document,
      );
    },
  );
}
