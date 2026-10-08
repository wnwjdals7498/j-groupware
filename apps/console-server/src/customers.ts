import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SERVICE_CATALOG, assertCustomerTenantId } from "@j-auth/contracts";
import type { CreateTenantRequest } from "@j-auth/contracts";
import { ApiError, unavailable } from "@j-groupware/bff-auth";
import type { AuthControl } from "./auth-control.js";
export const optionalServices = SERVICE_CATALOG.filter(
  (s) => s.tenantService && !s.required,
).map((s) => s.serviceId);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const serviceList = (value: unknown): string[] => {
  if (
    !Array.isArray(value) ||
    value.length > optionalServices.length ||
    new Set(value).size !== value.length ||
    value.some((v) => !optionalServices.includes(v))
  )
    throw new ApiError(400, "invalid_input", "Optional service list required.");
  return optionalServices.filter((v) => value.includes(v));
};
export class ConsoleCustomers {
  constructor(
    private pool: Pool,
    private origin: string,
    private auth?: AuthControl,
  ) {}
  private async locked<T>(
    tenant: string,
    run: (client: PoolClient) => Promise<T>,
  ) {
    assertCustomerTenantId(tenant);
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
        "console-customer:" + tenant,
      ]);
      return await run(c);
    } finally {
      try {
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          "console-customer:" + tenant,
        ]);
      } catch {
        discard = true;
      }
      c.release(discard);
    }
  }
  async register(token: string, input: CreateTenantRequest) {
    assertCustomerTenantId(input.tenantId);
    if (!this.auth) throw unavailable();
    return this.locked(input.tenantId, async (c) => {
      if (
        (
          await c.query("SELECT 1 FROM customers WHERE tenant_id=$1", [
            input.tenantId,
          ])
        ).rowCount
      )
        throw new ApiError(
          409,
          "conflict",
          "Registration already attempted. Bootstrap cannot be replayed.",
        );
      const key = randomBytes(32).toString("base64url");
      await c.query(
        "INSERT INTO customers(tenant_id,registration,agent_key_hash) VALUES ($1,'creating',$2)",
        [input.tenantId, hash(key)],
      );
      let created = false;
      try {
        const bootstrap = await this.auth!.create(token, input);
        created = true;
        await c.query(
          "UPDATE customers SET registration='ready',auth_services=ARRAY['j-groupware'],auth_state='applied',auth_checked_at=now() WHERE tenant_id=$1",
          [input.tenantId],
        );
        return {
          tenant: input.tenantId,
          ...bootstrap,
          agentKey: key,
          consoleOrigin: this.origin,
        };
      } catch {
        await c
          .query(
            "UPDATE customers SET registration=$2,agent_key_hash=NULL,auth_state='unknown' WHERE tenant_id=$1",
            [
              input.tenantId,
              created ? "bootstrap_unrecoverable" : "auth_uncertain",
            ],
          )
          .catch(() => undefined);
        throw new ApiError(
          503,
          created ? "bootstrap_unrecoverable" : "auth_creation_uncertain",
          "Registration requires explicit recovery review.",
        );
      }
    });
  }
  async list(limit: number, after?: string) {
    const rows = (
      await this.pool.query(
        'SELECT tenant_id AS tenant,registration,auth_state AS "authState",created_at AS "createdAt" FROM customers WHERE ($1::text IS NULL OR tenant_id>$1) ORDER BY tenant_id LIMIT $2',
        [after ?? null, limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1]!.tenant : null,
    };
  }
  async resetBootstrap(token: string, tenant: string) {
    if (!this.auth) throw unavailable();
    return this.locked(tenant, async (c) => {
      if (
        !(await c.query("SELECT 1 FROM customers WHERE tenant_id=$1", [tenant]))
          .rowCount
      )
        throw new ApiError(404, "not_found", "Customer not found.");
      await c.query(
        "UPDATE customers SET registration='bootstrap_unrecoverable',agent_key_hash=NULL WHERE tenant_id=$1",
        [tenant],
      );
      const bootstrap = await this.auth!.rotate(token, tenant),
        key = randomBytes(32).toString("base64url");
      try {
        await c.query(
          "UPDATE customers SET registration='ready',agent_key_hash=$2,agent_epoch=agent_epoch+1 WHERE tenant_id=$1",
          [tenant, hash(key)],
        );
      } catch {
        throw new ApiError(
          503,
          "bootstrap_unrecoverable",
          "Bootstrap reset requires explicit recovery review.",
        );
      }
      return {
        tenant,
        ...bootstrap,
        agentKey: key,
        consoleOrigin: this.origin,
      };
    });
  }
  async detail(tenant: string) {
    assertCustomerTenantId(tenant);
    const row = (
      await this.pool.query(
        'SELECT tenant_id AS tenant,registration,desired_services AS "desiredServices",desired_revision AS "desiredRevision",auth_services AS "authServices",auth_state AS "authState",auth_checked_at AS "authCheckedAt" FROM customers WHERE tenant_id=$1',
        [tenant],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "not_found", "Customer not found.");
    const report =
      (
        await this.pool.query(
          'SELECT desired_revision AS "desiredRevision",report,received_at AS "receivedAt" FROM agent_reports WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0] ?? null;
    return { ...row, installation: report };
  }
  async reconcile(
    token: string,
    tenant: string,
    change?: { service: string; enabled: boolean; revision: number },
  ) {
    if (!this.auth) throw unavailable();
    return this.locked(tenant, async (c) => {
      let row = (
        await c.query("SELECT * FROM customers WHERE tenant_id=$1", [tenant])
      ).rows[0];
      if (!row || row.registration !== "ready")
        throw new ApiError(404, "not_found", "Ready customer not found.");
      if (change) {
        if (
          !optionalServices.includes(
            change.service as (typeof optionalServices)[number],
          )
        )
          throw new ApiError(
            400,
            "invalid_input",
            "Optional service required.",
          );
        if (row.desired_revision !== change.revision)
          throw new ApiError(
            409,
            "revision_conflict",
            "Desired state changed.",
          );
        const selected = new Set<string>(row.desired_services);
        if (change.enabled) selected.add(change.service);
        else selected.delete(change.service);
        const desired = serviceList([...selected]);
        if (JSON.stringify(desired) !== JSON.stringify(row.desired_services))
          await c.query(
            "UPDATE customers SET desired_services=$2,desired_revision=desired_revision+1,auth_state='pending' WHERE tenant_id=$1",
            [tenant, desired],
          );
        row = (
          await c.query("SELECT * FROM customers WHERE tenant_id=$1", [tenant])
        ).rows[0];
      }
      try {
        let observed = (await this.auth!.services(token, tenant)).services;
        for (const service of optionalServices) {
          const wanted = row.desired_services.includes(service);
          if (observed.includes(service) !== wanted)
            observed = (await this.auth!.change(token, tenant, service, wanted))
              .services;
        }
        const actual = serviceList(observed.filter((s) => s !== "j-groupware"));
        if (JSON.stringify(actual) !== JSON.stringify(row.desired_services))
          throw unavailable();
        await c.query(
          "UPDATE customers SET auth_services=$2,auth_state='applied',auth_checked_at=now() WHERE tenant_id=$1",
          [tenant, observed],
        );
      } catch {
        await c
          .query(
            "UPDATE customers SET auth_state='failed',auth_checked_at=now() WHERE tenant_id=$1",
            [tenant],
          )
          .catch(() => undefined);
        throw new ApiError(
          503,
          "auth_projection_failed",
          "Desired state saved; authentication projection failed.",
        );
      }
      return this.detail(tenant);
    });
  }
  async rotateAgent(tenant: string) {
    return this.locked(tenant, async (c) => {
      const key = randomBytes(32).toString("base64url");
      const result = await c.query(
        "UPDATE customers SET agent_key_hash=$2,agent_epoch=agent_epoch+1 WHERE tenant_id=$1 AND registration='ready' RETURNING tenant_id",
        [tenant, hash(key)],
      );
      if (!result.rowCount)
        throw new ApiError(404, "not_found", "Ready customer not found.");
      return { tenant, agentKey: key };
    });
  }
  async revokeAgent(tenant: string) {
    return this.locked(tenant, async (c) => {
      const r = await c.query(
        "UPDATE customers SET agent_key_hash=NULL WHERE tenant_id=$1 AND registration='ready'",
        [tenant],
      );
      if (!r.rowCount)
        throw new ApiError(404, "not_found", "Ready customer not found.");
    });
  }
  async agent(bearer: unknown) {
    if (
      typeof bearer !== "string" ||
      !/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer)
    )
      throw new ApiError(401, "unauthenticated", "Valid agent key required.");
    const row = (
      await this.pool.query(
        "SELECT tenant_id,desired_services,desired_revision,agent_epoch,coalesce((SELECT report_sequence FROM agent_reports r WHERE r.tenant_id=customers.tenant_id AND r.agent_epoch=customers.agent_epoch),0) AS report_sequence FROM customers WHERE agent_key_hash=$1 AND registration='ready'",
        [hash(bearer.slice(7))],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(401, "unauthenticated", "Valid agent key required.");
    return {
      tenant: row.tenant_id,
      services: row.desired_services as string[],
      revision: row.desired_revision as number,
      agentEpoch: row.agent_epoch as number,
      reportSequence: row.report_sequence as number,
    };
  }
  async report(
    bearer: unknown,
    input: {
      desiredRevision: number;
      agentEpoch: number;
      reportSequence: number;
      installed?: string[];
      incomplete?: string[];
      outcome: string;
      phase?: string;
      error?: string;
    },
  ) {
    const agent = await this.agent(bearer);
    return this.locked(agent.tenant, async (c) => {
      const current = await this.agent(bearer);
      if (current.revision !== input.desiredRevision)
        throw new ApiError(
          409,
          "revision_conflict",
          "Desired state changed; read it again.",
        );
      if (current.agentEpoch !== input.agentEpoch)
        throw new ApiError(409, "agent_epoch_conflict", "Agent key changed.");
      if (current.reportSequence === input.reportSequence) {
        const previous = (
          await c.query(
            "SELECT report=$2::jsonb AS identical FROM agent_reports WHERE tenant_id=$1",
            [agent.tenant, JSON.stringify(input)],
          )
        ).rows[0];
        if (previous?.identical)
          return { accepted: true, desiredRevision: current.revision };
        throw new ApiError(
          409,
          "report_conflict",
          "Report sequence already used.",
        );
      }
      if (input.reportSequence !== current.reportSequence + 1)
        throw new ApiError(
          409,
          "report_conflict",
          "Read current desired state before reporting.",
        );
      if (input.installed) serviceList(input.installed);
      if (input.incomplete) serviceList(input.incomplete);
      if (
        input.incomplete?.some((service) => input.installed?.includes(service))
      )
        throw new ApiError(
          400,
          "invalid_report",
          "Inventory sets must be disjoint.",
        );
      if (
        input.outcome === "synchronized" &&
        (!input.installed ||
          input.incomplete?.length ||
          input.error ||
          input.phase ||
          JSON.stringify(serviceList(input.installed)) !==
            JSON.stringify(serviceList(current.services)))
      )
        throw new ApiError(
          400,
          "invalid_report",
          "Synchronized inventory must match desired state.",
        );
      await c.query(
        "INSERT INTO agent_reports(tenant_id,desired_revision,agent_epoch,report_sequence,report) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET desired_revision=EXCLUDED.desired_revision,agent_epoch=EXCLUDED.agent_epoch,report_sequence=EXCLUDED.report_sequence,report=EXCLUDED.report,received_at=now()",
        [
          agent.tenant,
          input.desiredRevision,
          input.agentEpoch,
          input.reportSequence,
          JSON.stringify(input),
        ],
      );
      return { accepted: true, desiredRevision: current.revision };
    });
  }
}
