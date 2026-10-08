import type { FastifyInstance, FastifyRequest } from "fastify";
import WebSocket from "ws";
import type { RawData } from "ws";
import { SESSION_POLICY } from "@j-groupware/contracts";
import type { RealtimeSessions } from "./realtime-sessions.js";
import type { ServiceTokens } from "./service-tokens.js";
import type { ServiceEndpoints } from "./services.js";
import { serviceOrigin } from "./services.js";
import { cookieValue, digest } from "./security.js";
import { ApiError, unavailable } from "./errors.js";

const MAX_BYTES = 1048576;
const querystring = { type: "object", additionalProperties: false };
function closeSocket(socket: WebSocket | undefined, code: number): void {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  socket.close(code, "Connection ended.");
  const timer = setTimeout(() => socket.terminate(), 250);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}
export function registerRealtimeRoutes(
  app: FastifyInstance,
  hub: RealtimeSessions,
  tokens: ServiceTokens,
  endpoints: ServiceEndpoints,
  origin: string,
): void {
  const source = endpoints["j-messenger"]
    ? new URL("/api/v1/events", serviceOrigin(endpoints["j-messenger"]))
    : undefined;
  if (source) source.protocol = source.protocol === "https:" ? "wss:" : "ws:";
  const authorizations = new WeakMap<FastifyRequest, string>();
  app.get(
    "/api/messenger/ws",
    {
      websocket: true,
      schema: { querystring },
      preHandler: async (request) => {
        if (request.headers.origin !== origin)
          throw new ApiError(403, "forbidden", "Unregistered origin.");
        if (!source) throw unavailable();
        await hub.ready();
        authorizations.set(
          request,
          await tokens.get(
            cookieValue(request.headers.cookie, SESSION_POLICY.cookie),
            "j-messenger",
          ),
        );
      },
    },
    (socket, request) => {
      let upstream: WebSocket | undefined,
        release: (() => void) | undefined,
        closed = false,
        queuedBytes = 0;
      const queue: { data: RawData; binary: boolean }[] = [];
      const close = (code = 1008) => {
        if (closed) return;
        closed = true;
        queue.length = 0;
        closeSocket(socket, code);
        closeSocket(upstream, code);
        release?.();
      };
      const send = (target: WebSocket, data: RawData, binary: boolean) => {
        if (target.readyState !== WebSocket.OPEN) return;
        if (target.bufferedAmount > MAX_BYTES) {
          close(1013);
          return;
        }
        target.send(data, { binary }, (error) => {
          if (error) close(1011);
        });
      };
      // Attach synchronously before the asynchronous DB check/upstream handshake.
      socket.on("message", (data, binary) => {
        if (closed) return;
        if (upstream?.readyState === WebSocket.OPEN)
          send(upstream, data, binary);
        else {
          const size = Array.isArray(data)
            ? data.reduce((n, chunk) => n + chunk.length, 0)
            : data.byteLength;
          queuedBytes += size;
          if (queue.length >= 64 || queuedBytes > MAX_BYTES) close(1013);
          else queue.push({ data, binary });
        }
      });
      socket.on("close", () => close(1000));
      socket.on("error", () => close(1011));
      void (async () => {
        release = await hub.track(
          digest(cookieValue(request.headers.cookie, SESSION_POLICY.cookie)!),
          "messenger:use",
          close,
        );
        if (closed) {
          release();
          return;
        }
        upstream = new WebSocket(source!, {
          headers: { Authorization: "Bearer " + authorizations.get(request)! },
          followRedirects: false,
          handshakeTimeout: 5000,
          maxPayload: MAX_BYTES,
          perMessageDeflate: false,
        });
        authorizations.delete(request);
        upstream.on("open", () => {
          for (const frame of queue) send(upstream!, frame.data, frame.binary);
          queue.length = 0;
          queuedBytes = 0;
        });
        upstream.on("message", (data, binary) => {
          if (!closed) send(socket, data, binary);
        });
        upstream.on("close", () => close(1000));
        upstream.on("error", () => close(1011));
        upstream.on("unexpected-response", (_request, response) => {
          response.destroy();
          close(1011);
        });
      })().catch(() => close(1011));
    },
  );
  app.get(
    "/api/notifications/stream",
    { schema: { querystring } },
    async (request, reply) => {
      if (
        request.headers.origin !== undefined &&
        request.headers.origin !== origin
      )
        throw new ApiError(403, "forbidden", "Unregistered origin.");
      const resources: { timer?: ReturnType<typeof setInterval> } = {};
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (resources.timer) clearInterval(resources.timer);
        release();
        reply.raw.end();
      };
      // Do not open the stream before the subscription/DB recheck succeeds.
      const release = await hub.track(
        digest(cookieValue(request.headers.cookie, SESSION_POLICY.cookie)!),
        undefined,
        () => {
          closed = true;
          if (resources.timer) clearInterval(resources.timer);
          if (reply.sent) reply.raw.end();
        },
      );
      if (closed || request.raw.aborted || reply.raw.destroyed) {
        release();
        throw unavailable();
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      reply.raw.write(": connected\n\n");
      resources.timer = setInterval(() => {
        if (reply.raw.writableLength > 65536) close();
        else reply.raw.write(": keepalive\n\n");
      }, 15000);
      resources.timer.unref();
      reply.raw.once("close", () => {
        if (resources.timer) clearInterval(resources.timer);
        release();
        closed = true;
      });
    },
  );
}
