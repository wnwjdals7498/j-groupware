import { it, expect } from "vitest";
import Fastify from "fastify";
import {
  decodeWebResponse,
  registerWebRoutes,
} from "../../apps/server/src/web-routes.js";
import { ApiError } from "../../apps/server/src/errors.js";
const siteId = "a6668888-1111-2222-3333-444455556666";
it("bounds actual streamed responses and refuses redirects/non-JSON instead of exposing downstream secrets", async () => {
  for (const response of [
    new Response("private-secret", {
      status: 302,
      headers: { Location: "https://example.test" },
    }),
    new Response("private-secret", {
      headers: { "Content-Type": "text/html" },
    }),
    new Response("x".repeat(2 * 1024 * 1024 + 1), {
      headers: { "Content-Type": "application/json" },
    }),
  ])
    await expect(
      decodeWebResponse(response, 200, (v) => v),
    ).rejects.toMatchObject({ status: 503, code: "unavailable" });
  await expect(
    decodeWebResponse(
      new Response("private-secret", { status: 409 }),
      200,
      (v) => v,
    ),
  ).rejects.toMatchObject({ status: 409, code: "conflict" });
});
it("projects only fixed list fields and rejects malformed paging output", async () => {
  let mode = "valid";
  const app = Fastify();
  app.setErrorHandler((error, _, reply) =>
    reply
      .code(error instanceof ApiError ? error.status : 503)
      .send({ code: error instanceof ApiError ? error.code : "unavailable" }),
  );
  registerWebRoutes(
    app,
    {
      request: async () =>
        Response.json({
          items: [
            {
              id: siteId,
              domain: "site.jgw.test",
              state: mode === "valid" ? "active" : "claimed_ready",
              password: "private-secret",
              path: "/srv/jweb/private",
            },
          ],
          next: null,
        }),
    },
    "route-fixture",
  );
  try {
    const first = await app.inject({ method: "GET", url: "/api/web/sites" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      items: [{ id: siteId, domain: "site.jgw.test", state: "active" }],
      next: null,
    });
    mode = "invalid";
    expect(
      (await app.inject({ method: "GET", url: "/api/web/sites" })).statusCode,
    ).toBe(503);
  } finally {
    await app.close();
  }
});
it("refuses arbitrary queries, malformed ids and extra content fields before invoking the service", async () => {
  let calls = 0;
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  registerWebRoutes(
    app,
    {
      request: async () => {
        calls++;
        return Response.json({});
      },
    },
    "route-fixture",
  );
  try {
    for (const request of [
      { method: "GET" as const, url: "/api/web/sites?path=/etc" },
      { method: "GET" as const, url: "/api/web/sites/invalid/content" },
      {
        method: "PUT" as const,
        url: `/api/web/sites/${siteId}/content`,
        payload: {
          expectedRevision: 0,
          content: {
            name: "Site",
            introduction: "",
            contact: "",
            logo: null,
            path: "/etc",
          },
        },
      },
    ])
      expect((await app.inject(request)).statusCode).toBe(400);
    expect(calls).toBe(0);
  } finally {
    await app.close();
  }
});
