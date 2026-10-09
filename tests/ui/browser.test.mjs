import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const ms = resolve(repo, "node_modules/@j-messenger/client-react");
const { createServer } = createRequire(resolve(repo, "package.json"))("vite");
const { chromium } = await import(
  `${repo}/node_modules/@playwright/test/index.mjs`
);

test("공통 UI 공개 컴포넌트와 메신저 공개 앱을 실제 Chromium에서 확인한다", async () => {
  const vite = await createServer({
    configFile: false,
    root: here,
    cacheDir: process.env.VITE_CACHE_DIR ?? "/tmp/jgw-ui-vite-cache",
    resolve: {
      alias: [
        {
          find: /^@j-groupware\/ui$/,
          replacement: resolve(repo, "packages/ui/dist/index.js"),
        },
        {
          find: /^@j-groupware\/ui\/styles\.css$/,
          replacement: resolve(repo, "packages/ui/dist/styles.css"),
        },
        {
          find: /^@j-messenger\/client-react$/,
          replacement: `${ms}/dist/index.js`,
        },
        {
          find: /^@j-messenger\/client-react\/styles\.css$/,
          replacement: `${ms}/dist/messenger.css`,
        },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      fs: { allow: [repo, ms] },
    },
    logLevel: "error",
  });
  let context;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address === "object");
    assert.notEqual(address.port, 3001);
    const profile =
      process.env.JGW_PROFILE_DIR ??
      `${process.env.TMPDIR ?? "/tmp"}/jgw-ui-profile`;
    await mkdir(profile, { recursive: true });
    context = await chromium.launchPersistentContext(profile, {
      executablePath:
        process.env.JGW_CHROMIUM_PATH ?? "/usr/lib/chromium/chromium",
      headless: true,
      timeout: 20_000,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-breakpad"],
      env: { ...process.env, TMPDIR: process.env.TMPDIR ?? "/tmp" },
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${address.port}/fixture.html`);
    await page
      .getByRole("heading", { name: "브라우저 컴포넌트 시험" })
      .waitFor();

    const field = page.getByRole("textbox", { name: "표시 이름" });
    assert.equal(await field.getAttribute("aria-invalid"), "true");
    assert.ok(await field.getAttribute("aria-describedby"));
    assert.equal(
      await page.getByRole("alert").textContent(),
      "표시 이름을 입력해 주세요.",
    );
    await page
      .getByRole("region", { name: "최근 항목" })
      .getByText("데이터가 없습니다.")
      .waitFor();
    assert.match(
      await page.getByRole("status").textContent(),
      /변경 사항이 저장되었습니다/,
    );
    const unsafe = '<img src=x onerror="window.__xss=true">';
    assert.equal(
      await page.locator(".jgw-empty-state h2").textContent(),
      unsafe,
    );
    assert.equal(await page.locator(".jgw-empty-state img").count(), 0);
    assert.equal(await page.evaluate(() => window.__xss ?? false), false);

    const trigger = page.getByRole("button", { name: "대화상자 열기" });
    await trigger.focus();
    await trigger.press("Enter");
    const dialog = page.getByRole("dialog", { name: "키보드 대화상자" });
    await dialog.waitFor();
    const close = dialog.getByRole("button", { name: "닫기" });
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "닫기",
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent?.trim()),
      "완료",
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "닫기",
    );
    assert.equal(
      await close.evaluate((el) => getComputedStyle(el).outlineWidth),
      "3px",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      await trigger.evaluate((el) => el === document.activeElement),
      true,
    );

    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return {
          width: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          primary: root.getPropertyValue("--jgw-color-primary").trim(),
          text: root.getPropertyValue("--jgw-color-text").trim(),
          surface: root.getPropertyValue("--jgw-color-surface").trim(),
          background: root.getPropertyValue("--jgw-color-background").trim(),
          spacing: root.getPropertyValue("--jgw-space-4").trim(),
          columns: getComputedStyle(document.querySelector(".jgw-app-shell"))
            .gridTemplateColumns,
          messengerSurface: getComputedStyle(
            document.querySelector(".login-card"),
          ).backgroundColor,
          messengerFont: getComputedStyle(document.querySelector(".login-card"))
            .fontFamily,
        };
      });
      assert.ok(
        metrics.scroll <= metrics.width,
        `${width}px overflow: ${metrics.scroll}`,
      );
      assert.deepEqual(
        [
          metrics.primary,
          metrics.text,
          metrics.surface,
          metrics.background,
          metrics.spacing,
        ],
        ["#2454d6", "#172033", "#fff", "#f3f6fb", "16px"],
      );
      assert.match(metrics.messengerFont, /system-ui/);
      assert.notEqual(metrics.messengerSurface, "rgba(0, 0, 0, 0)");
      if (width === 360) assert.equal(metrics.columns, "360px");
      if (width === 1440) assert.match(metrics.columns, /^256px /);
    }

    await page.getByRole("heading", { name: "J 메신저" }).waitFor();
    assert.equal(await page.getByLabel("서버").inputValue(), "fixture");
    assert.equal(
      await page
        .locator(".brand-mark")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(36, 84, 214)",
    );
    const provenance = await page.evaluate(() => window.__fixtureProvenance);
    assert.equal(provenance.acceptance_complete, false);
    assert.match(provenance.source, /fake Messenger API/);
    assert.deepEqual(provenance.not_run_list, [
      "전체 제품 UI",
      "실제 Keycloak 로그인",
      "실제 메신저 API",
    ]);
    assert.equal(await page.evaluate(() => window.__xss ?? false), false);
  } finally {
    await context?.close();
    await vite.close();
  }
});
