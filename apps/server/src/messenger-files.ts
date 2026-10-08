import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import multipart from "@fastify/multipart";
import { FILE_MAX_BYTES } from "@j-messenger/contracts";
import { SESSION_POLICY } from "@j-groupware/contracts";
import type { FastifyInstance } from "fastify";
import type { ServiceClient } from "./services.js";
import { ApiError, unavailable } from "./errors.js";
import { cookieValue } from "./security.js";

type Decode = (
  response: Response,
  statuses: readonly number[],
  project: (value: unknown) => unknown,
) => Promise<{ status: number; body: unknown }>;
const base = "/api/messenger/api/v1";
const empty = { type: "object", additionalProperties: false };
const uuid = "^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$";
const bad = () =>
  new ApiError(400, "bad_request", "첨부 요청이 올바르지 않습니다.");
const filename = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 255 ||
    /[\x00-\x1f\x7f/\\]/.test(value)
  )
    throw bad();
  return value;
};
function descriptor(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !value.data ||
    typeof value.data !== "object"
  )
    throw unavailable();
  const row = value.data as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !new RegExp(uuid).test(row.id) ||
    ![
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
    ].includes(String(row.contentType)) ||
    typeof row.sizeBytes !== "number" ||
    !Number.isSafeInteger(row.sizeBytes) ||
    row.sizeBytes < 0 ||
    row.sizeBytes > FILE_MAX_BYTES ||
    row.status !== "ready"
  )
    throw unavailable();
  let name: string;
  try {
    name = filename(row.filename);
  } catch {
    throw unavailable();
  }
  return {
    data: {
      id: row.id,
      filename: name,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      status: row.status,
    },
  };
}
export async function registerMessengerFileRoutes(
  scope: FastifyInstance,
  services: ServiceClient,
  decode: Decode,
) {
  await scope.register(multipart, {
    limits: {
      fileSize: FILE_MAX_BYTES,
      files: 1,
      fields: 0,
      parts: 1,
      fieldNameSize: 4,
      headerPairs: 32,
    },
  });
  scope.post<{ Params: { id: string } }>(
    base + "/conversations/:id/files",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", pattern: "^[1-9][0-9]{0,18}$" } },
        },
        querystring: empty,
      },
    },
    async (request, reply) => {
      if (BigInt(request.params.id) > 9223372036854775807n) throw bad();
      if (!request.isMultipart())
        throw new ApiError(
          415,
          "bad_request",
          "첨부 형식이 올바르지 않습니다.",
        );
      const root = await mkdtemp(join(tmpdir(), "jgw-messenger-upload-"));
      const file = join(root, "payload");
      const abort = new AbortController();
      const stop = () => abort.abort();
      request.raw.once("aborted", stop);
      // Multipart consumes raw directly; a preParsing pipe would drain it early.
      let received = 0;
      const countBytes = (chunk: Buffer) => {
        received += chunk.length;
        if (received > FILE_MAX_BYTES + 65536) {
          abort.abort();
          request.raw.destroy();
        }
      };
      request.raw.on("data", countBytes);
      const timer = setTimeout(() => {
        abort.abort();
        request.raw.destroy();
      }, 30000);
      timer.unref();
      let output: { status: number; body: unknown };
      try {
        let name: string | undefined;
        for await (const part of request.parts()) {
          if (
            part.type !== "file" ||
            part.fieldname !== "file" ||
            name !== undefined
          )
            throw bad();
          name = filename(part.filename);
          await pipeline(
            part.file,
            createWriteStream(file, { flags: "wx", mode: 0o600 }),
            { signal: abort.signal },
          );
          if (part.file.truncated)
            throw new ApiError(413, "too_large", "첨부가 너무 큽니다.");
        }
        if (!name) throw bad();
        const boundary = "jgw-" + randomUUID();
        const head = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replaceAll('"', '\\"')}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          "utf8",
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const size = (await stat(file)).size;
        const stream = Readable.from(
          (async function* () {
            yield head;
            for await (const chunk of createReadStream(file)) yield chunk;
            yield tail;
          })(),
        );
        try {
          output = await decode(
            await services.request(
              cookieValue(request.headers.cookie, SESSION_POLICY.cookie),
              "j-messenger",
              `/api/v1/conversations/${request.params.id}/files`,
              {
                method: "POST",
                multipart: {
                  stream,
                  boundary,
                  bytes: head.length + size + tail.length,
                },
                signal: abort.signal,
              },
            ),
            [201],
            descriptor,
          );
        } finally {
          stream.destroy();
        }
      } finally {
        clearTimeout(timer);
        request.raw.off("aborted", stop);
        request.raw.off("data", countBytes);
        await rm(root, { recursive: true, force: true });
      }
      return reply.code(output.status).send(output.body);
    },
  );
  scope.get<{ Params: { id: string } }>(
    base + "/files/:id/content",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", pattern: uuid } },
        },
        querystring: empty,
      },
    },
    async (request, reply) => {
      const abort = new AbortController();
      const stop = () => abort.abort();
      reply.raw.once("close", stop);
      try {
        const response = await services.request(
          cookieValue(request.headers.cookie, SESSION_POLICY.cookie),
          "j-messenger",
          `/api/v1/files/${request.params.id}/content`,
          { signal: abort.signal },
        );
        if (response.status !== 200) {
          await decode(response, [], () => undefined);
          throw unavailable();
        }
        const disposition = response.headers.get("content-disposition");
        let name: string;
        try {
          if (!disposition?.startsWith("attachment; filename*=UTF-8''"))
            throw unavailable();
          name = filename(
            decodeURIComponent(
              disposition.slice("attachment; filename*=UTF-8''".length),
            ),
          );
        } catch {
          await response.body?.cancel();
          throw unavailable();
        }
        const declared = response.headers.get("content-length");
        if (
          !response.body ||
          (declared !== null &&
            (!/^(0|[1-9][0-9]*)$/.test(declared) ||
              Number(declared) > FILE_MAX_BYTES))
        ) {
          await response.body?.cancel();
          throw unavailable();
        }
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            done(bytes > FILE_MAX_BYTES ? unavailable() : null, chunk);
          },
          flush(done) {
            done(
              declared !== null && bytes !== Number(declared)
                ? unavailable()
                : null,
            );
          },
        });
        const source = Readable.fromWeb(
          response.body as NodeReadableStream<Uint8Array>,
        );
        source.once("error", (error) => bounded.destroy(error));
        bounded.once("close", () => {
          source.destroy();
          reply.raw.off("close", stop);
        });
        reply
          .type("application/octet-stream")
          .header(
            "Content-Disposition",
            "attachment; filename*=UTF-8''" + encodeURIComponent(name),
          )
          .header("Cache-Control", "no-store")
          .header("X-Content-Type-Options", "nosniff");
        return reply.send(source.pipe(bounded));
      } catch (error) {
        reply.raw.off("close", stop);
        throw error;
      }
    },
  );
}
