import Fastify, { LogController } from "fastify";
import type { FastifyError } from "fastify";
import type { NotificationStore } from "./db/notifications.js";
import { ApiError, unavailable } from "./errors.js";
export function createNotificationReceiver(store: NotificationStore) {
  const app = Fastify({
    trustProxy: false,
    bodyLimit: 16384,
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
    if (
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(
        request.raw.socket.remoteAddress ?? "",
      ) ||
      request.headers.origin !== undefined ||
      request.headers.cookie !== undefined ||
      request.headers.authorization !== undefined
    )
      throw new ApiError(403, "forbidden", "Internal requests only.");
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const safe =
      error instanceof ApiError
        ? error
        : [400, 413, 415].includes(Number(error.statusCode))
          ? new ApiError(
              Number(error.statusCode),
              "invalid_input",
              "Invalid notification request.",
            )
          : unavailable();
    reply
      .code(safe.status)
      .send({ code: safe.code, message: safe.message, requestId: request.id });
  });
  app.post("/internal/notifications", async (request, reply) => {
    if (Object.keys(request.query as object).length)
      throw new ApiError(400, "invalid_input", "Query fields are not allowed.");
    const key = request.headers["x-jgw-internal-key"];
    const result = await store.receive(
      request.body,
      typeof key === "string" ? key : undefined,
    );
    return reply.code(200).send(result);
  });
  return app;
}
