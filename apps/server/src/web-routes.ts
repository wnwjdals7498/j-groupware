import type { FastifyInstance, FastifyRequest } from "fastify";
import { CONTENT_LIMITS, WEB_PATHS, isSiteDomain } from "@j-web/contracts";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { cookieValue } from "./security.js";
import { ApiError, unavailable } from "./errors.js";
import type { ServiceClient } from "./services.js";
const uuidPattern = "^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$";
const uuid = { type: "string", pattern: uuidPattern };
const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: uuid },
};
const empty = { type: "object", additionalProperties: false };
const page = {
  ...empty,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    after: uuid,
  },
};
const logo = {
  anyOf: [
    { type: "null" },
    {
      ...empty,
      required: ["mimeType", "base64"],
      properties: {
        mimeType: { const: "image/png" },
        base64: { type: "string", maxLength: 1398104 },
      },
    },
  ],
};
const contentSchema = {
  ...empty,
  required: ["name", "introduction", "contact", "logo"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: CONTENT_LIMITS.name },
    introduction: { type: "string", maxLength: CONTENT_LIMITS.introduction },
    contact: { type: "string", maxLength: CONTENT_LIMITS.contact },
    logo,
  },
};
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw unavailable();
  return v as Record<string, unknown>;
};
const text = (v: unknown, max: number) => {
  if (typeof v !== "string" || v.length > max) throw unavailable();
  return v;
};
const id = (v: unknown) => {
  const s = text(v, 36);
  if (!new RegExp(uuidPattern).test(s)) throw unavailable();
  return s;
};
const bytes = (v: unknown) => {
  const s = text(v, 24);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw unavailable();
  return s;
};
const account = (v: unknown) => {
  const s = text(v, 28);
  if (!/^jw-[a-z0-9]{4,24}$/.test(s)) throw unavailable();
  return s;
};
function site(v: unknown, tenant: string) {
  const r = record(v),
    domain = text(r.domain, 253),
    state = text(r.state, 16);
  if (
    !isSiteDomain(domain, tenant) ||
    !["creating", "active", "deleting", "failed"].includes(state)
  )
    throw unavailable();
  return { id: id(r.id), domain, state };
}
function hosting(v: unknown, tenant: string) {
  const r = record(v),
    s = site(r, tenant),
    disk = record(r.disk),
    sftp = record(r.sftp),
    ftps = record(r.ftps),
    dns = record(r.dns);
  const a = r.account === null ? null : account(r.account),
    phase = text(r.phase, 32),
    error = r.error === null ? null : text(r.error, 64);
  if (
    ![
      "unmanaged",
      "site_create",
      "account_create",
      "nginx_apply",
      "active",
      "delete",
      "failed",
    ].includes(phase) ||
    (error !== null && !/^[a-z0-9_]{1,64}$/.test(error)) ||
    r.origin !== "https://" + s.domain ||
    sftp.port !== 2222 ||
    sftp.account !== a ||
    ftps.port !== 21 ||
    ftps.account !== a ||
    JSON.stringify(ftps.passivePorts) !== "[56110,56119]" ||
    dns.type !== "A" ||
    dns.name !== s.domain
  )
    throw unavailable();
  const address = ipv4(dns.address);
  return {
    ...s,
    account: a,
    phase,
    error,
    usedBytes: r.usedBytes === null ? null : bytes(r.usedBytes),
    disk: {
      filesystem: text(disk.filesystem, 128),
      totalBytes: bytes(disk.totalBytes),
      availableBytes: bytes(disk.availableBytes),
    },
    origin: r.origin,
    sftp: { port: 2222, account: a },
    ftps: { port: 21, passivePorts: [56110, 56119], account: a },
    dns: { type: "A", name: s.domain, address },
  };
}
function ipv4(v: unknown) {
  if (v === null) return null;
  const s = text(v, 15);
  if (
    s.split(".").length !== 4 ||
    s
      .split(".")
      .some((n) => !/^(0|[1-9][0-9]{0,2})$/.test(n) || Number(n) > 255)
  )
    throw unavailable();
  return s;
}
function content(v: unknown) {
  if (v === null) return null;
  const r = record(v),
    l = r.logo === null ? null : record(r.logo);
  const result = {
    name: text(r.name, CONTENT_LIMITS.name),
    introduction: text(r.introduction, CONTENT_LIMITS.introduction),
    contact: text(r.contact, CONTENT_LIMITS.contact),
    logo: l
      ? { mimeType: text(l.mimeType, 32), base64: text(l.base64, 1398104) }
      : null,
  };
  if (
    result.logo &&
    (result.logo.mimeType !== "image/png" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(result.logo.base64))
  )
    throw unavailable();
  return result;
}
export async function decodeWebResponse<T>(
  response: Response,
  expected: number,
  map: (v: unknown) => T,
): Promise<T> {
  if (response.status !== expected) {
    await response.body?.cancel();
    const errors: Record<number, [string, string]> = {
      400: ["invalid_input", "Invalid web request."],
      401: ["unauthenticated", "Web authentication failed."],
      403: ["forbidden", "Permission denied."],
      404: ["not_found", "Site not found."],
      409: ["conflict", "Site or content changed."],
      413: ["invalid_input", "Content is too large."],
    };
    if (errors[response.status])
      throw new ApiError(response.status, ...errors[response.status]!);
    throw unavailable();
  }
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    throw unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw unavailable();
      chunks.push(value);
    }
    return map(JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    await reader.cancel().catch(() => undefined);
    throw unavailable();
  } finally {
    reader.releaseLock();
  }
}
export function registerWebRoutes(
  app: FastifyInstance,
  services: Pick<ServiceClient, "request">,
  tenant: string,
) {
  const base = "/api/web/sites";
  const call = (
    r: FastifyRequest,
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: unknown,
  ) =>
    services.request(
      cookieValue(r.headers.cookie, SESSION_POLICY.cookie),
      "j-web",
      path,
      { method, ...(body === undefined ? {} : { body }) },
    );
  for (const [suffix, map] of [
    ["", site],
    ["/hosting", hosting],
  ] as const)
    app.get<{ Querystring: { limit: number; after?: string } }>(
      base + suffix,
      { schema: { querystring: page } },
      async (r) => {
        const q = new URLSearchParams({ limit: String(r.query.limit) });
        if (r.query.after) q.set("after", r.query.after);
        return decodeWebResponse(
          await call(r, WEB_PATHS.sites + suffix + "?" + q),
          200,
          (v) => {
            const row = record(v);
            if (!Array.isArray(row.items) || row.items.length > r.query.limit)
              throw unavailable();
            return {
              items: row.items.map((item) => map(item, tenant)),
              next: row.next === null ? null : id(row.next),
            };
          },
        );
      },
    );
  for (const [suffix, map] of [
    ["", site],
    ["/hosting", hosting],
  ] as const)
    app.get<{ Params: { id: string } }>(
      base + "/:id" + suffix,
      { schema: { params, querystring: empty } },
      async (r) =>
        decodeWebResponse(
          await call(r, WEB_PATHS.sites + "/" + r.params.id + suffix),
          200,
          (v) => {
            const result = map(v, tenant);
            if (result.id !== r.params.id) throw unavailable();
            return result;
          },
        ),
    );
  app.get<{ Params: { id: string } }>(
    base + "/:id/dns",
    { schema: { params, querystring: empty } },
    async (r) =>
      decodeWebResponse(
        await call(r, WEB_PATHS.sites + "/" + r.params.id + "/dns"),
        200,
        (v) => {
          const row = record(v),
            name = text(row.name, 253),
            address = ipv4(row.address);
          if (
            row.type !== "A" ||
            !isSiteDomain(name, tenant) ||
            row.guidance !== "DNS는 등록처·DNS 서비스에서 별도 관리합니다." ||
            row.hostsEntry !== (address ? address + " " + name : null)
          )
            throw unavailable();
          return {
            type: "A",
            name,
            address,
            guidance: row.guidance,
            hostsEntry: row.hostsEntry,
          };
        },
      ),
  );
  const mapContent = (v: unknown, siteId: string) => {
    const row = record(v);
    if (
      row.siteId !== siteId ||
      !Number.isInteger(row.revision) ||
      Number(row.revision) < 0 ||
      Number(row.revision) > 2147483647 ||
      (row.revision === 0) !== (row.content === null)
    )
      throw unavailable();
    return { siteId, revision: row.revision, content: content(row.content) };
  };
  app.get<{ Params: { id: string } }>(
    base + "/:id/content",
    { schema: { params, querystring: empty } },
    async (r) =>
      decodeWebResponse(
        await call(r, WEB_PATHS.sites + "/" + r.params.id + "/content"),
        200,
        (v) => mapContent(v, r.params.id),
      ),
  );
  app.put<{ Params: { id: string }; Body: unknown }>(
    base + "/:id/content",
    {
      bodyLimit: 1500000,
      schema: {
        params,
        querystring: empty,
        body: {
          ...empty,
          required: ["expectedRevision", "content"],
          properties: {
            expectedRevision: {
              type: "integer",
              minimum: 0,
              maximum: 2147483646,
            },
            content: contentSchema,
          },
        },
      },
    },
    async (r) =>
      decodeWebResponse(
        await call(
          r,
          WEB_PATHS.sites + "/" + r.params.id + "/content",
          "PUT",
          r.body,
        ),
        200,
        (v) => mapContent(v, r.params.id),
      ),
  );
  app.post<{ Params: { id: string }; Body: unknown }>(
    base + "/:id/preview",
    {
      bodyLimit: 1500000,
      schema: {
        params,
        querystring: empty,
        body: {
          ...empty,
          required: ["content"],
          properties: { content: contentSchema },
        },
      },
    },
    async (r) =>
      decodeWebResponse(
        await call(
          r,
          WEB_PATHS.sites + "/" + r.params.id + "/preview",
          "POST",
          r.body,
        ),
        200,
        (v) => {
          const row = record(v),
            origin = text(row.origin, 261),
            html = text(row.html, 1600000),
            widgetSnippet = text(row.widgetSnippet, 256);
          if (
            row.siteId !== r.params.id ||
            !origin.startsWith("https://") ||
            !isSiteDomain(origin.slice(8), tenant) ||
            widgetSnippet !==
              `<script src="https://gw.${tenant}.jgw.test/ext/talk/v1/widget.min.js" async></script>` ||
            !html.startsWith("<!doctype html>") ||
            !html.includes("script-src 'none'")
          )
            throw unavailable();
          return { siteId: r.params.id, origin, html, widgetSnippet };
        },
      ),
  );
  const password = { type: "string", minLength: 12, maxLength: 256 };
  const mapPassword = (v: unknown) => {
    const r = record(v);
    return {
      id: id(r.id),
      account: account(r.account),
      password: text(r.password, 256),
    };
  };
  app.post<{ Body: { domain: string; password?: string } }>(
    base,
    {
      schema: {
        querystring: empty,
        body: {
          ...empty,
          required: ["domain"],
          properties: { domain: { type: "string", maxLength: 253 }, password },
        },
      },
    },
    async (r, reply) => {
      const result = await decodeWebResponse(
        await call(r, WEB_PATHS.sites, "POST", r.body),
        201,
        (v) => ({ ...site(v, tenant), ...mapPassword(v) }),
      );
      reply.code(201);
      return result;
    },
  );
  for (const suffix of ["retry", "account-password"])
    app.post<{ Params: { id: string }; Body: { password?: string } }>(
      base + "/:id/" + suffix,
      {
        schema: {
          params,
          querystring: empty,
          body: { ...empty, properties: { password } },
        },
      },
      async (r) =>
        decodeWebResponse(
          await call(
            r,
            WEB_PATHS.sites + "/" + r.params.id + "/" + suffix,
            "POST",
            r.body,
          ),
          200,
          (v) => {
            const result =
              suffix === "retry"
                ? { ...site(v, tenant), ...mapPassword(v) }
                : mapPassword(v);
            if (result.id !== r.params.id) throw unavailable();
            return result;
          },
        ),
    );
  app.delete<{ Params: { id: string } }>(
    base + "/:id",
    { schema: { params, querystring: empty } },
    async (r) =>
      decodeWebResponse(
        await call(r, WEB_PATHS.sites + "/" + r.params.id, "DELETE"),
        200,
        (v) => {
          const row = record(v),
            backupId = text(row.backupId, 73);
          if (
            row.id !== r.params.id ||
            !new RegExp(
              uuidPattern.slice(0, -1) + "-" + uuidPattern.slice(1),
            ).test(backupId)
          )
            throw unavailable();
          return { id: r.params.id, backupId };
        },
      ),
  );
}
