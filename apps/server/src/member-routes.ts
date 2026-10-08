import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { CreateMemberRequest } from "@j-groupware/contracts";
import type { Members } from "./members.js";
import type { SessionRow } from "./db/sessions.js";
const idSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^(?!\\.\\.?$)(?=.*\\S)[^\\x00-\\x1f\\x7f-\\x9f]+$",
};
function readSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  if (reply.raw.destroyed) controller.abort();
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}
// After a complete mutation is accepted, finish its confirmation/local bookkeeping even if the browser disconnects.
function submitted(request: FastifyRequest, reply: FastifyReply): void {
  if (request.raw.aborted || reply.raw.destroyed)
    throw new DOMException("Request aborted", "AbortError");
}
export function registerMemberRoutes(
  app: FastifyInstance,
  members: Members,
  identity: (request: FastifyRequest) => SessionRow,
): void {
  app.get(
    "/api/members/grantable-roles",
    {
      schema: { querystring: { type: "object", additionalProperties: false } },
    },
    async (request, reply) =>
      members.grantable(identity(request), readSignal(reply)),
  );
  app.get<{ Querystring: { cursor?: string } }>(
    "/api/members",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string", pattern: "^(0|[1-9][0-9]{0,5})$" },
          },
        },
      },
    },
    async (request, reply) =>
      members.list(identity(request), request.query.cursor, readSignal(reply)),
  );
  app.post<{ Body: CreateMemberRequest }>(
    "/api/members",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["username", "password", "roles"],
          properties: {
            username: {
              type: "string",
              minLength: 1,
              maxLength: 255,
              pattern: "\\S",
            },
            password: { type: "string", minLength: 1, maxLength: 1024 },
            roles: {
              type: "array",
              maxItems: 32,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      submitted(request, reply);
      return reply
        .code(201)
        .send(await members.create(identity(request), request.body));
    },
  );
  for (const method of ["PUT", "DELETE"] as const)
    app.route<{ Params: { id: string; role: string } }>({
      method,
      url: "/api/members/:id/roles/:role",
      schema: {
        params: {
          type: "object",
          required: ["id", "role"],
          properties: {
            id: idSchema,
            role: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
      handler: async (request, reply) => {
        submitted(request, reply);
        return members.role(
          identity(request),
          request.params.id,
          request.params.role,
          method === "PUT",
        );
      },
    });
  app.delete<{ Params: { id: string } }>(
    "/api/members/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: idSchema },
        },
      },
    },
    async (request, reply) => {
      submitted(request, reply);
      await members.remove(identity(request), request.params.id);
      return reply.code(204).send();
    },
  );
}
