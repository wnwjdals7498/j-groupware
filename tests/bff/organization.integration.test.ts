import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Browser, integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import type {
  MemberResponse,
  OrganizationSnapshot,
  OrganizationDepartment,
  OrganizationPosition,
  OrganizationMemberPage,
  OrganizationApprovalLine,
} from "@j-groupware/contracts";
import { digest } from "../../apps/server/src/security.js";

describe("actual organization API + member confirmation + dedicated PostgreSQL", () => {
  let runtime: Runtime, admin: Browser;
  let serial = 0;
  const browser = (index = 0) =>
    new Browser(runtime.fetch, runtime.fixtures[index]!.origin);
  const snapshot = async (b = admin): Promise<OrganizationSnapshot> => {
    const response = await b.request("/api/organization");
    expect(response.status).toBe(200);
    return (await response.json()) as OrganizationSnapshot;
  };
  const createMember = async (roles: string[] = [], local = true) => {
    const username = `org-member-${++serial}`,
      password = randomBytes(24).toString("base64url");
    runtime.secretValues.add(password);
    const response = local
      ? await admin.change("/api/members", { username, password, roles })
      : await runtime.members(0, "", { username, password, roles });
    expect(response.status).toBe(201);
    const member = (await response.json()) as MemberResponse;
    return { ...member, password };
  };
  const department = async (
    name: string,
    parentId: string | null = null,
    b = admin,
  ): Promise<OrganizationDepartment> => {
    const current = await snapshot(b);
    const response = await b.change("/api/organization/departments", {
      revision: current.revision,
      name,
      parentId,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { department: OrganizationDepartment })
      .department;
  };
  const position = async (name: string): Promise<OrganizationPosition> => {
    const current = await snapshot();
    const response = await admin.change("/api/organization/positions", {
      revision: current.revision,
      name,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { position: OrganizationPosition })
      .position;
  };
  const place = async (
    id: string,
    departmentId: string | null,
    positionId: string | null = null,
  ) => {
    const current = await snapshot();
    return admin.change(
      `/api/organization/members/${id}`,
      { revision: current.revision, departmentId, positionId },
      "PATCH",
    );
  };
  const edit = async (
    item: OrganizationDepartment,
    parentId: string | null,
    headMemberId: string | null = null,
  ) => {
    const current = await snapshot();
    return admin.change(
      `/api/organization/departments/${item.id}`,
      { revision: current.revision, name: item.name, parentId, headMemberId },
      "PATCH",
    );
  };
  beforeAll(async () => {
    runtime = await integrationRuntime();
    expect((await runtime.subscribe(0, "j-approval")).status).toBe(200);
    admin = browser();
    await admin.login(runtime.fixtures[0]!.password);
  });
  afterAll(async () => {
    if (runtime) await runtime.close();
  });

  it("preserves the previous unassigned registration data and applies immutable migration 004 idempotently", async () => {
    const client = await runtime.pool.connect();
    // A rollback-only schema in the isolated test database exercises a populated 003 -> 004 upgrade.
    const schema = "fixture_org_upgrade_" + randomBytes(8).toString("hex");
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path=${schema}`);
      await client.query("CREATE TABLE login_flows(id integer)");
      await client.query(
        await readFile(
          new URL(
            "../../deploy/migrations/003-member-workflows.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await client.query(
        "INSERT INTO unassigned_members(tenant_id,member_id,username,created_at) VALUES($1,'preserved-id','preserved-name','2026-10-01T00:00:00Z')",
        [runtime.fixtures[0]!.tenant],
      );
      await client.query(
        await readFile(
          new URL(
            "../../deploy/migrations/004-organization.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(
        (
          await client.query(
            "SELECT member_id,username,enabled,department_id,position_id,created_at FROM organization_members",
          )
        ).rows,
      ).toEqual([
        {
          member_id: "preserved-id",
          username: "preserved-name",
          enabled: true,
          department_id: null,
          position_id: null,
          created_at: new Date("2026-10-01T00:00:00Z"),
        },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const names = (
      await runtime.pool.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      )
    ).rows.map((row) => row.name);
    expect(names).toContain("003-member-workflows.sql");
    expect(names).toContain("004-organization.sql");
    expect(
      (
        await runtime.pool.query(
          "SELECT to_regclass('unassigned_members') AS old, to_regclass('organization_members') AS current",
        )
      ).rows[0],
    ).toEqual({ old: null, current: "organization_members" });
    const created = await createMember();
    expect(
      (await snapshot()).members.items.find(
        (member) => member.id === created.id,
      ),
    ).toMatchObject({
      username: created.username,
      enabled: true,
      departmentId: null,
      positionId: null,
    });
    const grants = await runtime.pool.query(
      "SELECT 1 FROM information_schema.role_table_grants WHERE table_name LIKE 'organization_%' AND grantee='PUBLIC'",
    );
    expect(grants.rowCount).toBe(0);
  });
  it("allows an org-only editor to confirm and edit a real member without member management privileges", async () => {
    const editor = await createMember(["org:manage"]),
      existing = await createMember([], false),
      b = browser();
    await b.login(editor.password, editor.username);
    const me = await b.me();
    expect(me.roles).toContain("org:manage");
    expect(me.roles).not.toContain("member:manage");
    const before = runtime.memberCalls.length;
    expect((await b.request("/api/members")).status).toBe(403);
    expect(
      (await b.change(`/api/members/${existing.id}/organization`, undefined))
        .status,
    ).toBe(403);
    expect(runtime.memberCalls.length).toBe(before);
    const response = await b.change(
      `/api/organization/members/${existing.id}`,
      undefined,
      "PUT",
    );
    expect(response.status).toBe(200);
    const value = (await response.json()) as { member: { id: string } };
    expect(value.member.id).toBe(existing.id);
    expect(Object.keys(value.member).sort()).toEqual([
      "departmentId",
      "enabled",
      "id",
      "positionId",
      "username",
    ]);
    const call = runtime.memberCalls.at(-1)!;
    expect(call).toMatchObject({
      method: "GET",
      path: `/auth/members/${existing.id}`,
      cookie: false,
      serviceKeyHash: digest(runtime.fixtures[0]!.secrets.serviceKey),
    });
    const row = (
      await runtime.pool.query(
        "SELECT access_token FROM sessions WHERE tenant_id=$1 AND subject=$2",
        [runtime.fixtures[0]!.tenant, editor.id],
      )
    ).rows[0];
    expect(call.authorizationHash).toBe(digest("Bearer " + row.access_token));
    expect((await department("org-only-created", null, b)).name).toBe(
      "org-only-created",
    );
  });
  it("recovers confirmed creation after a failed local insert, without recreating or returning a password", async () => {
    const username = "org-partial-create",
      password = randomBytes(24).toString("base64url");
    runtime.secretValues.add(password);
    await runtime.pool.query(
      "CREATE FUNCTION fixture_org_insert_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected registration failure'; END $$; CREATE TRIGGER fixture_org_insert_fail BEFORE INSERT ON organization_members FOR EACH ROW WHEN (NEW.username='org-partial-create') EXECUTE FUNCTION fixture_org_insert_fail()",
    );
    try {
      const response = await admin.change("/api/members", {
        username,
        password,
        roles: [],
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("Member created");
    } finally {
      await runtime.pool.query(
        "DROP TRIGGER fixture_org_insert_fail ON organization_members; DROP FUNCTION fixture_org_insert_fail()",
      );
    }
    const actual = (await (await admin.request("/api/members")).json()) as {
      items: MemberResponse[];
    };
    const found = actual.items.filter((item) => item.username === username);
    expect(found).toHaveLength(1);
    expect(
      (await admin.change("/api/members", { username, password, roles: [] }))
        .status,
    ).toBe(409);
    const before = runtime.memberCalls.length;
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        admin.change(`/api/members/${found[0]!.id}/organization`, undefined),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    const values = await Promise.all(
      responses.map((response) => response.text()),
    );
    expect(values.some((value) => value.includes(password))).toBe(false);
    expect(
      runtime.memberCalls.slice(before).map((call) => call.method),
    ).toEqual(["GET", "GET", "GET"]);
    expect(
      (
        await runtime.pool.query(
          "SELECT 1 FROM organization_members WHERE tenant_id=$1 AND member_id=$2",
          [runtime.fixtures[0]!.tenant, found[0]!.id],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("keeps department and position assignments on duplicate manual registration and member repair", async () => {
    const member = await createMember(),
      dept = await department("repair-department"),
      pos = await position("repair-position");
    expect((await place(member.id, dept.id, pos.id)).status).toBe(200);
    const before = await snapshot();
    for (const [path, method] of [
      [`/api/organization/members/${member.id}`, "PUT"],
      [`/api/members/${member.id}/organization`, "POST"],
    ]) {
      const response = await admin.change(path!, undefined, method);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        revision: before.revision,
        member: { id: member.id, departmentId: dept.id, positionId: pos.id },
      });
    }
    expect((await snapshot()).revision).toBe(before.revision);
  });
  it("denies foreign member registration, a foreign service key, non-editors and CSRF without creating metadata", async () => {
    const foreign = browser(1);
    await foreign.login(runtime.fixtures[1]!.password);
    const foreignId = (await foreign.me()).subject,
      before = await snapshot();
    expect(
      (
        await admin.change(
          `/api/organization/members/${foreignId}`,
          undefined,
          "PUT",
        )
      ).status,
    ).toBe(404);
    expect((await snapshot()).revision).toBe(before.revision);
    const fixture = runtime.fixtures[0]!,
      saved = fixture.memberAuth.serviceKey;
    fixture.memberAuth.serviceKey = runtime.fixtures[1]!.secrets.serviceKey;
    try {
      expect(
        (
          await admin.change(
            `/api/members/${foreignId}/organization`,
            undefined,
          )
        ).status,
      ).toBe(503);
    } finally {
      fixture.memberAuth.serviceKey = saved;
    }
    expect((await admin.request("/api/me")).status).toBe(200);
    expect(
      (
        await admin.request(`/api/organization/members/${foreignId}`, {
          method: "PUT",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.change(
          `/api/organization/members/${foreignId}`,
          { tenant: fixture.tenant },
          "PUT",
        )
      ).status,
    ).toBe(400);
    const member = await createMember(),
      b = browser();
    await b.login(member.password, member.username);
    const calls = runtime.memberCalls.length;
    expect((await b.request("/api/organization")).status).toBe(403);
    expect((await b.request("/api/organization/candidates")).status).toBe(403);
    expect(
      (
        await b.change(
          `/api/organization/members/${member.id}`,
          undefined,
          "PUT",
        )
      ).status,
    ).toBe(403);
    expect(runtime.memberCalls.length).toBe(calls);
  });
  it("edits the tree and positions, trims names and rejects duplicate names and invalid input atomically", async () => {
    const root = await department("  edit-root  "),
      child = await department("edit-child", root.id),
      pos = await position("  edit-position  ");
    expect(root.name).toBe("edit-root");
    expect(pos.name).toBe("edit-position");
    let current = await snapshot();
    expect(
      (
        await admin.change("/api/organization/departments", {
          revision: current.revision,
          name: root.name,
          parentId: null,
        })
      ).status,
    ).toBe(409);
    expect((await snapshot()).revision).toBe(current.revision);
    expect(
      (
        await admin.change("/api/organization/positions", {
          revision: current.revision,
          name: pos.name,
        })
      ).status,
    ).toBe(409);
    expect((await edit(child, null)).status).toBe(200);
    current = await snapshot();
    expect(
      (
        await admin.change(
          `/api/organization/positions/${pos.id}`,
          { revision: current.revision, name: "renamed-position" },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    current = await snapshot();
    for (const invalid of ["   ", "control\u0001name"])
      expect(
        (
          await admin.change("/api/organization/positions", {
            revision: current.revision,
            name: invalid,
          })
        ).status,
      ).toBe(400);
    expect((await snapshot()).revision).toBe(current.revision);
    expect(
      (
        await admin.change("/api/organization/positions", {
          revision: -1,
          name: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin.change("/api/organization/positions", {
          revision: current.revision,
          name: "invalid",
          tenant: "untrusted",
        })
      ).status,
    ).toBe(400);
  });
  it("rejects self and ancestor cycles without changing the revision or graph", async () => {
    const root = await department("cycle-root"),
      child = await department("cycle-child", root.id),
      leaf = await department("cycle-leaf", child.id),
      before = await snapshot();
    expect((await edit(root, root.id)).status).toBe(409);
    expect((await edit(root, leaf.id)).status).toBe(409);
    const after = await snapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.departments).toEqual(before.departments);
  });
  it("serializes conflicting reparent requests with optimistic revision checks and supports a safe retry", async () => {
    const a = await department("concurrent-a"),
      b = await department("concurrent-b"),
      before = await snapshot(),
      me = await admin.me();
    const headers = {
      Origin: admin.origin,
      "x-csrf-token": me.csrfToken,
      "Content-Type": "application/json",
    };
    const results = await Promise.all(
      [
        [a, b],
        [b, a],
      ].map(([item, parent]) =>
        admin.request(`/api/organization/departments/${item!.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            revision: before.revision,
            name: item!.name,
            parentId: parent!.id,
            headMemberId: null,
          }),
        }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const after = await snapshot();
    expect(after.revision).toBe(before.revision + 1);
    const loser = results[0]!.status === 409 ? a : b,
      target = loser.id === a.id ? b : a;
    expect((await edit(loser, target.id)).status).toBe(409);
    expect((await edit(loser, null)).status).toBe(200);
  });
  it("enforces department depth 32 and validates moved descendants before committing", async () => {
    let parent: OrganizationDepartment | null = null;
    for (let i = 0; i < 32; i++)
      parent = await department(`depth-${i}`, parent?.id ?? null);
    const before = await snapshot();
    expect(
      (
        await admin.change("/api/organization/departments", {
          revision: before.revision,
          name: "depth-33",
          parentId: parent!.id,
        })
      ).status,
    ).toBe(409);
    const extra = await department("depth-extra"),
      child = await department("depth-extra-child", extra.id);
    expect((await edit(extra, parent!.id)).status).toBe(409);
    expect(
      (await snapshot()).departments.find((item) => item.id === child.id)
        ?.parentId,
    ).toBe(extra.id);
  });
  it("bounds department and position counts with owned database-only limit fixtures", async () => {
    const tenant = runtime.fixtures[0]!.tenant;
    await runtime.pool.query(
      "INSERT INTO organization_departments(tenant_id,name) SELECT $1,'limit-department-' || value FROM generate_series((SELECT count(*)::int+1 FROM organization_departments WHERE tenant_id=$1),500) AS entry(value)",
      [tenant],
    );
    await runtime.pool.query(
      "INSERT INTO organization_positions(tenant_id,name) SELECT $1,'limit-position-' || value FROM generate_series((SELECT count(*)::int+1 FROM organization_positions WHERE tenant_id=$1),200) AS entry(value)",
      [tenant],
    );
    try {
      const current = await snapshot();
      expect(current.departments).toHaveLength(500);
      expect(current.positions).toHaveLength(200);
      expect(
        (
          await admin.change("/api/organization/departments", {
            revision: current.revision,
            name: "one-too-many",
            parentId: null,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await admin.change("/api/organization/positions", {
            revision: current.revision,
            name: "one-too-many",
          })
        ).status,
      ).toBe(409);
      expect((await snapshot()).revision).toBe(current.revision);
    } finally {
      await runtime.pool.query(
        "DELETE FROM organization_departments WHERE tenant_id=$1 AND name LIKE 'limit-department-%'",
        [tenant],
      );
      await runtime.pool.query(
        "DELETE FROM organization_positions WHERE tenant_id=$1 AND name LIKE 'limit-position-%'",
        [tenant],
      );
    }
  });
  it("requires registered enabled department members as heads and explicit head clearing before a move", async () => {
    const a = await department("head-a"),
      b = await department("head-b"),
      member = await createMember();
    expect((await edit(a, null, member.id)).status).toBe(409);
    expect((await place(member.id, a.id)).status).toBe(200);
    expect((await edit(a, null, member.id)).status).toBe(200);
    expect((await place(member.id, b.id)).status).toBe(409);
    expect((await edit(a, null)).status).toBe(200);
    expect((await place(member.id, b.id)).status).toBe(200);
  });
  it("rejects referenced deletion and clears an actual deleted member's head and assignments", async () => {
    const root = await department("delete-root"),
      child = await department("delete-child", root.id),
      pos = await position("delete-position"),
      member = await createMember();
    expect((await place(member.id, child.id, pos.id)).status).toBe(200);
    expect((await edit(child, root.id, member.id)).status).toBe(200);
    for (const path of [
      `departments/${root.id}`,
      `departments/${child.id}`,
      `positions/${pos.id}`,
    ])
      expect(
        (
          await admin.change(
            `/api/organization/${path}`,
            { revision: (await snapshot()).revision },
            "DELETE",
          )
        ).status,
      ).toBe(409);
    expect(
      (await admin.change(`/api/members/${member.id}`, undefined, "DELETE"))
        .status,
    ).toBe(204);
    const after = await snapshot();
    expect(after.members.items.some((item) => item.id === member.id)).toBe(
      false,
    );
    expect(
      after.departments.find((item) => item.id === child.id)?.headMemberId,
    ).toBeNull();
    for (const path of [
      `departments/${child.id}`,
      `departments/${root.id}`,
      `positions/${pos.id}`,
    ])
      expect(
        (
          await admin.change(
            `/api/organization/${path}`,
            { revision: (await snapshot()).revision },
            "DELETE",
          )
        ).status,
      ).toBe(200);
  });
  it("rejects foreign department, position, member and head references at API and composite FK boundaries", async () => {
    const other = browser(1);
    await other.login(runtime.fixtures[1]!.password);
    const foreign = await department("foreign-department", null, other),
      foreignMe = await other.me(),
      otherState = await snapshot(other);
    const response = await other.change("/api/organization/positions", {
      revision: otherState.revision,
      name: "foreign-position",
    });
    expect(response.status).toBe(201);
    const foreignPos = (
      (await response.json()) as { position: OrganizationPosition }
    ).position;
    const own = await department("foreign-test-own"),
      member = await createMember(),
      before = await snapshot();
    expect((await place(member.id, foreign.id)).status).toBe(404);
    expect((await place(member.id, own.id, foreignPos.id)).status).toBe(404);
    expect((await place(foreignMe.subject, own.id)).status).toBe(404);
    expect((await edit(own, foreign.id)).status).toBe(404);
    expect((await edit(own, null, foreignMe.subject)).status).toBe(404);
    expect((await snapshot()).revision).toBe(before.revision);
    await expect(
      runtime.pool.query(
        "UPDATE organization_members SET department_id=$3 WHERE tenant_id=$1 AND member_id=$2",
        [runtime.fixtures[0]!.tenant, member.id, foreign.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("rolls back an injected database write failure with its revision and permits retry", async () => {
    const before = await snapshot();
    await runtime.pool.query(
      "CREATE FUNCTION fixture_org_edit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected organization failure'; END $$; CREATE TRIGGER fixture_org_edit_fail BEFORE INSERT ON organization_positions FOR EACH ROW WHEN (NEW.name='retry-position') EXECUTE FUNCTION fixture_org_edit_fail()",
    );
    try {
      expect(
        (
          await admin.change("/api/organization/positions", {
            revision: before.revision,
            name: "retry-position",
          })
        ).status,
      ).toBe(503);
    } finally {
      await runtime.pool.query(
        "DROP TRIGGER fixture_org_edit_fail ON organization_positions; DROP FUNCTION fixture_org_edit_fail()",
      );
    }
    expect((await snapshot()).revision).toBe(before.revision);
    expect(
      (
        await admin.change("/api/organization/positions", {
          revision: before.revision,
          name: "retry-position",
        })
      ).status,
    ).toBe(201);
  });
  it("does not resurrect a member when an actual profile response arrives after deletion", async () => {
    const target = await createMember([], false),
      gate = runtime.holdNextProfileResponse();
    let pending: Promise<Response> | undefined;
    try {
      pending = admin.change(
        `/api/organization/members/${target.id}`,
        undefined,
        "PUT",
      );
      await gate.arrival;
      expect(
        (await admin.change(`/api/members/${target.id}`, undefined, "DELETE"))
          .status,
      ).toBe(204);
      gate.release();
      expect((await pending).status).toBe(409);
    } finally {
      gate.release();
      if (pending) await pending.catch(() => undefined);
    }
    expect(
      (
        await runtime.pool.query(
          "SELECT 1 FROM organization_members WHERE tenant_id=$1 AND member_id=$2",
          [runtime.fixtures[0]!.tenant, target.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await admin.change(`/api/members/${target.id}/organization`, undefined))
        .status,
    ).toBe(404);
  });
  it("derives department-head then ancestor-head stages, excludes the author and supports unassigned authors", async () => {
    const root = await department("approval-root"),
      child = await department("approval-child", root.id),
      rootHead = await createMember(["approval:use"]),
      childHead = await createMember(["approval:use"]),
      writer = await createMember(["approval:use"]),
      unassigned = await createMember(["approval:use"]);
    expect((await place(rootHead.id, root.id)).status).toBe(200);
    expect((await place(childHead.id, child.id)).status).toBe(200);
    expect((await place(writer.id, child.id)).status).toBe(200);
    expect((await edit(root, null, rootHead.id)).status).toBe(200);
    expect((await edit(child, root.id, childHead.id)).status).toBe(200);
    const b = browser();
    await b.login(writer.password, writer.username);
    const line = await b.request("/api/organization/approval-line");
    expect(line.status).toBe(200);
    expect(((await line.json()) as OrganizationApprovalLine).memberIds).toEqual(
      [childHead.id, rootHead.id],
    );
    const head = browser();
    await head.login(childHead.password, childHead.username);
    expect(
      (
        (await (
          await head.request("/api/organization/approval-line")
        ).json()) as OrganizationApprovalLine
      ).memberIds,
    ).toEqual([rootHead.id]);
    const free = browser();
    await free.login(unassigned.password, unassigned.username);
    expect(
      (
        (await (
          await free.request("/api/organization/approval-line")
        ).json()) as OrganizationApprovalLine
      ).memberIds,
    ).toEqual([]);
    const calls = runtime.memberCalls.length;
    const candidates = (await (
      await b.request("/api/organization/candidates")
    ).json()) as OrganizationMemberPage;
    expect(candidates.items.map((member) => member.id)).toContain(
      unassigned.id,
    );
    expect(candidates.items.map((member) => member.id)).not.toContain(
      writer.id,
    );
    const custom = await b.change("/api/organization/approval-line/validate", {
      memberIds: [rootHead.id, unassigned.id, childHead.id],
    });
    expect(custom.status).toBe(200);
    expect(
      ((await custom.json()) as OrganizationApprovalLine).memberIds,
    ).toEqual([rootHead.id, unassigned.id, childHead.id]);
    for (const memberIds of [[], [writer.id], [rootHead.id, rootHead.id]])
      expect(
        (
          await b.change("/api/organization/approval-line/validate", {
            memberIds,
          })
        ).status,
      ).toBe(400);
    const other = browser(1);
    await other.login(runtime.fixtures[1]!.password);
    expect(
      (
        await b.change("/api/organization/approval-line/validate", {
          memberIds: [(await other.me()).subject],
        })
      ).status,
    ).toBe(404);
    const external = await createMember([], false),
      afterCreation = runtime.memberCalls.length;
    expect(
      (
        await b.change("/api/organization/approval-line/validate", {
          memberIds: [external.id],
        })
      ).status,
    ).toBe(404);
    expect(runtime.memberCalls.length).toBe(afterCreation);
    // No j-auth profile lookups are needed for approval-line queries or candidate validation.
    expect(
      runtime.memberCalls
        .slice(calls)
        .filter(
          (call) =>
            call.method === "GET" && call.path.startsWith("/auth/members/"),
        ),
    ).toHaveLength(0);
  });
  it("updates registered enabled status from actual Keycloak confirmation and removes disabled heads and candidates", async () => {
    const target = await createMember(),
      dept = await department("disabled-head");
    expect((await place(target.id, dept.id)).status).toBe(200);
    expect((await edit(dept, null, target.id)).status).toBe(200);
    expect(
      (
        await runtime.admin(
          `/admin/realms/tenant-${runtime.fixtures[0]!.tenant}/users/${target.id}`,
          { method: "PUT", body: JSON.stringify({ enabled: false }) },
        )
      ).status,
    ).toBe(204);
    const repair = await admin.change(
      `/api/organization/members/${target.id}`,
      undefined,
      "PUT",
    );
    expect(repair.status).toBe(200);
    expect(
      ((await repair.json()) as { member: { enabled: boolean } }).member
        .enabled,
    ).toBe(false);
    expect(
      (await snapshot()).departments.find((item) => item.id === dept.id)
        ?.headMemberId,
    ).toBeNull();
    expect((await edit(dept, null, target.id)).status).toBe(409);
    expect(
      (
        await admin.change("/api/organization/approval-line/validate", {
          memberIds: [target.id],
        })
      ).status,
    ).toBe(404);
  });
  it("bounds pagination, binds cursors to tenant and view and rejects changed revisions", async () => {
    // Owned database-only rows exercise local registry pagination; registration tests above use real Keycloak accounts.
    const tenant = runtime.fixtures[0]!.tenant,
      ids = Array.from({ length: 55 }, () => randomUUID());
    await runtime.pool.query(
      "INSERT INTO organization_members(tenant_id,member_id,username) SELECT $1, value, 'pagination-' || ordinality FROM unnest($2::text[]) WITH ORDINALITY AS entry(value,ordinality)",
      [tenant, ids],
    );
    try {
      const first = await snapshot();
      expect(first.members.items).toHaveLength(50);
      expect(first.members.nextCursor).toBeTruthy();
      const next = await snapshotWithCursor(first.members.nextCursor!);
      expect(
        next.members.items.every(
          (item) => !first.members.items.some((old) => old.id === item.id),
        ),
      ).toBe(true);
      expect(
        (
          await admin.request(
            "/api/organization/candidates?" +
              new URLSearchParams({ cursor: first.members.nextCursor! }),
          )
        ).status,
      ).toBe(400);
      const other = browser(1);
      await other.login(runtime.fixtures[1]!.password);
      expect(
        (
          await other.request(
            "/api/organization?" +
              new URLSearchParams({ cursor: first.members.nextCursor! }),
          )
        ).status,
      ).toBe(400);
      await position("pagination-revision-change");
      expect(
        (
          await admin.request(
            "/api/organization?" +
              new URLSearchParams({ cursor: first.members.nextCursor! }),
          )
        ).status,
      ).toBe(409);
      for (const cursor of [
        "invalid",
        "!",
        Buffer.from(JSON.stringify([null])).toString("base64url"),
        Buffer.from(
          JSON.stringify([
            first.revision,
            "\u0000",
            ids[0],
            JSON.stringify([tenant, null]),
          ]),
        ).toString("base64url"),
        Buffer.from(
          JSON.stringify([
            -1,
            "username",
            ids[0],
            JSON.stringify([tenant, null]),
          ]),
        ).toString("base64url"),
      ])
        expect(
          (
            await admin.request(
              "/api/organization?" + new URLSearchParams({ cursor }),
            )
          ).status,
        ).toBe(400);
    } finally {
      await runtime.pool.query(
        "DELETE FROM organization_members WHERE tenant_id=$1 AND member_id=ANY($2::text[])",
        [tenant, ids],
      );
    }
  });
  async function snapshotWithCursor(
    cursor: string,
  ): Promise<OrganizationSnapshot> {
    const response = await admin.request(
      "/api/organization?" + new URLSearchParams({ cursor }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as OrganizationSnapshot;
  }
  it("invalidates an editor after actual role revocation and denies a logged-out edit without database mutation", async () => {
    const target = await createMember(["org:manage"]),
      editor = browser();
    await editor.login(target.password, target.username);
    expect((await editor.request("/api/organization")).status).toBe(200);
    expect(
      (
        await admin.change(
          `/api/members/${target.id}/roles/org:manage`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect((await editor.request("/api/organization")).status).toBe(401);
    const fresh = browser();
    await fresh.login(target.password, target.username);
    expect((await fresh.request("/api/organization")).status).toBe(403);
    const b = browser();
    await b.login(runtime.fixtures[0]!.password);
    const me = await b.me(),
      before = await snapshot();
    expect((await b.change("/auth/logout", undefined)).status).toBe(303);
    expect(
      (
        await b.request("/api/organization/positions", {
          method: "POST",
          headers: {
            Origin: b.origin,
            "x-csrf-token": me.csrfToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            revision: before.revision,
            name: "logged-out",
          }),
        })
      ).status,
    ).toBe(401);
    expect((await snapshot()).revision).toBe(before.revision);
  });
  it("serves organization registration and editing from the compiled HTTPS process", async () => {
    const child = await runtime.startCompiled(),
      b = new Browser(runtime.fetchLoopback, runtime.fixtures[0]!.origin);
    try {
      await b.login(runtime.fixtures[0]!.password);
      const member = await createMember([], false);
      expect(
        (
          await b.change(
            `/api/organization/members/${member.id}`,
            undefined,
            "PUT",
          )
        ).status,
      ).toBe(200);
      const current = await snapshot(b);
      expect(
        (
          await b.change("/api/organization/positions", {
            revision: current.revision,
            name: "compiled-organization",
          })
        ).status,
      ).toBe(201);
    } finally {
      await runtime.stop(child);
    }
    const logs = runtime.logs.join("");
    for (const value of runtime.secretValues) expect(logs).not.toContain(value);
  });
});
