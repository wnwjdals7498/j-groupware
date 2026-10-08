import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MAIL_PATHS,
  MAIL_LIMITS,
  MAIL_ID_PATTERN,
  parseMailPage,
  parseMailDetail,
} from "@j-mail/contracts";
import { SESSION_POLICY } from "@j-groupware/contracts";
import type { ServiceClient } from "./services.js";
import { cookieValue } from "./security.js";
import { ApiError, unavailable } from "./errors.js";
const empty = { type: "object", additionalProperties: false };
async function decode<T>(response: Response, map: (value: unknown) => T) {
  if (response.status !== 200) {
    await response.body?.cancel();
    const errors: Record<number, [string, string]> = {
      400: ["invalid_input", "Invalid mail request."],
      401: ["unauthenticated", "Mail authentication failed."],
      403: ["forbidden", "Permission denied."],
      404: ["not_found", "Message not found."],
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
      if (size > MAIL_LIMITS.response) throw unavailable();
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
export function registerMailRoutes(
  app: FastifyInstance,
  services: Pick<ServiceClient, "request">,
) {
  const session = (request: FastifyRequest) =>
    cookieValue(request.headers.cookie, SESSION_POLICY.cookie);
  app.get<{ Querystring: { offset: number; limit: number } }>(
    "/api/mail/messages",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            offset: {
              type: "integer",
              minimum: 0,
              maximum: MAIL_LIMITS.scan,
              default: 0,
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAIL_LIMITS.page,
              default: 20,
            },
          },
        },
      },
    },
    async (request) => {
      const query = new URLSearchParams({
        offset: String(request.query.offset),
        limit: String(request.query.limit),
      });
      const page = await decode(
        await services.request(
          session(request),
          "j-mail",
          MAIL_PATHS.messages + "?" + query,
        ),
        parseMailPage,
      );
      if (
        page.offset !== request.query.offset ||
        page.limit !== request.query.limit
      )
        throw unavailable();
      return page;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/mail/messages/:id",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", pattern: MAIL_ID_PATTERN } },
        },
        querystring: empty,
      },
    },
    async (request) => {
      const detail = await decode(
        await services.request(
          session(request),
          "j-mail",
          MAIL_PATHS.message(request.params.id),
        ),
        parseMailDetail,
      );
      if (detail.id !== request.params.id) throw unavailable();
      return detail;
    },
  );
}
