import type { TenantServiceId } from "@j-auth/contracts";
import type { ServiceTokens } from "./service-tokens.js";
import { downstreamService } from "./service-tokens.js";
import { ApiError, unavailable } from "./errors.js";
import { Readable } from "node:stream";

export type ServiceEndpoints = Partial<Record<TenantServiceId, string>>;
export function serviceOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.port === "3001" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Downstream origin must be an explicit loopback service port.",
    );
  return url.origin;
}
// Only server-owned callers supply service/path. Public routes must separately enforce their contract and role.
export class ServiceClient {
  private readonly endpoints: ServiceEndpoints = {};
  constructor(
    private readonly tokens: ServiceTokens,
    endpoints: ServiceEndpoints,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    for (const [id, value] of Object.entries(endpoints)) {
      downstreamService(id);
      this.endpoints[id as TenantServiceId] = serviceOrigin(value);
    }
  }
  async request(
    session: string | undefined,
    service: TenantServiceId,
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      multipart?: { stream: Readable; boundary: string; bytes: number };
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    downstreamService(service);
    const origin = this.endpoints[service];
    if (!origin) throw unavailable();
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.includes("#")
    )
      throw new ApiError(400, "invalid_input", "Invalid service path.");
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password)
      throw new ApiError(400, "invalid_input", "Invalid service path.");
    options.signal?.throwIfAborted();
    if (
      options.multipart &&
      (options.body !== undefined ||
        !/^[A-Za-z0-9-]{1,70}$/.test(options.multipart.boundary) ||
        !Number.isSafeInteger(options.multipart.bytes) ||
        options.multipart.bytes < 1)
    )
      throw new ApiError(400, "invalid_input", "Invalid multipart request.");
    const token = await this.tokens.get(session, service, options.signal);
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);
    try {
      const init: RequestInit & { duplex?: "half" } = {
        method: options.method ?? "GET",
        redirect: "error",
        signal,
        headers: {
          Authorization: "Bearer " + token,
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(options.multipart
            ? {
                "Content-Type":
                  "multipart/form-data; boundary=" + options.multipart.boundary,
                "Content-Length": String(options.multipart.bytes),
              }
            : {}),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        ...(options.multipart
          ? {
              body: Readable.toWeb(
                options.multipart.stream,
              ) as ReadableStream<Uint8Array>,
              duplex: "half",
            }
          : {}),
      };
      return await this.fetch(url, init);
    } catch {
      options.signal?.throwIfAborted();
      throw unavailable();
    }
  }
}
