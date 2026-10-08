import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CUSTOMER_AUTH_PATHS,
  SCHEMAS,
  MANAGEMENT_SCHEMAS,
  GUEST_PAGE_SCHEMA,
  API_KEY_PATTERN,
  LOGIN_ID_PATTERN,
} from "@j-customer-auth-db/contracts";
import type {
  Guest,
  GuestInput,
  GuestUpdate,
  ApiKey,
  ApiKeyInput,
  ApiKeyScope,
} from "@j-customer-auth-db/contracts";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { ApiError, unavailable } from "./errors.js";
import { cookieValue } from "./security.js";
import type { ServiceClient } from "./services.js";
const empty = { type: "object", additionalProperties: false };
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number, allowEmpty = false): string => {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value) ||
    [...value].length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw unavailable();
  return value;
};
const id = (value: unknown) => {
  const result = text(value, 36);
  if (!uuidPattern.test(result)) throw unavailable();
  return result;
};
const date = (value: unknown) => {
  const result = text(value, 32);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(?![\s\S])/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    throw unavailable();
  return result;
};
export function decodeGuest(value: unknown): Guest {
  const row = record(value),
    loginId = text(row.loginId, 64);
  if (!new RegExp(LOGIN_ID_PATTERN).test(loginId)) throw unavailable();
  return {
    id: id(row.id),
    name: text(row.name, 120),
    loginId,
    contact: text(row.contact, 256, true),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  };
}
function apiKey(value: unknown): ApiKey {
  const row = record(value);
  if (
    !Array.isArray(row.scopes) ||
    row.scopes.length < 1 ||
    row.scopes.length > 2 ||
    new Set(row.scopes).size !== row.scopes.length
  )
    throw unavailable();
  const scopes = row.scopes.map((scope): ApiKeyScope => {
    if (scope !== "guest:read" && scope !== "guest:write") throw unavailable();
    return scope;
  });
  return {
    id: id(row.id),
    name: text(row.name, 120),
    scopes,
    createdAt: date(row.createdAt),
    revokedAt: row.revokedAt === null ? null : date(row.revokedAt),
  };
}
export async function decodeCustomerAuthResponse<T>(
  response: Response,
  expected: number,
  map: (value: unknown) => T,
): Promise<T> {
  if (response.status !== expected) {
    await response.body?.cancel();
    const known: Record<number, [string, string]> = {
      400: ["invalid_input", "Invalid customer request."],
      401: ["unauthenticated", "Customer authentication failed."],
      403: ["forbidden", "Permission denied."],
      404: ["not_found", "Customer resource not found."],
      409: ["conflict", "Customer login ID already exists."],
      429: ["rate_limited", "Please try again later."],
    };
    const safe = known[response.status];
    if (safe) throw new ApiError(response.status, ...safe);
    throw unavailable();
  }
  if (expected === 204) {
    await response.body?.cancel();
    return map(undefined);
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
export function registerCustomerAuthRoutes(
  app: FastifyInstance,
  services: Pick<ServiceClient, "request">,
) {
  const call = (
    request: FastifyRequest,
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    body?: unknown,
  ) =>
    services.request(
      cookieValue(request.headers.cookie, SESSION_POLICY.cookie),
      "j-customer-auth-db",
      path,
      {
        method,
        ...(body === undefined ? {} : { body }),
      },
    );
  app.get<{ Querystring: { q?: string; limit?: string; cursor?: string } }>(
    "/api/customer-auth/guests",
    {
      schema: {
        querystring: SCHEMAS.pageQuery,
        response: { 200: GUEST_PAGE_SCHEMA },
      },
    },
    async (request) => {
      const query = new URLSearchParams(request.query);
      const limit = Number(request.query.limit ?? "50");
      return decodeCustomerAuthResponse(
        await call(request, CUSTOMER_AUTH_PATHS.guests + "?" + query),
        200,
        (value) => {
          const row = record(value);
          if (!Array.isArray(row.items) || row.items.length > limit)
            throw unavailable();
          return {
            items: row.items.map(decodeGuest),
            next: row.next === null ? null : text(row.next, 1024),
          };
        },
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/customer-auth/guests/:id",
    {
      schema: {
        params: SCHEMAS.id,
        querystring: empty,
        response: { 200: SCHEMAS.guest },
      },
    },
    async (request) =>
      decodeCustomerAuthResponse(
        await call(
          request,
          CUSTOMER_AUTH_PATHS.guests + "/" + request.params.id.toLowerCase(),
        ),
        200,
        (value) => {
          const guest = decodeGuest(value);
          if (guest.id !== request.params.id.toLowerCase()) throw unavailable();
          return guest;
        },
      ),
  );
  app.post<{ Body: GuestInput }>(
    "/api/customer-auth/guests",
    {
      bodyLimit: 16384,
      schema: {
        querystring: empty,
        body: MANAGEMENT_SCHEMAS.guestInput,
        response: { 201: SCHEMAS.guest },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await decodeCustomerAuthResponse(
            await call(
              request,
              CUSTOMER_AUTH_PATHS.guests,
              "POST",
              request.body,
            ),
            201,
            decodeGuest,
          ),
        ),
  );
  app.patch<{ Params: { id: string }; Body: GuestUpdate }>(
    "/api/customer-auth/guests/:id",
    {
      bodyLimit: 16384,
      schema: {
        params: SCHEMAS.id,
        querystring: empty,
        body: MANAGEMENT_SCHEMAS.guestUpdate,
        response: { 200: SCHEMAS.guest },
      },
    },
    async (request) =>
      decodeCustomerAuthResponse(
        await call(
          request,
          CUSTOMER_AUTH_PATHS.guests + "/" + request.params.id.toLowerCase(),
          "PATCH",
          request.body,
        ),
        200,
        (value) => {
          const guest = decodeGuest(value);
          if (guest.id !== request.params.id.toLowerCase()) throw unavailable();
          return guest;
        },
      ),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/customer-auth/guests/:id",
    { schema: { params: SCHEMAS.id, querystring: empty } },
    async (request, reply) => {
      await decodeCustomerAuthResponse(
        await call(
          request,
          CUSTOMER_AUTH_PATHS.guests + "/" + request.params.id.toLowerCase(),
          "DELETE",
        ),
        204,
        () => undefined,
      );
      return reply.code(204).send();
    },
  );
  app.get(
    "/api/customer-auth/api-keys",
    {
      schema: {
        querystring: empty,
        response: { 200: MANAGEMENT_SCHEMAS.apiKeys },
      },
    },
    async (request) =>
      decodeCustomerAuthResponse(
        await call(request, CUSTOMER_AUTH_PATHS.apiKeys),
        200,
        (value) => {
          const row = record(value);
          if (!Array.isArray(row.items)) throw unavailable();
          return { items: row.items.map(apiKey) };
        },
      ),
  );
  app.post<{ Body: ApiKeyInput }>(
    "/api/customer-auth/api-keys",
    {
      bodyLimit: 16384,
      schema: {
        querystring: empty,
        body: MANAGEMENT_SCHEMAS.apiKeyInput,
        response: { 201: MANAGEMENT_SCHEMAS.issuedApiKey },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await decodeCustomerAuthResponse(
          await call(
            request,
            CUSTOMER_AUTH_PATHS.apiKeys,
            "POST",
            request.body,
          ),
          201,
          (value) => {
            const row = record(value),
              secret = text(row.secret, 49);
            if (!new RegExp(API_KEY_PATTERN).test(secret)) throw unavailable();
            return { apiKey: apiKey(row.apiKey), secret };
          },
        ),
      ),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/customer-auth/api-keys/:id",
    {
      schema: {
        params: SCHEMAS.id,
        querystring: empty,
        response: { 200: MANAGEMENT_SCHEMAS.apiKey },
      },
    },
    async (request) =>
      decodeCustomerAuthResponse(
        await call(
          request,
          CUSTOMER_AUTH_PATHS.apiKeys + "/" + request.params.id.toLowerCase(),
          "DELETE",
        ),
        200,
        (value) => {
          const key = apiKey(value);
          if (
            key.id !== request.params.id.toLowerCase() ||
            key.revokedAt === null
          )
            throw unavailable();
          return key;
        },
      ),
  );
}
