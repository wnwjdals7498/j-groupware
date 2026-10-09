import { readFile, readdir, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { MENUS } from "@j-groupware/permissions";
import { ApiError, unavailable } from "./errors.js";

const DEFAULT_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const FALLBACK =
  '<!doctype html><html lang="ko"><meta charset="utf-8"><title>j-groupware</title><h1>j-groupware</h1><a href="/auth/login">로그인</a></html>';

/** Only a bounded build inventory is served; request paths never reach the filesystem. */
export function registerWebAssets(
  app: FastifyInstance,
  origin: string,
  root = DEFAULT_ROOT,
  required = false,
): void {
  let index = FALLBACK;
  const assets = new Map<string, { data: Buffer; type: string }>();
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss://${new URL(origin).host}; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  app.addHook("onReady", async () => {
    try {
      const info = await lstat(root + "/index.html");
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
        throw unavailable();
      index = await readFile(root + "/index.html", "utf8");
    } catch (error) {
      if (
        !required &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw unavailable();
    }
    let size = 0;
    const files = await readdir(root + "/app-assets", { withFileTypes: true });
    if (files.length > 128) throw unavailable();
    for (const entry of files) {
      if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.(?:js|css)$/.test(entry.name))
        throw unavailable();
      const file = root + "/app-assets/" + entry.name;
      const info = await lstat(file);
      size += info.size;
      if (
        info.isSymbolicLink() ||
        info.size > 4 * 1024 * 1024 ||
        size > 16 * 1024 * 1024
      )
        throw unavailable();
      assets.set(entry.name, {
        data: await readFile(file),
        type: entry.name.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8",
      });
    }
  });
  const page = async (_request: unknown, reply: FastifyReply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("Content-Security-Policy", csp)
      .send(index);
  app.get("/", page);
  for (const menu of MENUS) app.get(menu.path, page);
  for (const path of [
    "/notifications",
    "/talk/settings",
    "/approval/documents/:id",
    "/talk/rooms/:id",
    "/mail/messages/:id",
  ])
    app.get(path, page);
  app.get<{ Params: { file: string } }>(
    "/app-assets/:file",
    {
      schema: {
        params: {
          type: "object",
          required: ["file"],
          additionalProperties: false,
          properties: {
            file: {
              type: "string",
              maxLength: 128,
              pattern: "^[A-Za-z0-9_-]+\\.(?:js|css)$",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const asset = assets.get(request.params.file);
      if (!asset) throw new ApiError(404, "not_found", "Asset not found.");
      return reply.type(asset.type).send(asset.data);
    },
  );
}
