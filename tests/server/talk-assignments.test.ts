import { it, expect, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { TalkAssignments } from "../../apps/server/src/talk-assignments.js";
import type { SessionRow } from "../../apps/server/src/db/sessions.js";

it("refuses to mint a fresh assignment grant after directory validation consumes its deadline", async () => {
  const now = Date.now(),
    member = randomUUID(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const store = new TalkAssignments("fixture", {
    origin: "https://auth.jgw.test",
    serviceKey: randomBytes(32).toString("base64url"),
    fetch: async () => {
      clock.mockReturnValue(now + 10000);
      return new Response(JSON.stringify({ id: member, username: "writer" }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const identity = {
    tenant_id: "fixture",
    subject: randomUUID(),
    sid: "fixture-session",
    access_token: "fixture-token",
    roles: ["talk:write"],
  } as SessionRow;
  try {
    await expect(
      store.authorize(identity, randomUUID(), member),
    ).rejects.toMatchObject({ status: 503 });
  } finally {
    clock.mockRestore();
  }
});
