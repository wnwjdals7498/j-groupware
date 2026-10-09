import { createHmac, randomUUID } from "node:crypto";
import { SERVICE_KEY_HEADER } from "@j-auth/contracts";
import {
  TALK_ASSIGNMENT_KEY_CONTEXT,
  TALK_ASSIGNMENT_TTL_SECONDS,
  TALK_UUID_PATTERN,
} from "@j-talk/contracts";
import type { TalkAssignee, TalkAssigneePage } from "@j-talk/contracts";
import type { SessionRow } from "./db/sessions.js";
import type { MemberAuth } from "./members.js";
import { memberAuthOrigin } from "./members.js";
import { ApiError, unavailable } from "./errors.js";
import { decodeTalkResponse } from "./talk-routes.js";

function candidate(value: unknown): TalkAssignee {
  const data = value as Partial<TalkAssignee> | null;
  if (
    !data ||
    typeof data.id !== "string" ||
    !new RegExp(TALK_UUID_PATTERN).test(data.id) ||
    typeof data.username !== "string" ||
    !data.username ||
    data.username.length > 255
  )
    throw unavailable();
  return { id: data.id, username: data.username };
}
export class TalkAssignments {
  private readonly origin?: string;
  private readonly key?: Buffer;
  constructor(
    private tenant: string,
    private auth?: MemberAuth,
  ) {
    if (auth) {
      this.origin = memberAuthOrigin(auth.origin);
      if (!/^[A-Za-z0-9_-]{43}$/.test(auth.serviceKey))
        throw new Error("Private tenant service key required.");
      this.key = createHmac("sha256", Buffer.from(auth.serviceKey, "base64url"))
        .update(TALK_ASSIGNMENT_KEY_CONTEXT + tenant)
        .digest();
    }
  }
  private async call(identity: SessionRow, suffix: string) {
    if (!this.auth || !this.origin) throw unavailable();
    if (
      identity.tenant_id !== this.tenant ||
      !identity.roles.includes("talk:write")
    )
      throw new ApiError(403, "forbidden", "Permission denied.");
    let response: Response;
    try {
      response = await (this.auth.fetch ?? globalThis.fetch)(
        this.origin + "/auth/talk/assignees" + suffix,
        {
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: "Bearer " + identity.access_token,
            [SERVICE_KEY_HEADER]: this.auth.serviceKey,
          },
        },
      );
    } catch {
      throw unavailable();
    }
    return response;
  }
  async list(identity: SessionRow, cursor?: string): Promise<TalkAssigneePage> {
    return decodeTalkResponse(
      await this.call(
        identity,
        cursor === undefined ? "" : "?cursor=" + cursor,
      ),
      200,
      (value) => {
        const data = value as Partial<TalkAssigneePage> | null;
        if (
          !data ||
          !Array.isArray(data.items) ||
          data.items.length > 50 ||
          !(
            data.nextCursor === null ||
            (typeof data.nextCursor === "string" &&
              /^(0|[1-9][0-9]{0,5})$/.test(data.nextCursor))
          )
        )
          throw unavailable();
        const items = data.items.map(candidate);
        if (new Set(items.map((item) => item.id)).size !== items.length)
          throw unavailable();
        return { items, nextCursor: data.nextCursor };
      },
    );
  }
  async authorize(identity: SessionRow, room: string, member: string) {
    // The deadline includes the directory round trip; delayed validation cannot mint a fresh window.
    const iat = Math.floor(Date.now() / 1000);
    const verified = await decodeTalkResponse(
      await this.call(identity, "/" + member),
      200,
      candidate,
    );
    if (
      verified.id !== member ||
      !this.key ||
      Math.floor(Date.now() / 1000) >= iat + TALK_ASSIGNMENT_TTL_SECONDS
    )
      throw unavailable();
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        tenant: this.tenant,
        room,
        member,
        actor: identity.subject,
        sid: identity.sid,
        iat,
        exp: iat + TALK_ASSIGNMENT_TTL_SECONDS,
        nonce: randomUUID(),
      }),
    ).toString("base64url");
    return {
      memberId: member,
      authorization:
        payload +
        "." +
        createHmac("sha256", this.key).update(payload).digest("base64url"),
    };
  }
}
