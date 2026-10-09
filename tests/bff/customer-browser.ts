import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import type { Browser as HttpBrowser, Runtime } from "./runtime.js";

export async function customerBrowser(rt: Runtime, login?: HttpBrowser) {
  const profile = await mkdtemp(tmpdir() + "/jgw-customer-browser-");
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath:
        process.env.JGW_CHROMIUM_PATH ?? "/usr/lib/chromium/chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      timeout: 20000,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-breakpad",
        "--no-proxy-server",
        `--host-resolver-rules=MAP gw.*.jgw.test ${process.env.JGW_TEST_BIND_IP}, MAP *.jgw.test 127.0.0.1, EXCLUDE localhost`,
      ],
      env: {
        ...process.env,
        TMPDIR: "/tmp",
        XDG_CACHE_HOME: profile + "/cache",
        XDG_CONFIG_HOME: profile + "/config",
      },
      viewport: { width: 1440, height: 900 },
    });
    if (login) {
      await context.addCookies(
        [...(login.cookies.get(new URL(login.origin).origin) ?? [])]
          .filter(([name]) => name === "__Host-jgw-session")
          .map(([name, value]) => ({
            name,
            value,
            domain: new URL(login.origin).hostname,
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Lax" as const,
          })),
      );
    }
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const pageErrors: string[] = [];
    page.on("pageerror", () => pageErrors.push("browser_script_error"));
    return {
      context,
      page,
      pageErrors,
      origin: login?.origin ?? rt.fixtures[0]!.origin,
      close: async () => {
        await context!.close();
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
