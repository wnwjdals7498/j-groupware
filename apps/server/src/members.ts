import {
  AUTH_API_PATHS,
  SERVICE_KEY_HEADER,
  SERVICE_CATALOG,
  IDENTITY_ROLES,
} from "@j-auth/contracts";
import type {
  CreateMemberRequest,
  MemberResponse,
  MemberListResponse,
  CustomerGrantableRoleName,
} from "@j-auth/contracts";
import type {
  GroupwareGrantableRoles,
  OrganizationMemberProfile,
} from "@j-groupware/contracts";
import type { Pool } from "pg";
import type { SessionStore, SessionRow } from "./db/sessions.js";
import { ApiError, unavailable } from "./errors.js";
import { OrganizationStore } from "./db/organization.js";

export interface MemberAuth {
  readonly origin: string;
  readonly serviceKey: string;
  readonly fetch?: typeof globalThis.fetch;
}
export function memberAuthOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".jgw.test") ||
    url.port === "3001" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Require the configured HTTPS j-auth origin.");
  return url.origin;
}
const roleNames = new Set<string>([
  ...Object.values(IDENTITY_ROLES),
  ...SERVICE_CATALOG.flatMap((service) =>
    service.roles.map((role) => role.name),
  ),
]);
const grantableDefinitions = SERVICE_CATALOG.flatMap((service) =>
  service.roles.map((role) => ({
    name: role.name,
    implies: [...role.implies] as string[],
    grantable: role.grantable,
  })),
).filter((role) => role.grantable);
function member(value: unknown): MemberResponse {
  const data = value as Partial<MemberResponse> | null;
  if (
    !data ||
    typeof data.id !== "string" ||
    !data.id ||
    data.id.length > 128 ||
    typeof data.username !== "string" ||
    !data.username ||
    data.username.length > 255 ||
    typeof data.enabled !== "boolean" ||
    !Array.isArray(data.roles) ||
    data.roles.some((role) => typeof role !== "string" || !roleNames.has(role))
  )
    throw unavailable();
  return {
    id: data.id,
    username: data.username,
    enabled: data.enabled,
    roles: [...new Set(data.roles)],
  };
}
export class Members {
  private readonly origin?: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly organization: OrganizationStore;
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
    private readonly sessions: SessionStore,
    private readonly auth?: MemberAuth,
  ) {
    this.fetch = auth?.fetch ?? globalThis.fetch;
    this.organization = new OrganizationStore(pool, tenant);
    if (auth) {
      this.origin = memberAuthOrigin(auth.origin);
      if (!auth.serviceKey || auth.serviceKey.startsWith("__PLACEHOLDER_"))
        throw new Error("Set the tenant service key externally.");
    }
  }
  private async call(
    identity: SessionRow,
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
    profileRead = false,
  ): Promise<unknown> {
    if (!this.origin || !this.auth) throw unavailable();
    if (
      identity.tenant_id !== this.tenant ||
      !(
        identity.roles.includes("member:manage") ||
        (profileRead && identity.roles.includes("org:manage"))
      )
    )
      throw new ApiError(403, "forbidden", "Permission denied.");
    signal?.throwIfAborted();
    const abort = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);
    let response: Response;
    try {
      response = await this.fetch(this.origin + path, {
        method,
        redirect: "error",
        signal: abort,
        headers: {
          Authorization: "Bearer " + identity.access_token,
          [SERVICE_KEY_HEADER]: this.auth.serviceKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      signal?.throwIfAborted();
      throw unavailable();
    }
    if (!response.ok) {
      await response.body?.cancel();
      const failures: Record<number, [string, string]> = {
        400: ["invalid_input", "Invalid member input."],
        403: ["forbidden", "Permission denied."],
        404: ["not_found", "Member not found."],
        409: ["conflict", "Member already exists."],
      };
      const failure = failures[response.status];
      if (failure) throw new ApiError(response.status, ...failure);
      throw new ApiError(
        503,
        "unavailable",
        "Member operation could not be confirmed. Check the member list before retrying.",
      );
    }
    const expected =
      method === "POST"
        ? 201
        : method === "DELETE" && !path.includes("/roles/")
          ? 204
          : 200;
    if (response.status !== expected) {
      await response.body?.cancel();
      throw unavailable();
    }
    if (response.status === 204) return undefined;
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 1048576) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(result.value);
      }
      signal?.throwIfAborted();
      return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    } catch {
      signal?.throwIfAborted();
      throw unavailable();
    }
  }
  async grantable(
    identity: SessionRow,
    signal?: AbortSignal,
  ): Promise<GroupwareGrantableRoles> {
    const response = (await this.call(
      identity,
      AUTH_API_PATHS.grantableRoles,
      "GET",
      undefined,
      signal,
    )) as { roles?: unknown } | null;
    if (!Array.isArray(response?.roles)) throw unavailable();
    const all = grantableDefinitions;
    const roles = response.roles.map((name) => {
      const definition = all.find((role) => role.name === name);
      if (!definition) throw unavailable();
      return { name: definition.name, implies: [...definition.implies] };
    });
    if (new Set(roles.map((role) => role.name)).size !== roles.length)
      throw unavailable();
    return { roles };
  }
  async list(
    identity: SessionRow,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<MemberListResponse> {
    const response = (await this.call(
      identity,
      AUTH_API_PATHS.members +
        (cursor ? "?" + new URLSearchParams({ cursor }) : ""),
      "GET",
      undefined,
      signal,
    )) as { items?: unknown; nextCursor?: unknown } | null;
    if (
      !Array.isArray(response?.items) ||
      response.items.length > 50 ||
      (response.nextCursor !== null &&
        (typeof response.nextCursor !== "string" ||
          !/^(0|[1-9][0-9]{0,5})$/.test(response.nextCursor)))
    )
      throw unavailable();
    return {
      items: response.items.map(member),
      nextCursor: response.nextCursor as string | null,
    };
  }
  async create(
    identity: SessionRow,
    input: CreateMemberRequest,
  ): Promise<MemberResponse> {
    const observedAt = await this.organization.observe();
    const created = member(
      await this.call(identity, AUTH_API_PATHS.members, "POST", input),
    );
    try {
      await this.organization.register(created, observedAt);
    } catch {
      throw new ApiError(
        503,
        "unavailable",
        "Member created, but organisation registration is incomplete. Check the member list before retrying.",
      );
    }
    return created;
  }
  async register(identity: SessionRow, id: string) {
    const observedAt = await this.organization.observe();
    const response = (await this.call(
      identity,
      AUTH_API_PATHS.member(id),
      "GET",
      undefined,
      undefined,
      true,
    )) as Partial<OrganizationMemberProfile> | null;
    if (
      !response ||
      response.id !== id ||
      typeof response.username !== "string" ||
      !response.username ||
      response.username.length > 255 ||
      typeof response.enabled !== "boolean"
    )
      throw unavailable();
    return this.organization.register(
      { id, username: response.username, enabled: response.enabled },
      observedAt,
    );
  }
  async role(
    identity: SessionRow,
    id: string,
    role: string,
    grant: boolean,
  ): Promise<MemberResponse> {
    try {
      if (!grantableDefinitions.some((definition) => definition.name === role))
        throw new Error();
    } catch {
      throw new ApiError(403, "forbidden", "Role is not grantable.");
    }
    let result: MemberResponse;
    try {
      result = member(
        await this.call(
          identity,
          AUTH_API_PATHS.memberRole(id, role as CustomerGrantableRoleName),
          grant ? "PUT" : "DELETE",
        ),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 503)
        await this.sessions.endMember(id);
      throw error;
    }
    try {
      await this.sessions.endMember(id);
    } catch {
      throw new ApiError(
        503,
        "unavailable",
        "Roles changed, but local session cleanup is incomplete. Check the member roles before retrying.",
      );
    }
    return result;
  }
  async remove(identity: SessionRow, id: string): Promise<void> {
    try {
      await this.call(identity, AUTH_API_PATHS.member(id), "DELETE");
    } catch (error) {
      if (error instanceof ApiError && error.status === 503)
        await this.sessions.endMember(id);
      if (error instanceof ApiError && error.status === 404) {
        const known = await this.pool.query(
          "SELECT 1 FROM organization_members WHERE tenant_id=$1 AND member_id=$2 UNION SELECT 1 FROM sessions WHERE tenant_id=$1 AND subject=$2 LIMIT 1",
          [this.tenant, id],
        );
        if (known.rowCount) {
          await this.sessions.endMember(id);
          await this.organization.removeMember(id);
        }
      }
      throw error;
    }
    try {
      await this.sessions.endMember(id);
      await this.organization.removeMember(id);
    } catch {
      throw new ApiError(
        503,
        "unavailable",
        "Member deleted, but local cleanup is incomplete. Check the member list before retrying.",
      );
    }
  }
}
