import { describe, expect, it, vi } from "vitest";
import { AuthSubscriptionReader } from "../../apps/server/src/notification-projection.js";

describe("read-only subscription source boundary (isolated transport)", () => {
  const tenant = "sample-a",
    origin = "https://jauth.jgw.test:54231";
  const credentials = async () => ({
    bearer: "unit-operator",
    serviceKey: "unit-console-key-0123456789",
  });
  it("reads only the fixed tenant GET API with server-owned operator credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ tenantId: tenant, services: ["j-groupware", "j-mail"] }),
    );
    const reader = new AuthSubscriptionReader({ origin, credentials, fetch });
    expect(
      (await reader.read(tenant, new AbortController().signal)).services,
    ).toEqual(["j-groupware", "j-mail"]);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe(origin + "/auth/tenants/sample-a/services");
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: "Bearer unit-operator",
        "X-JGW-Service-Key": "unit-console-key-0123456789",
      },
    });
    expect(new Headers(options?.headers).has("cookie")).toBe(false);
    await expect(
      reader.read("../operator", new AbortController().signal),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    Response.json({ tenantId: "sample-b", services: ["j-mail"] }),
    Response.json({ tenantId: tenant, services: ["j-mail", "j-mail"] }),
    Response.json({ tenantId: tenant, services: ["unknown"] }),
    Response.json({ tenantId: tenant, services: [], serviceKey: "private" }),
    new Response("private", { status: 403 }),
    new Response("x".repeat(16385), {
      headers: { "content-type": "application/json" },
    }),
  ])(
    "rejects unsafe or unavailable source responses without forwarding details",
    async (response) => {
      const reader = new AuthSubscriptionReader({
        origin,
        credentials,
        fetch: async () => response,
      });
      await expect(
        reader.read(tenant, new AbortController().signal),
      ).rejects.toMatchObject({
        status: 503,
        message: "Authentication or storage is unavailable.",
      });
    },
  );
  it("does not start network work after cancellation and bounds an uncooperative credential source", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const abort = new AbortController();
    abort.abort();
    const reader = new AuthSubscriptionReader({ origin, credentials, fetch });
    await expect(reader.read(tenant, abort.signal)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetch).not.toHaveBeenCalled();
    const stalled = new AuthSubscriptionReader({
      origin,
      credentials: () => new Promise(() => undefined),
      fetch,
    });
    const stop = new AbortController();
    const work = stalled.read(tenant, stop.signal);
    stop.abort();
    await expect(work).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    const during = new AbortController();
    const cancelled = new AuthSubscriptionReader({
      origin,
      fetch,
      credentials: async () => {
        during.abort();
        throw new Error("fixture credential failure");
      },
    });
    await expect(cancelled.read(tenant, during.signal)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
