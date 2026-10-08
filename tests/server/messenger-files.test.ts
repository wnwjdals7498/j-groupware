import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import { registerMessengerRoutes } from "../../apps/server/src/messenger-routes.js";
import type { ServiceClient } from "../../apps/server/src/services.js";
import type { SessionRow } from "../../apps/server/src/db/sessions.js";

describe("messenger attachment response and multipart boundaries", () => {
  const id = randomUUID();
  const descriptor = {
    id,
    filename: "test.txt",
    contentType: "text/plain",
    sizeBytes: 3,
    status: "ready",
  };
  const input = (extra = "") =>
    Buffer.from(
      '--test\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nabc\r\n' +
        extra +
        "--test--\r\n",
    );
  async function app(response: Response) {
    const server = Fastify();
    const request = vi.fn<ServiceClient["request"]>(async () => response);
    registerMessengerRoutes(
      server,
      { request } as unknown as ServiceClient,
      () => ({ tenant_id: "test" }) as SessionRow,
    );
    await server.ready();
    return { server, request };
  }
  it("projects the file descriptor and clears private spool files after upload", async () => {
    const before = (await readdir(tmpdir()))
      .filter((x) => x.startsWith("jgw-messenger-upload-"))
      .sort();
    const { server, request } = await app(
      Response.json(
        { data: { ...descriptor, path: "private", token: "private" } },
        { status: 201, headers: { "set-cookie": "private" } },
      ),
    );
    try {
      const result = await server.inject({
        method: "POST",
        url: "/api/messenger/api/v1/conversations/1/files",
        headers: { "content-type": "multipart/form-data; boundary=test" },
        payload: input(),
      });
      expect(result.statusCode).toBe(201);
      expect(result.json()).toEqual({ data: descriptor });
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(request.mock.calls[0]?.[2]).toBe("/api/v1/conversations/1/files");
      expect(request.mock.calls[0]?.[3]?.multipart?.bytes).toBeGreaterThan(3);
      expect(
        (await readdir(tmpdir()))
          .filter((x) => x.startsWith("jgw-messenger-upload-"))
          .sort(),
      ).toEqual(before);
    } finally {
      await server.close();
    }
  });
  it("rejects additional form fields before any downstream write", async () => {
    const { server, request } = await app(
      Response.json({ data: descriptor }, { status: 201 }),
    );
    try {
      const result = await server.inject({
        method: "POST",
        url: "/api/messenger/api/v1/conversations/1/files",
        headers: { "content-type": "multipart/form-data; boundary=test" },
        payload: input(
          '--test\r\nContent-Disposition: form-data; name="tenant"\r\n\r\nother\r\n',
        ),
      });
      expect(result.statusCode).toBe(413);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  it("forces safe attachment headers and ignores downstream cookies and executable MIME", async () => {
    const { server } = await app(
      new Response("abc", {
        headers: {
          "content-type": "text/html",
          "content-disposition": "attachment; filename*=UTF-8''test.txt",
          "set-cookie": "private",
        },
      }),
    );
    try {
      const result = await server.inject({
        url: `/api/messenger/api/v1/files/${id}/content`,
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe("abc");
      expect(result.headers["content-type"]).toBe("application/octet-stream");
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
      expect(result.headers["set-cookie"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });
  it("rejects malformed disposition and oversized declared download without exposing downstream details", async () => {
    for (const headers of [
      { "content-disposition": "inline; filename=private" },
      {
        "content-disposition": "attachment; filename*=UTF-8''test.txt",
        "content-length": "5000001",
      },
    ]) {
      const { server } = await app(new Response("private", { headers }));
      try {
        const result = await server.inject({
          url: `/api/messenger/api/v1/files/${id}/content`,
        });
        expect(result.statusCode).toBe(503);
        expect(result.body).not.toContain("private");
      } finally {
        await server.close();
      }
    }
  });
});
