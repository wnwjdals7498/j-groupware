import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerMessengerRoutes } from "../../apps/server/src/messenger-routes.js";
import type { ServiceClient } from "../../apps/server/src/services.js";
import type { SessionRow } from "../../apps/server/src/db/sessions.js";

describe("messenger BFF response boundary (isolated transport)", () => {
  async function run(response: Response, path = "/me") {
    const app = Fastify();
    const request = vi.fn<ServiceClient["request"]>(async () => response);
    registerMessengerRoutes(
      app,
      { request } as unknown as ServiceClient,
      () => ({ tenant_id: "sample-a" }) as SessionRow,
    );
    try {
      const result = await app.inject({ url: "/api/messenger/api/v1" + path });
      return { result, request };
    } finally {
      await app.close();
    }
  }
  const me = {
    data: {
      id: "1",
      serverId: "sample-a",
      displayName: "회원",
      enabledFeatures: { receipts: true, files: true },
      access_token: "private",
      credential: "private",
    },
    refresh_token: "private",
  };
  it("projects only documented fields and ignores downstream cookies/credentials", async () => {
    const { result, request } = await run(
      Response.json(me, { headers: { "set-cookie": "jm_session=private" } }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.json()).toEqual({
      data: {
        id: "1",
        serverId: "sample-a",
        displayName: "회원",
        enabledFeatures: {
          receipts: true,
          files: false,
          retention: false,
          notifications: false,
          nativeSessions: false,
          developmentAuth: false,
          adminRetention: false,
        },
      },
    });
    expect(request.mock.calls[0]?.[2]).toBe("/api/v1/me");
  });
  it("rejects a downstream tenant mismatch", async () => {
    const { result } = await run(
      Response.json({ ...me, data: { ...me.data, serverId: "sample-b" } }),
    );
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe("unavailable");
  });
  it.each([
    new Response("<html>private</html>", {
      headers: { "content-type": "text/html" },
    }),
    new Response("x".repeat(1048577), {
      headers: { "content-type": "application/json" },
    }),
    new Response('{"data":', {
      headers: { "content-type": "application/json" },
    }),
    Response.json({ data: { ...me.data, id: "9223372036854775808" } }),
    new Response("private", {
      status: 302,
      headers: { location: "https://outside.test" },
    }),
    Response.json(
      { error: { code: "internal", message: "private" } },
      { status: 500 },
    ),
  ])("bounds and sanitizes invalid downstream responses", async (response) => {
    const { result } = await run(response);
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("private");
    expect(result.json().error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("allows only known expiry codes and replaces downstream error details", async () => {
    const allowed = await run(
      Response.json(
        {
          error: {
            code: "sync_reset_required",
            message: "private",
            requestId: "private",
          },
        },
        { status: 410 },
      ),
      "/sync?after=opaque",
    );
    expect(allowed.result.statusCode).toBe(410);
    expect(allowed.result.json().error.code).toBe("sync_reset_required");
    expect(allowed.result.body).not.toContain("private");
    const rejected = await run(
      Response.json(
        { error: { code: "other", message: "private" } },
        { status: 410 },
      ),
    );
    expect(rejected.result.statusCode).toBe(503);
  });
});
