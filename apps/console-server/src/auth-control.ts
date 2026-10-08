import {
  AUTH_API_PATHS,
  assertCustomerTenantId,
  SERVICE_CATALOG,
} from "@j-auth/contracts";
import type {
  CreateTenantRequest,
  CreateTenantResponse,
  TenantServicesResponse,
  OptionalTenantServiceId,
} from "@j-auth/contracts";
import { ApiError, unavailable } from "@j-groupware/bff-auth";
export interface AuthControl {
  create(
    token: string,
    input: CreateTenantRequest,
  ): Promise<CreateTenantResponse>;
  services(token: string, tenant: string): Promise<TenantServicesResponse>;
  change(
    token: string,
    tenant: string,
    service: string,
    enabled: boolean,
  ): Promise<TenantServicesResponse>;
  rotate(token: string, tenant: string): Promise<CreateTenantResponse>;
}
export class AuthControlClient implements AuthControl {
  private origin: string;
  constructor(
    origin: string,
    private key: string,
    private fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      !["auth.jgw.test", "jauth.jgw.test"].includes(url.hostname) ||
      url.port === "3001" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !key ||
      key.length > 1024 ||
      /[\r\n]/.test(key)
    )
      throw new Error("Fixed auth control origin/key required.");
    this.origin = url.origin;
  }
  private async request(
    token: string,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    let response: Response;
    try {
      response = await this.fetch(this.origin + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: "Bearer " + token,
          "X-JGW-Service-Key": this.key,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      await response.body?.cancel();
      const statuses: Record<number, [string, string]> = {
        400: ["invalid_input", "Invalid auth request."],
        401: ["unauthenticated", "Auth control authentication failed."],
        403: ["forbidden", "Permission denied."],
        404: ["not_found", "Tenant not found."],
        409: ["conflict", "Tenant already exists."],
      };
      const e = statuses[response.status];
      if (e) throw new ApiError(response.status, ...e);
      throw unavailable();
    }
    if (!response.headers.get("content-type")?.startsWith("application/json")) {
      await response.body?.cancel();
      throw unavailable();
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const chunks: Uint8Array[] = [];
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > 32768) throw unavailable();
        chunks.push(value);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw unavailable();
      return result as Record<string, unknown>;
    } catch {
      await reader.cancel().catch(() => undefined);
      throw unavailable();
    } finally {
      reader.releaseLock();
    }
  }
  async create(token: string, input: CreateTenantRequest) {
    assertCustomerTenantId(input.tenantId);
    const row = await this.request(
      token,
      AUTH_API_PATHS.tenants,
      "POST",
      input,
    );
    return this.bootstrap(row);
  }
  private bootstrap(row: Record<string, unknown>) {
    if (
      typeof row.clientSecret !== "string" ||
      !row.clientSecret ||
      row.clientSecret.length > 256 ||
      /[\r\n]/.test(row.clientSecret) ||
      typeof row.serviceKey !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(row.serviceKey)
    )
      throw unavailable();
    return { clientSecret: row.clientSecret, serviceKey: row.serviceKey };
  }
  async rotate(token: string, tenant: string) {
    assertCustomerTenantId(tenant);
    return this.bootstrap(
      await this.request(
        token,
        AUTH_API_PATHS.rotateSecrets(tenant),
        "POST",
        {},
      ),
    );
  }
  private map(
    row: Record<string, unknown>,
    tenant: string,
  ): TenantServicesResponse {
    if (
      row.tenantId !== tenant ||
      !Array.isArray(row.services) ||
      new Set(row.services).size !== row.services.length ||
      row.services.some(
        (s) =>
          typeof s !== "string" ||
          !SERVICE_CATALOG.some((c) => c.tenantService && c.serviceId === s),
      )
    )
      throw unavailable();
    return {
      tenantId: tenant,
      services: row.services as TenantServicesResponse["services"],
    };
  }
  async services(token: string, tenant: string) {
    assertCustomerTenantId(tenant);
    return this.map(
      await this.request(token, AUTH_API_PATHS.tenantServices(tenant)),
      tenant,
    );
  }
  async change(
    token: string,
    tenant: string,
    service: string,
    enabled: boolean,
  ) {
    assertCustomerTenantId(tenant);
    if (
      !SERVICE_CATALOG.some(
        (c) => c.tenantService && !c.required && c.serviceId === service,
      )
    )
      throw new ApiError(400, "invalid_input", "Optional service required.");
    return this.map(
      await this.request(
        token,
        AUTH_API_PATHS.tenantService(
          tenant,
          service as OptionalTenantServiceId,
        ),
        enabled ? "PUT" : "DELETE",
      ),
      tenant,
    );
  }
}
