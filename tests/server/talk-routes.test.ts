import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  registerTalkRoutes,
  decodeTalkResponse,
} from "../../apps/server/src/talk-routes.js";
import { ApiError } from "../../apps/server/src/errors.js";
describe("bounded talk downstream projection", () => {
  it("keeps signed opaque site guest IDs readable without a customer-auth lookup", async () => {
    const roomId = "00000000-0000-4000-8000-000000000001",
      app = Fastify({ exposeHeadRoutes: false });
    let customerCalls = 0;
    registerTalkRoutes(
      app,
      {
        request: async (_session, service) => {
          if (service !== "j-talk") {
            customerCalls++;
            throw new Error(
              "Opaque website IDs must not be sent to customer-auth.",
            );
          }
          return new Response(
            JSON.stringify({
              id: roomId,
              status: "waiting",
              assignedMemberId: null,
              guestId: "signed-site-user-42",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      },
      () => true,
    );
    try {
      const response = await app.inject({ url: "/api/talk/rooms/" + roomId });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        guestId: "signed-site-user-42",
        guestName: null,
      });
      expect(customerCalls).toBe(0);
    } finally {
      await app.close();
    }
  });
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
  it("bounds name lookup concurrency and cancels every other lookup on a failed page", async () => {
    const ids = Array.from(
        { length: 12 },
        (_, index) =>
          "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
      ),
      app = Fastify({ exposeHeadRoutes: false }),
      release: (() => void)[] = [];
    let active = 0,
      maximum = 0,
      cancelled = 0,
      calls = 0;
    registerTalkRoutes(
      app,
      {
        request: async (_session, service, _path, options) => {
          if (service === "j-talk")
            return new Response(
              JSON.stringify({
                items: ids.map((id) => ({
                  id,
                  status: "waiting",
                  assignedMemberId: null,
                  guestId: id,
                  createdAt: "2026-10-08T00:00:00.000Z",
                })),
                next: null,
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          calls++;
          active++;
          maximum = Math.max(maximum, active);
          return new Promise<Response>((resolve, reject) => {
            const signal = options!.signal!;
            const abort = () => {
              active--;
              cancelled++;
              reject(new Error("Owned lookup aborted."));
            };
            signal.addEventListener("abort", abort, { once: true });
            release.push(() => {
              signal.removeEventListener("abort", abort);
              active--;
              resolve(new Response("private upstream token", { status: 503 }));
            });
          });
        },
      },
      () => true,
    );
    try {
      const response = app.inject({ url: "/api/talk/rooms?limit=100" });
      for (let i = 0; i < 100 && calls < 4; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(calls).toBe(4);
      expect(maximum).toBe(4);
      release[0]!();
      const result = await response;
      expect(result.statusCode).toBe(503);
      expect(result.body).not.toContain("private upstream token");
      expect(calls).toBe(4);
      expect(active).toBe(0);
      expect(cancelled).toBe(3);
    } finally {
      await app.close();
    }
  });
});
