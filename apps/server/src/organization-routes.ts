import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  CreateOrganizationDepartment,
  EditOrganizationDepartment,
  EditOrganizationPosition,
  EditOrganizationPlacement,
} from "@j-groupware/contracts";
import type { OrganizationStore } from "./db/organization.js";
import type { Members } from "./members.js";
import type { SessionRow } from "./db/sessions.js";
import { ApiError } from "./errors.js";

const uuid = {
  type: "string",
  pattern: "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$",
};
const id = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^(?!\\.\\.?$)(?=.*\\S)[^\\x00-\\x1f\\x7f-\\x9f]+$",
};
const revision = { type: "integer", minimum: 0, maximum: 2147483647 };
const name = { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" };
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const params = (schema: object) => ({
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: schema },
});
const body = (properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const querystring = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: 2048,
      pattern: "^[A-Za-z0-9_-]+$",
    },
  },
};

export function registerOrganizationRoutes(
  app: FastifyInstance,
  organization: OrganizationStore,
  members: Members,
  identity: (request: FastifyRequest) => SessionRow,
): void {
  app.get<{ Querystring: { cursor?: string } }>(
    "/api/organization",
    { schema: { querystring } },
    (request) => organization.snapshot(request.query.cursor),
  );
  app.get<{ Querystring: { cursor?: string } }>(
    "/api/organization/candidates",
    { schema: { querystring } },
    (request) =>
      organization.candidates(identity(request).subject, request.query.cursor),
  );
  app.get(
    "/api/organization/approval-line",
    { schema: { querystring: body({}) } },
    (request) => organization.approvalLine(identity(request).subject),
  );
  app.post<{ Body: { memberIds: string[] } }>(
    "/api/organization/approval-line/validate",
    {
      schema: {
        body: body({
          memberIds: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            uniqueItems: true,
            items: id,
          },
        }),
      },
    },
    (request) =>
      organization.validateApproval(
        identity(request).subject,
        request.body.memberIds,
      ),
  );
  for (const [method, url] of [
    ["PUT", "/api/organization/members/:id"],
    ["POST", "/api/members/:id/organization"],
  ] as const) {
    app.route<{ Params: { id: string } }>({
      method,
      url,
      schema: { params: params(id), querystring: body({}) },
      handler: (request, reply) => {
        if (request.body !== undefined)
          throw new ApiError(
            400,
            "invalid_input",
            "Registration requires no body.",
          );
        if (request.raw.aborted || reply.raw.destroyed)
          throw new DOMException("Request aborted", "AbortError");
        return members.register(identity(request), request.params.id);
      },
    });
  }
  app.patch<{ Params: { id: string }; Body: EditOrganizationPlacement }>(
    "/api/organization/members/:id",
    {
      schema: {
        params: params(id),
        body: body({
          revision,
          departmentId: nullable(uuid),
          positionId: nullable(uuid),
        }),
      },
    },
    (request) => organization.placeMember(request.params.id, request.body),
  );
  app.post<{ Body: CreateOrganizationDepartment }>(
    "/api/organization/departments",
    { schema: { body: body({ revision, name, parentId: nullable(uuid) }) } },
    async (request, reply) =>
      reply.code(201).send(await organization.createDepartment(request.body)),
  );
  app.patch<{ Params: { id: string }; Body: EditOrganizationDepartment }>(
    "/api/organization/departments/:id",
    {
      schema: {
        params: params(uuid),
        body: body({
          revision,
          name,
          parentId: nullable(uuid),
          headMemberId: nullable(id),
        }),
      },
    },
    (request) => organization.editDepartment(request.params.id, request.body),
  );
  app.delete<{ Params: { id: string }; Body: { revision: number } }>(
    "/api/organization/departments/:id",
    { schema: { params: params(uuid), body: body({ revision }) } },
    (request) =>
      organization.deleteDepartment(request.params.id, request.body.revision),
  );
  app.post<{ Body: EditOrganizationPosition }>(
    "/api/organization/positions",
    { schema: { body: body({ revision, name }) } },
    async (request, reply) =>
      reply.code(201).send(await organization.createPosition(request.body)),
  );
  app.patch<{ Params: { id: string }; Body: EditOrganizationPosition }>(
    "/api/organization/positions/:id",
    { schema: { params: params(uuid), body: body({ revision, name }) } },
    (request) => organization.editPosition(request.params.id, request.body),
  );
  app.delete<{ Params: { id: string }; Body: { revision: number } }>(
    "/api/organization/positions/:id",
    { schema: { params: params(uuid), body: body({ revision }) } },
    (request) =>
      organization.deletePosition(request.params.id, request.body.revision),
  );
}
