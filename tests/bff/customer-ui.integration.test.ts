import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { MeResponse } from "@j-groupware/contracts";
import { Browser, integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { customerBrowser } from "./customer-browser.js";

describe("customer app on actual HTTPS BFF, Keycloak and PostgreSQL", () => {
  let rt: Runtime,
    admin: Awaited<ReturnType<typeof customerBrowser>>,
    member: Awaited<ReturnType<typeof customerBrowser>>;
  let memberId = "",
    memberPassword = "";
  beforeAll(async () => {
    rt = await integrationRuntime();
    admin = await customerBrowser(rt);
  });
  afterAll(async () => {
    await member?.close();
    await admin?.close();
    await rt?.close();
  });

  it("logs in through the real themed Keycloak browser flow and receives only a protected session cookie", async () => {
    const page = admin.page;
    const initial = await page.goto(admin.origin + "/");
    expect(initial?.status()).toBe(200);
    expect(initial?.headers()["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    await page.getByRole("link", { name: "로그인", exact: true }).click();
    await page.locator("#username").fill("owner");
    await page.locator("#password").fill(rt.fixtures[0]!.password);
    const style = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--jgw-color-primary")
        .trim(),
    );
    expect(style).toBe("#2454d6");
    await page.locator("#kc-login").click();
    await page.getByRole("heading", { name: "업무 홈", exact: true }).waitFor();
    const cookies = await admin.context.cookies(admin.origin);
    const session = cookies.find((item) => item.name === "__Host-jgw-session");
    expect(session?.secure).toBe(true);
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");
    const storage = await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
    }));
    expect(storage).toEqual({ local: 0, session: 0, cookie: "" });
    expect(admin.pageErrors).toEqual([]);
  });

  it("creates a member from the business screen, grants write-implies-read and preserves the actual organization registration", async () => {
    const page = admin.page;
    await page.getByRole("link", { name: "회원 관리", exact: true }).click();
    await page
      .getByRole("heading", { name: "회원 관리", exact: true })
      .waitFor();
    memberPassword = randomBytes(24).toString("base64url");
    rt.secretValues.add(memberPassword);
    const form = page.getByRole("form", { name: "회원 추가" });
    await form.getByLabel("계정 이름").fill("ui-member");
    await form.getByLabel("초기 비밀번호").fill(memberPassword);
    await form.getByLabel("board:write", { exact: true }).check();
    expect(
      await form
        .getByLabel("board:read (쓰기 권한에 포함)", { exact: true })
        .isDisabled(),
    ).toBe(true);
    await form.getByRole("button", { name: "회원 추가", exact: true }).click();
    await page
      .getByRole("button", { name: "권한 편집 ui-member", exact: true })
      .waitFor();
    expect(await form.getByLabel("초기 비밀번호").inputValue()).toBe("");
    const me = (await page.evaluate(
      async () => await (await fetch("/api/me")).json(),
    )) as MeResponse;
    const result = (await page.evaluate(
      async () => await (await fetch("/api/members")).json(),
    )) as { items: { id: string; username: string; roles: string[] }[] };
    const created = result.items.find((item) => item.username === "ui-member")!;
    memberId = created.id;
    expect(created.roles).toContain("board:write");
    expect(created.roles).toContain("board:read");
    expect(
      (
        await rt.pool.query(
          "SELECT department_id FROM organization_members WHERE tenant_id=$1 AND member_id=$2",
          [me.tenant, memberId],
        )
      ).rows[0]?.department_id,
    ).toBeNull();
    const http = new Browser(rt.fetch, admin.origin);
    await http.login(memberPassword, "ui-member");
    member = await customerBrowser(rt, http);
    await member.page.goto(member.origin + "/");
    await member.page
      .getByRole("link", { name: "게시판", exact: true })
      .waitFor();
    expect(
      await member.page
        .getByRole("link", { name: "회원 관리", exact: true })
        .count(),
    ).toBe(0);
    expect(
      await member.page.evaluate(async () => (await fetch("/members")).status),
    ).toBe(403);
    expect(
      await member.page.evaluate(
        async () => (await fetch("/api/members")).status,
      ),
    ).toBe(403);
  });

  it("writes and reads escaped board content in Chromium and proves the persisted author and body", async () => {
    const page = member.page;
    await page.getByRole("link", { name: "게시판", exact: true }).click();
    const form = page.getByRole("form", { name: "게시글 작성" });
    await form.getByLabel("제목", { exact: true }).fill("브라우저 업무 글");
    const unsafe = '<img src=x onerror="window.__uiXss=true">';
    await form.getByLabel("본문", { exact: true }).fill(unsafe);
    await form.getByRole("button", { name: "게시", exact: true }).click();
    await page
      .getByRole("button", { name: "브라우저 업무 글", exact: true })
      .click();
    await page.getByRole("dialog", { name: "브라우저 업무 글" }).waitFor();
    expect(
      await page.getByRole("dialog").locator(".plain-body").textContent(),
    ).toBe(unsafe);
    expect(await page.getByRole("dialog").locator("img").count()).toBe(0);
    expect(await page.evaluate(() => "__uiXss" in window)).toBe(false);
    const row = (
      await rt.pool.query(
        "SELECT author_id,body FROM board_posts WHERE tenant_id=$1 AND title=$2",
        [rt.fixtures[0]!.tenant, "브라우저 업무 글"],
      )
    ).rows[0];
    expect(row?.author_id).toBe(memberId);
    expect(row?.body).toBe(unsafe);
  });

  it("edits department, position and member placement with real revision checks and usable mobile navigation", async () => {
    const page = admin.page;
    await page.getByRole("link", { name: "조직도", exact: true }).click();
    const department = page.getByRole("form", { name: "부서 추가" });
    await department.getByLabel("새 부서 이름").fill("브라우저 부서");
    await department
      .getByRole("button", { name: "부서 추가", exact: true })
      .click();
    await page
      .getByRole("button", { name: "부서 편집 브라우저 부서", exact: true })
      .waitFor();
    const position = page.getByRole("form", { name: "직책 추가" });
    await position.getByLabel("새 직책 이름").fill("브라우저 직책");
    await position
      .getByRole("button", { name: "직책 추가", exact: true })
      .click();
    await page
      .getByRole("button", { name: "직책 편집 브라우저 직책", exact: true })
      .waitFor();
    const placement = page.getByRole("form", {
      name: "ui-member 배치",
      exact: true,
    });
    await placement
      .getByLabel("소속 부서")
      .selectOption({ label: "브라우저 부서" });
    await placement
      .getByLabel("직책", { exact: true })
      .selectOption({ label: "브라우저 직책" });
    await placement
      .getByRole("button", { name: "배치 저장 ui-member", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "변경 사항이 반영되었습니다." })
      .first()
      .waitFor();
    const row = (
      await rt.pool.query(
        "SELECT d.name AS department,p.name AS position FROM organization_members m JOIN organization_departments d ON d.tenant_id=m.tenant_id AND d.id=m.department_id JOIN organization_positions p ON p.tenant_id=m.tenant_id AND p.id=m.position_id WHERE m.tenant_id=$1 AND m.member_id=$2",
        [rt.fixtures[0]!.tenant, memberId],
      )
    ).rows[0];
    expect(row).toEqual({
      department: "브라우저 부서",
      position: "브라우저 직책",
    });
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
    }
    expect(admin.pageErrors).toEqual([]);
  });

  it("reports actual partial member creation and recovers organization registration before deleting the created account", async () => {
    const page = admin.page;
    await page.getByRole("link", { name: "회원 관리", exact: true }).click();
    const password = randomBytes(24).toString("base64url");
    rt.secretValues.add(password);
    await rt.pool.query(
      "CREATE FUNCTION fixture_ui_org_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated UI registration failure'; END $$; CREATE TRIGGER fixture_ui_org_fail BEFORE INSERT ON organization_members FOR EACH ROW WHEN (NEW.username='ui-incomplete') EXECUTE FUNCTION fixture_ui_org_fail()",
    );
    try {
      const form = page.getByRole("form", { name: "회원 추가" });
      await form.getByLabel("계정 이름").fill("ui-incomplete");
      await form.getByLabel("초기 비밀번호").fill(password);
      await form
        .getByRole("button", { name: "회원 추가", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({
          hasText: "회원 계정은 생성됐지만 조직도 등록이 완료되지 않았습니다.",
        })
        .waitFor();
      expect(await form.getByLabel("초기 비밀번호").inputValue()).toBe("");
      expect(
        (
          await rt.pool.query(
            "SELECT 1 FROM organization_members WHERE tenant_id=$1 AND username=$2",
            [rt.fixtures[0]!.tenant, "ui-incomplete"],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await rt.pool.query(
        "DROP TRIGGER fixture_ui_org_fail ON organization_members; DROP FUNCTION fixture_ui_org_fail()",
      );
    }
    await page
      .getByRole("button", { name: "현재 목록 확인", exact: true })
      .click();
    await page
      .getByRole("button", { name: "조직도 등록 ui-incomplete", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "조직도 등록 상태를 확인했습니다." })
      .waitFor();
    expect(
      (
        await rt.pool.query(
          "SELECT 1 FROM organization_members WHERE tenant_id=$1 AND username=$2",
          [rt.fixtures[0]!.tenant, "ui-incomplete"],
        )
      ).rowCount,
    ).toBe(1);
    await page
      .getByRole("button", { name: "삭제 ui-incomplete", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "회원 삭제 확인" })
      .getByRole("button", { name: "확인", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "변경 사항이 반영되었습니다." })
      .waitFor();
    expect(
      (
        await rt.pool.query(
          "SELECT 1 FROM organization_members WHERE tenant_id=$1 AND username=$2",
          [rt.fixtures[0]!.tenant, "ui-incomplete"],
        )
      ).rowCount,
    ).toBe(0);
    await page
      .getByRole("button", { name: "삭제 ui-incomplete", exact: true })
      .waitFor({ state: "hidden" });
    expect(admin.pageErrors).toEqual([]);
  });

  it("revokes a role from the screen and the existing member browser loses its actual BFF session", async () => {
    const page = admin.page;
    await page.getByRole("link", { name: "회원 관리", exact: true }).click();
    await page
      .getByRole("button", { name: "권한 편집 ui-member", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "ui-member 권한 편집" });
    await dialog.getByLabel("board:write", { exact: true }).click();
    await dialog
      .getByRole("status")
      .filter({ hasText: "권한을 반영했습니다" })
      .waitFor();
    expect(
      await member.page.evaluate(async () => (await fetch("/api/me")).status),
    ).toBe(401);
    await member.page.reload();
    await member.page
      .getByRole("link", { name: "로그인", exact: true })
      .waitFor();
    expect(
      await admin.page.evaluate(async () => (await fetch("/api/me")).status),
    ).toBe(200);
  });
});
