import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  registerTalkRoutes,
  decodeTalkResponse,
} from "../../apps/server/src/talk-routes.js";
import { ApiError } from "../../apps/server/src/errors.js";
describe("bounded talk downstream projection", () => {
  it("strips unknown private fields from a room response", async () => {
    const id = "00000000-0000-4000-8000-000000000001",
      app = Fastify({ exposeHeadRoutes: false });
    registerTalkRoutes(app, {
      request: async () =>
        new Response(
          JSON.stringify({
            id,
            status: "waiting",
            assignedMemberId: null,
            guestId: null,
            token: "private",
            tenant_id: "private",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });
    try {
      const r = await app.inject({ url: "/api/talk/rooms/" + id });
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain("private");
    } finally {
      await app.close();
    }
  });
  it("cancels oversized downstream streams and rejects redirect/error bodies without reflecting secrets", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1048577));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      decodeTalkResponse(
        new Response(stream, {
          headers: { "Content-Type": "application/json" },
        }),
        200,
        (v) => v,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(cancelled).toBe(true);
    for (const status of [302, 500, 401, 409, 429])
      try {
        await decodeTalkResponse(
          new Response("private-token", { status }),
          200,
          (v) => v,
        );
        throw new Error("Must fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect(String(error)).not.toContain("private-token");
      }
  });
});
