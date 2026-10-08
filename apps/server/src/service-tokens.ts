import { SERVICE_CATALOG } from "@j-auth/contracts";
import type { TenantServiceId } from "@j-auth/contracts";
import type { SessionStore } from "./db/sessions.js";
import type { OidcClient } from "./oidc.js";
import { digest } from "./security.js";
import { ApiError } from "./errors.js";

export function downstreamService(id: string) {
  const service = SERVICE_CATALOG.find(
    (entry) =>
      entry.tenantService &&
      entry.serviceId !== "j-groupware" &&
      entry.serviceId === id,
  );
  if (!service)
    throw new ApiError(400, "invalid_input", "Unknown downstream service.");
  return service;
}

export class ServiceTokens {
  constructor(
    private readonly sessions: SessionStore,
    private readonly oidc: OidcClient,
  ) {}
  async get(
    session: string | undefined,
    serviceId: TenantServiceId,
    signal?: AbortSignal,
  ): Promise<string> {
    const service = downstreamService(serviceId);
    return this.sessions.useSession(
      session,
      async (row, client) => {
        if (!service.roles.some((role) => row.roles.includes(role.name)))
          throw new ApiError(403, "forbidden", "Permission denied.");
        const source = digest(row.access_token);
        const cached = (
          await client.query<{ access_token: string }>(
            "SELECT access_token FROM service_tokens WHERE tenant_id=$1 AND session_hash=$2 AND service_id=$3 AND source_hash=$4 AND expires_at>clock_timestamp()+interval '30 seconds'",
            [row.tenant_id, row.session_hash, serviceId, source],
          )
        ).rows[0];
        if (cached) {
          await this.oidc.validateServiceToken(
            cached.access_token,
            service.clientId,
            row,
            service.roles.map((role) => role.name),
          );
          return cached.access_token;
        }
        const token = await this.oidc.serviceToken(
          row.access_token,
          service.clientId,
          signal,
        );
        const expires = await this.oidc.validateServiceToken(
          token,
          service.clientId,
          row,
          service.roles.map((role) => role.name),
        );
        signal?.throwIfAborted();
        await client.query(
          `INSERT INTO service_tokens(tenant_id,session_hash,service_id,source_hash,access_token,expires_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(tenant_id,session_hash,service_id) DO UPDATE SET source_hash=EXCLUDED.source_hash,access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at`,
          [row.tenant_id, row.session_hash, serviceId, source, token, expires],
        );
        return token;
      },
      signal,
    );
  }
}
