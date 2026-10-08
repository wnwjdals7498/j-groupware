import type { FastifyInstance, FastifyRequest } from "fastify";
import type { NotificationStore } from "./db/notifications.js";
import type { SessionRow } from "./db/sessions.js";
import { ApiError } from "./errors.js";
export function registerNotificationRoutes(
  app: FastifyInstance,
  store: NotificationStore,
  identity: (request: FastifyRequest) => SessionRow,
) {
  app.get<{ Querystring: { cursor?: string } }>(
    "/api/notifications",
    {
      schema: {
        querystring: {
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
        },
      },
    },
    (request) => store.list(identity(request), request.query.cursor),
  );
  app.post<{ Params: { id: string } }>(
    "/api/notifications/:id/read",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: {
              type: "string",
              pattern: "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$",
            },
          },
        },
        querystring: { type: "object", additionalProperties: false },
      },
    },
    (request) => {
      if (request.body !== undefined)
        throw new ApiError(
          400,
          "invalid_input",
          "Read marking requires no body.",
        );
      return store.read(identity(request), request.params.id);
    },
  );
}
