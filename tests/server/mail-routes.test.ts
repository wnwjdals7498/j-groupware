import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerMailRoutes } from "../../apps/server/src/mail-routes.js";
import { ApiError } from "../../apps/server/src/errors.js";
import { MAIL_LIMITS } from "@j-mail/contracts";
const id = "A".repeat(22),
  summary = {
    id,
    from: { name: "", address: "a@sample-a.jgw.test" },
    to: [],
    cc: [],
    bcc: [],
    subject: "fixture",
    receivedAt: "2026-10-08T12:00:00.000Z",
  };
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
async function run(response: () => Response, path = "/api/mail/messages") {
  const app = Fastify({
      exposeHeadRoutes: false,
      ajv: { customOptions: { removeAdditional: false } },
    }),
    calls: { service: string; path: string; session: string | undefined }[] =
      [];
  app.setErrorHandler((e, _r, reply) =>
    reply
      .code(e instanceof ApiError ? e.status : 400)
      .send({ code: e instanceof ApiError ? e.code : "invalid_input" }),
  );
  registerMailRoutes(app, {
    request: async (session, service, path) => {
      calls.push({ session, service, path });
      return response();
    },
  });
  try {
    return {
      response: await app.inject({
        url: path,
        headers: { Cookie: "__Host-jgw-session=" + "x".repeat(43) },
      }),
      calls,
    };
  } finally {
    await app.close();
  }
}
describe("mail BFF trusted routes and bounded response projection", () => {
  it("uses fixed j-mail path/session and strips native or sensitive fields", async () => {
    const r = await run(() =>
      json({
        items: [{ ...summary, token: "private" }],
        total: 1,
        offset: 0,
        limit: 20,
        secret: "private",
      }),
    );
    expect(r.response.statusCode).toBe(200);
    expect(r.calls).toEqual([
      {
        service: "j-mail",
        path: "/mail/messages?offset=0&limit=20",
        session: "x".repeat(43),
      },
    ]);
    expect(r.response.body).not.toContain("private");
  });
  it("rejects tenant/url injection and invalid paging before any service call", async () => {
    for (const path of [
      "/api/mail/messages?tenant=sample-b",
      "/api/mail/messages?url=http://example.invalid",
      "/api/mail/messages?limit=101",
      "/api/mail/messages/invalid",
      "/api/mail/messages/" + id + "?tenant=sample-b",
    ]) {
      const r = await run(() => json({}), path);
      expect(r.response.statusCode).toBe(400);
      expect(r.calls).toHaveLength(0);
    }
  });
  it("maps safe errors and never relays upstream error bodies", async () => {
    for (const code of [400, 401, 403, 404, 500, 503]) {
      const r = await run(
        () => new Response("upstream-private", { status: code }),
      );
      expect(r.response.statusCode).toBe(code < 500 ? code : 503);
      expect(r.response.body).not.toContain("upstream-private");
    }
  });
  it("rejects inconsistent pages, non-JSON and excess bodies", async () => {
    for (const make of [
      () => json({ items: [], total: 1, offset: 0, limit: 20 }),
      () => json({ items: [], total: 0, offset: 1, limit: 20 }),
      () => new Response("private"),
      () =>
        new Response("x".repeat(MAIL_LIMITS.response + 1), {
          headers: { "content-type": "application/json" },
        }),
    ])
      expect((await run(make)).response.statusCode).toBe(503);
  });
  it("returns untrusted HTML as JSON and refuses a different detail id", async () => {
    const detail = {
      ...summary,
      headers: { Received: ["fixture"] },
      html: "<script>untrusted()</script>",
      text: "fixture",
      secret: "private",
    };
    const r = await run(() => json(detail), "/api/mail/messages/" + id);
    expect(r.response.statusCode).toBe(200);
    expect(r.response.headers["content-type"]).toContain("application/json");
    expect(r.response.json().html).toContain("<script>");
    expect(r.response.body).not.toContain("private");
    expect(
      (
        await run(
          () => json({ ...detail, id: "B".repeat(22) }),
          "/api/mail/messages/" + id,
        )
      ).response.statusCode,
    ).toBe(503);
  });
});
