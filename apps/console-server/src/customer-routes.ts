import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionRow } from "@j-groupware/bff-auth";
import { ApiError } from "@j-groupware/bff-auth";
import { optionalServices } from "./customers.js";
import type { ConsoleCustomers } from "./customers.js";
const empty = { type: "object", additionalProperties: false };
const tenant = {
  type: "string",
  pattern: "^(?!operator$)[a-z][a-z0-9-]{2,30}$",
};
const params = {
  type: "object",
  additionalProperties: false,
  required: ["tenant"],
  properties: { tenant },
};
const positive = { type: "integer", minimum: 1, maximum: 2147483647 };
const list = {
  type: "array",
  maxItems: 6,
  uniqueItems: true,
  items: { type: "string", enum: optionalServices },
};
export function registerCustomerRoutes(
  app: FastifyInstance,
  store: ConsoleCustomers,
  identity: (r: FastifyRequest) => SessionRow,
) {
  app.get<{ Querystring: { limit: number; after?: string } }>(
    "/console/api/customers",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            after: tenant,
          },
        },
      },
    },
    (r) => store.list(r.query.limit, r.query.after),
  );
  app.get<{ Params: { tenant: string } }>(
    "/console/api/customers/:tenant",
    { schema: { params, querystring: empty } },
    (r) => store.detail(r.params.tenant),
  );
  app.post<{
    Body: { tenantId: string; adminUsername: string; adminPassword: string };
  }>(
    "/console/api/customers",
    {
      schema: {
        querystring: empty,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "adminUsername", "adminPassword"],
          properties: {
            tenantId: tenant,
            adminUsername: {
              type: "string",
              minLength: 1,
              maxLength: 255,
              pattern: "\\S",
            },
            adminPassword: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (r, reply) =>
      reply
        .code(201)
        .send(await store.register(identity(r).access_token, r.body)),
  );
  app.put<{
    Params: { tenant: string; service: string };
    Body: { revision: number; enabled: boolean };
  }>(
    "/console/api/customers/:tenant/services/:service",
    {
      schema: {
        params: {
          ...params,
          required: ["tenant", "service"],
          properties: {
            ...params.properties,
            service: { type: "string", enum: optionalServices },
          },
        },
        querystring: empty,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["revision", "enabled"],
          properties: { revision: positive, enabled: { type: "boolean" } },
        },
      },
    },
    (r) =>
      store.reconcile(identity(r).access_token, r.params.tenant, {
        service: r.params.service,
        enabled: r.body.enabled,
        revision: r.body.revision,
      }),
  );
  app.post<{ Params: { tenant: string } }>(
    "/console/api/customers/:tenant/reconcile",
    { schema: { params, querystring: empty, body: empty } },
    (r) => store.reconcile(identity(r).access_token, r.params.tenant),
  );
  app.post<{ Params: { tenant: string } }>(
    "/console/api/customers/:tenant/bootstrap/reset",
    { schema: { params, querystring: empty, body: empty } },
    (r) => store.resetBootstrap(identity(r).access_token, r.params.tenant),
  );
  app.post<{ Params: { tenant: string } }>(
    "/console/api/customers/:tenant/agent-key",
    { schema: { params, querystring: empty, body: empty } },
    (r) => store.rotateAgent(r.params.tenant),
  );
  app.delete<{ Params: { tenant: string } }>(
    "/console/api/customers/:tenant/agent-key",
    { schema: { params, querystring: empty } },
    async (r, reply) => {
      await store.revokeAgent(r.params.tenant);
      return reply.code(204).send();
    },
  );
  const agent = (r: FastifyRequest) => {
    if (r.headers.cookie !== undefined)
      throw new ApiError(
        401,
        "unauthenticated",
        "Agent requests cannot use browser cookies.",
      );
    return r.headers.authorization;
  };
  app.get(
    "/console/api/agent/desired-state",
    { schema: { querystring: empty } },
    (r) => store.agent(agent(r)),
  );
  app.post<{
    Body: {
      desiredRevision: number;
      agentEpoch: number;
      reportSequence: number;
      installed?: string[];
      outcome: string;
      phase?: string;
      error?: string;
    };
  }>(
    "/console/api/agent/status",
    {
      schema: {
        querystring: empty,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "desiredRevision",
            "agentEpoch",
            "reportSequence",
            "outcome",
          ],
          properties: {
            desiredRevision: positive,
            agentEpoch: positive,
            reportSequence: positive,
            installed: list,
            outcome: { type: "string", enum: ["synchronized", "failed"] },
            phase: {
              type: "string",
              enum: ["desired", "inventory", "provision"],
            },
            error: {
              type: "string",
              enum: [
                "invalid_state",
                "cancelled",
                "read_timeout",
                "provision_failed",
                "observation_failed",
                "desired_unavailable",
                "inventory_unavailable",
              ],
            },
          },
        },
      },
    },
    (r) => store.report(agent(r), r.body),
  );
}
