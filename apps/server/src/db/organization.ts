import type { Pool, PoolClient } from "pg";
import type {
  OrganizationMemberProfile,
  OrganizationMember,
  OrganizationDepartment,
  OrganizationPosition,
  OrganizationMemberPage,
  OrganizationSnapshot,
  OrganizationApprovalLine,
  CreateOrganizationDepartment,
  EditOrganizationDepartment,
  EditOrganizationPosition,
  EditOrganizationPlacement,
} from "@j-groupware/contracts";
import { ApiError } from "../errors.js";

const memberColumns =
  'member_id AS id, username, enabled, department_id AS "departmentId", position_id AS "positionId"';
const departmentColumns =
  'id, name, parent_id AS "parentId", head_member_id AS "headMemberId"';
function conflict(
  message = "Organization changed. Reload before retrying.",
): never {
  throw new ApiError(409, "conflict", message);
}
function missing(): never {
  throw new ApiError(404, "not_found", "Organization item not found.");
}
function name(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 120 ||
    /[\x00-\x1f\x7f-\x9f]/.test(normalized)
  )
    throw new ApiError(400, "invalid_input", "Invalid organization name.");
  return normalized;
}
export class OrganizationStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
  ) {}

  // Retain PostgreSQL microseconds: a JS Date can reorder confirmations within the same millisecond.
  async observe(): Promise<string> {
    const result = await this.pool.query<{ observed_at: string }>(
      "SELECT clock_timestamp()::text AS observed_at",
    );
    return result.rows[0]!.observed_at;
  }
  private async transaction<T>(
    work: (client: PoolClient, revision: number) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('jgw-org:' || $1,0))",
        [this.tenant],
      );
      await client.query(
        "INSERT INTO organization_state(tenant_id) VALUES($1) ON CONFLICT DO NOTHING",
        [this.tenant],
      );
      const state = await client.query<{ revision: number }>(
        "SELECT revision FROM organization_state WHERE tenant_id=$1",
        [this.tenant],
      );
      const result = await work(client, state.rows[0]!.revision);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["23505", "23503"].includes(String(error.code))
      )
        conflict("Name already exists or organization item is still in use.");
      throw error;
    } finally {
      client.release();
    }
  }
  private expected(revision: number, expected: number): void {
    if (revision !== expected) conflict();
  }
  private async bump(client: PoolClient): Promise<number> {
    const result = await client.query<{ revision: number }>(
      "UPDATE organization_state SET revision=revision+1 WHERE tenant_id=$1 RETURNING revision",
      [this.tenant],
    );
    return result.rows[0]!.revision;
  }
  private async departments(
    client: PoolClient,
  ): Promise<OrganizationDepartment[]> {
    return (
      await client.query<OrganizationDepartment>(
        `SELECT ${departmentColumns} FROM organization_departments WHERE tenant_id=$1 ORDER BY name COLLATE "C",id`,
        [this.tenant],
      )
    ).rows;
  }
  private async member(
    client: PoolClient,
    id: string,
  ): Promise<OrganizationMember> {
    const result = await client.query<OrganizationMember>(
      `SELECT ${memberColumns} FROM organization_members WHERE tenant_id=$1 AND member_id=$2`,
      [this.tenant, id],
    );
    return result.rows[0] ?? missing();
  }
  private async department(
    client: PoolClient,
    id: string | null,
  ): Promise<void> {
    if (
      id !== null &&
      !(
        await client.query(
          "SELECT 1 FROM organization_departments WHERE tenant_id=$1 AND id=$2",
          [this.tenant, id],
        )
      ).rowCount
    )
      missing();
  }
  private async position(client: PoolClient, id: string | null): Promise<void> {
    if (
      id !== null &&
      !(
        await client.query(
          "SELECT 1 FROM organization_positions WHERE tenant_id=$1 AND id=$2",
          [this.tenant, id],
        )
      ).rowCount
    )
      missing();
  }
  private graph(departments: readonly OrganizationDepartment[]): void {
    const parents = new Map(
      departments.map((department) => [department.id, department.parentId]),
    );
    for (const department of departments) {
      const seen = new Set<string>();
      let current: string | null = department.id;
      while (current !== null) {
        if (seen.has(current)) conflict("Department cycle is not allowed.");
        seen.add(current);
        if (seen.size > 32) conflict("Maximum department depth is 32.");
        if (!parents.has(current)) missing();
        current = parents.get(current)!;
      }
    }
  }
  private async page(
    client: PoolClient,
    revision: number,
    cursor?: string,
    author?: string,
  ): Promise<OrganizationMemberPage> {
    const scope = JSON.stringify([this.tenant, author ?? null]);
    let username: string | null = null,
      id: string | null = null;
    if (cursor) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
      } catch {
        /* invalid below */
      }
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 4 ||
        !Number.isSafeInteger(decoded[0]) ||
        decoded[0] < 0 ||
        decoded[0] > 2147483647 ||
        typeof decoded[1] !== "string" ||
        !decoded[1] ||
        decoded[1].length > 255 ||
        decoded[1].includes("\u0000") ||
        typeof decoded[2] !== "string" ||
        !decoded[2] ||
        decoded[2].length > 128 ||
        !decoded[2].trim() ||
        /[\x00-\x1f\x7f-\x9f]/.test(decoded[2]) ||
        decoded[3] !== scope
      )
        throw new ApiError(
          400,
          "invalid_input",
          "Invalid organization cursor.",
        );
      if (decoded[0] !== revision) conflict();
      username = decoded[1];
      id = decoded[2];
    }
    const result = await client.query<OrganizationMember>(
      `SELECT ${memberColumns} FROM organization_members WHERE tenant_id=$1 AND ($2::text IS NULL OR (enabled AND member_id<>$2)) AND ($3::text IS NULL OR (username COLLATE "C",member_id COLLATE "C")>($3::text COLLATE "C",$4::text COLLATE "C")) ORDER BY username COLLATE "C",member_id COLLATE "C" LIMIT 51`,
      [this.tenant, author ?? null, username, id],
    );
    const items = result.rows.slice(0, 50),
      last = items.at(-1);
    return {
      revision,
      items,
      nextCursor:
        result.rows.length > 50 && last
          ? Buffer.from(
              JSON.stringify([revision, last.username, last.id, scope]),
            ).toString("base64url")
          : null,
    };
  }
  snapshot(cursor?: string): Promise<OrganizationSnapshot> {
    return this.transaction(async (client, revision) => ({
      revision,
      departments: await this.departments(client),
      positions: (
        await client.query<OrganizationPosition>(
          'SELECT id,name FROM organization_positions WHERE tenant_id=$1 ORDER BY name COLLATE "C",id',
          [this.tenant],
        )
      ).rows,
      members: await this.page(client, revision, cursor),
    }));
  }
  candidates(author: string, cursor?: string): Promise<OrganizationMemberPage> {
    return this.transaction((client, revision) =>
      this.page(client, revision, cursor, author),
    );
  }
  register(
    profile: OrganizationMemberProfile,
    observedAt: string,
  ): Promise<{ revision: number; member: OrganizationMember }> {
    return this.transaction(async (client, revision) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('jgw-member:' || $1 || ':' || $2,0))",
        [this.tenant, profile.id],
      );
      if (
        (
          await client.query(
            "SELECT 1 FROM member_session_ends WHERE tenant_id=$1 AND subject=$2 AND expires_at>now() AND ended_at >= $3::timestamptz",
            [this.tenant, profile.id, observedAt],
          )
        ).rowCount
      )
        conflict("Member changed during confirmation. Retry registration.");
      const changed = await client.query(
        "INSERT INTO organization_members(tenant_id,member_id,username,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,member_id) DO UPDATE SET username=EXCLUDED.username,enabled=EXCLUDED.enabled WHERE organization_members.username IS DISTINCT FROM EXCLUDED.username OR organization_members.enabled IS DISTINCT FROM EXCLUDED.enabled",
        [this.tenant, profile.id, profile.username, profile.enabled],
      );
      // A disabled account cannot continue heading a department.
      const heads = profile.enabled
        ? null
        : await client.query(
            "UPDATE organization_departments SET head_member_id=NULL WHERE tenant_id=$1 AND head_member_id=$2",
            [this.tenant, profile.id],
          );
      if (changed.rowCount || heads?.rowCount)
        revision = await this.bump(client);
      return { revision, member: await this.member(client, profile.id) };
    });
  }
  removeMember(id: string): Promise<void> {
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('jgw-member:' || $1 || ':' || $2,0))",
        [this.tenant, id],
      );
      await client.query(
        "UPDATE organization_departments SET head_member_id=NULL WHERE tenant_id=$1 AND head_member_id=$2",
        [this.tenant, id],
      );
      const deleted = await client.query(
        "DELETE FROM organization_members WHERE tenant_id=$1 AND member_id=$2",
        [this.tenant, id],
      );
      if (deleted.rowCount) await this.bump(client);
    });
  }
  createDepartment(
    input: CreateOrganizationDepartment,
  ): Promise<{ revision: number; department: OrganizationDepartment }> {
    return this.transaction(async (client, revision) => {
      this.expected(revision, input.revision);
      await this.department(client, input.parentId);
      const all = await this.departments(client);
      if (all.length >= 500) conflict("Maximum department count is 500.");
      const result = await client.query<OrganizationDepartment>(
        `INSERT INTO organization_departments(tenant_id,name,parent_id) VALUES($1,$2,$3) RETURNING ${departmentColumns}`,
        [this.tenant, name(input.name), input.parentId],
      );
      const department = result.rows[0]!;
      this.graph([...all, department]);
      return { revision: await this.bump(client), department };
    });
  }
  editDepartment(
    id: string,
    input: EditOrganizationDepartment,
  ): Promise<{ revision: number; department: OrganizationDepartment }> {
    return this.transaction(async (client, revision) => {
      this.expected(revision, input.revision);
      const all = await this.departments(client),
        old = all.find((department) => department.id === id) ?? missing();
      await this.department(client, input.parentId);
      if (input.headMemberId !== null) {
        const head = await this.member(client, input.headMemberId);
        if (!head.enabled || head.departmentId !== id)
          conflict(
            "Department head must be an enabled member of this department.",
          );
      }
      this.graph(
        all.map((department) =>
          department.id === id
            ? { ...old, parentId: input.parentId }
            : department,
        ),
      );
      const result = await client.query<OrganizationDepartment>(
        `UPDATE organization_departments SET name=$3,parent_id=$4,head_member_id=$5 WHERE tenant_id=$1 AND id=$2 RETURNING ${departmentColumns}`,
        [this.tenant, id, name(input.name), input.parentId, input.headMemberId],
      );
      return { revision: await this.bump(client), department: result.rows[0]! };
    });
  }
  deleteDepartment(
    id: string,
    expected: number,
  ): Promise<{ revision: number }> {
    return this.transaction(async (client, revision) => {
      this.expected(revision, expected);
      await this.department(client, id);
      if (
        (
          await client.query(
            "SELECT 1 FROM organization_departments WHERE tenant_id=$1 AND parent_id=$2 UNION SELECT 1 FROM organization_members WHERE tenant_id=$1 AND department_id=$2 LIMIT 1",
            [this.tenant, id],
          )
        ).rowCount
      )
        conflict(
          "Move members and child departments before deleting this department.",
        );
      await client.query(
        "DELETE FROM organization_departments WHERE tenant_id=$1 AND id=$2",
        [this.tenant, id],
      );
      return { revision: await this.bump(client) };
    });
  }
  createPosition(
    input: EditOrganizationPosition,
  ): Promise<{ revision: number; position: OrganizationPosition }> {
    return this.transaction(async (client, revision) => {
      this.expected(revision, input.revision);
      if (
        (
          await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM organization_positions WHERE tenant_id=$1",
            [this.tenant],
          )
        ).rows[0]!.count >= 200
      )
        conflict("Maximum position count is 200.");
      const result = await client.query<OrganizationPosition>(
        "INSERT INTO organization_positions(tenant_id,name) VALUES($1,$2) RETURNING id,name",
        [this.tenant, name(input.name)],
      );
      return { revision: await this.bump(client), position: result.rows[0]! };
    });
  }
  editPosition(
    id: string,
    input: EditOrganizationPosition,
  ): Promise<{ revision: number; position: OrganizationPosition }> {
    return this.transaction(async (client, revision) => {
      this.expected(revision, input.revision);
      await this.position(client, id);
      const result = await client.query<OrganizationPosition>(
        "UPDATE organization_positions SET name=$3 WHERE tenant_id=$1 AND id=$2 RETURNING id,name",
        [this.tenant, id, name(input.name)],
      );
      return { revision: await this.bump(client), position: result.rows[0]! };
    });
  }
  deletePosition(id: string, expected: number): Promise<{ revision: number }> {
    return this.transaction(async (client, revision) => {
      this.expected(revision, expected);
      await this.position(client, id);
      if (
        (
          await client.query(
            "SELECT 1 FROM organization_members WHERE tenant_id=$1 AND position_id=$2 LIMIT 1",
            [this.tenant, id],
          )
        ).rowCount
      )
        conflict("Remove position assignments before deleting this position.");
      await client.query(
        "DELETE FROM organization_positions WHERE tenant_id=$1 AND id=$2",
        [this.tenant, id],
      );
      return { revision: await this.bump(client) };
    });
  }
  placeMember(
    id: string,
    input: EditOrganizationPlacement,
  ): Promise<{ revision: number; member: OrganizationMember }> {
    return this.transaction(async (client, revision) => {
      this.expected(revision, input.revision);
      const old = await this.member(client, id);
      await this.department(client, input.departmentId);
      await this.position(client, input.positionId);
      if (
        old.departmentId !== input.departmentId &&
        (
          await client.query(
            "SELECT 1 FROM organization_departments WHERE tenant_id=$1 AND head_member_id=$2 LIMIT 1",
            [this.tenant, id],
          )
        ).rowCount
      )
        conflict("Clear the department head before moving this member.");
      const result = await client.query<OrganizationMember>(
        `UPDATE organization_members SET department_id=$3,position_id=$4 WHERE tenant_id=$1 AND member_id=$2 RETURNING ${memberColumns}`,
        [this.tenant, id, input.departmentId, input.positionId],
      );
      return { revision: await this.bump(client), member: result.rows[0]! };
    });
  }
  approvalLine(author: string): Promise<OrganizationApprovalLine> {
    return this.transaction(async (client, revision) => {
      const member = await this.member(client, author);
      if (!member.enabled)
        throw new ApiError(403, "forbidden", "Permission denied.");
      const departments = await this.departments(client);
      this.graph(departments);
      const map = new Map(
        departments.map((department) => [department.id, department]),
      );
      const enabled = new Set(
        (
          await client.query<{ id: string }>(
            "SELECT member_id AS id FROM organization_members WHERE tenant_id=$1 AND enabled AND member_id IN (SELECT head_member_id FROM organization_departments WHERE tenant_id=$1)",
            [this.tenant],
          )
        ).rows.map((row) => row.id),
      );
      const memberIds: string[] = [];
      let departmentId = member.departmentId;
      while (departmentId !== null) {
        const department = map.get(departmentId) ?? missing();
        if (
          department.headMemberId &&
          department.headMemberId !== author &&
          enabled.has(department.headMemberId) &&
          !memberIds.includes(department.headMemberId)
        )
          memberIds.push(department.headMemberId);
        departmentId = department.parentId;
      }
      return { revision, memberIds };
    });
  }
  validateApproval(
    author: string,
    memberIds: readonly string[],
  ): Promise<OrganizationApprovalLine> {
    return this.transaction(async (client, revision) => {
      if (
        memberIds.length < 1 ||
        memberIds.length > 32 ||
        memberIds.includes(author) ||
        new Set(memberIds).size !== memberIds.length
      )
        throw new ApiError(400, "invalid_input", "Invalid approval stages.");
      const result = await client.query(
        "SELECT member_id FROM organization_members WHERE tenant_id=$1 AND enabled AND member_id=ANY($2::text[])",
        [this.tenant, memberIds],
      );
      if (result.rowCount !== memberIds.length) missing();
      return { revision, memberIds: [...memberIds] };
    });
  }
}
