import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { parseMailPage, parseMailDetail } from "@j-mail/contracts";
import { Browser, integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import { createCapture } from "./mail-capture.js";
describe("actual BFF, compiled mail, network-none SMTP capture and reduced tokens", () => {
  let rt: Runtime,
    capture: Awaited<ReturnType<typeof createCapture>>,
    admin: Browser,
    second: Browser,
    member: Browser,
    denied: Browser,
    env: NodeJS.ProcessEnv;
  const children: ReturnType<typeof spawn>[] = [],
    logs: string[] = [],
    own: string[] = [],
    other: string[] = [];
  let memberId = "",
    memberPassword = "";
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  };
  const start = async (index: number) => {
    const root = fileURLToPath(new URL("../../../j-mail/", import.meta.url)),
      child = spawn(
        process.execPath,
        [
          "--import",
          root + "tests/integration/resolve-test-hosts.mjs",
          root + "apps/server/dist/main.js",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            ...env,
            JML_TENANT: rt.fixtures[index]!.tenant,
            JML_PORT: String(54310 + index * 4),
            JML_MAILPIT_URL: capture.origin,
          },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    children.push(child);
    child.stdout?.on("data", (b: Buffer) => logs.push(b.toString()));
    child.stderr?.on("data", (b: Buffer) => logs.push(b.toString()));
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null)
        throw new Error("Compiled mail fixture stopped.");
      try {
        if (
          (
            await rt.fetchLoopback(
              `https://mail.jgw.test:${54310 + index * 4}/health/ready`,
              { signal: AbortSignal.timeout(300) },
            )
          ).ok
        )
          return child;
      } catch {
        /* bounded readiness */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Compiled mail fixture not ready.");
  };
  beforeAll(async () => {
    env = parseEnv(
      await readFile(
        process.env.JML_TEST_ENV ??
          "/workspace/.suite-runtime/j-mail/integration.env",
        "utf8",
      ),
    );
    if (
      env.JML_TEST_RUNTIME !== "isolated-cloud" ||
      env.JML_DB_NAME !== "jgw_mail" ||
      env.JML_DB_USER !== "jgw_mail"
    )
      throw new Error("Dedicated isolated mail runtime required. No skip.");
    process.env.JGW_TEST_MAIL_CA = env.JML_TLS_CERTIFICATE;
    process.env.JML_TEST_RUNTIME = env.JML_TEST_RUNTIME;
    rt = await integrationRuntime({
      serviceCa: await readFile(env.JML_TLS_CERTIFICATE!, "utf8"),
      serviceEndpointsForTenant: (_t, i) => ({
        "j-mail": `https://127.0.0.1:${54310 + i * 4}`,
      }),
    });
    for (const [i] of rt.fixtures.entries())
      expect((await rt.subscribe(i, "j-mail")).status).toBe(200);
    capture = await createCapture(
      rt.fixtures[0]!.tenant,
      0,
      0,
      rt.fixtures.map((f) => f.tenant),
    );
    for (let i = 0; i < 6; i++)
      await capture.send(
        [`member@${rt.fixtures[i % 2]!.tenant}.jgw.test`],
        `From: sender@${rt.fixtures[0]!.tenant}.jgw.test\r\nTo: forged@${rt.fixtures[(i + 1) % 2]!.tenant}.jgw.test\r\nSubject: bff-mail-${i}\r\nContent-Type: text/html`,
        "<script>globalThis.mailUnsafe=true</script><p>private mail body</p>",
      );
    const native = (await capture.api("/api/v1/messages")) as {
      messages: { ID: string; Subject: string }[];
    };
    for (const m of native.messages)
      (Number(m.Subject.slice(-1)) % 2 ? other : own).push(m.ID);
    await start(0);
    await start(1);
    admin = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    second = new Browser(rt.fetch, rt.fixtures[1]!.origin);
    await admin.login(rt.fixtures[0]!.password);
    await second.login(rt.fixtures[1]!.password);
    for (let i = 0; i < 2; i++) {
      const username = "mail-bff-" + i,
        password = randomBytes(24).toString("base64url");
      rt.secretValues.add(password);
      const response = await admin.change("/api/members", {
        username,
        password,
        roles: i === 0 ? ["mail:read"] : [],
      });
      expect(response.status).toBe(201);
      const id = ((await response.json()) as { id: string }).id,
        browser = new Browser(rt.fetch, rt.fixtures[0]!.origin);
      await browser.login(password, username);
      if (i === 0) {
        member = browser;
        memberId = id;
        memberPassword = password;
      } else denied = browser;
    }
  });
  afterAll(async () => {
    try {
      for (const child of children) await stop(child);
      await capture?.close();
      await rt?.close();
    } finally {
      delete process.env.JGW_TEST_MAIL_CA;
      delete process.env.JML_TEST_RUNTIME;
    }
  });
  it("filters real mixed SMTP messages before BFF counts/page and isolates tenant detail", async () => {
    for (let offset = 0; offset <= 3; offset++) {
      const response = await admin.request(
        `/api/mail/messages?offset=${offset}&limit=1`,
      );
      expect(response.status).toBe(200);
      const page = parseMailPage(await response.json());
      expect(page.total).toBe(3);
      expect(page.items.map((m) => m.id)).toEqual(
        own.slice(offset, offset + 1),
      );
    }
    expect(
      parseMailPage(
        await (await second.request("/api/mail/messages")).json(),
      ).items.map((m) => m.id),
    ).toEqual(other);
    const foreign = await admin.request("/api/mail/messages/" + other[0]);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).not.toContain("bff-mail-");
    const native = (await capture.api("/api/v1/messages")) as {
      messages: { ID: string; Read: boolean }[];
    };
    expect(native.messages.find((m) => m.ID === other[0])!.Read).toBe(false);
  });
  it("returns headers/text/untrusted HTML as JSON with no token, cookie or native internal response fields", async () => {
    const response = await admin.request("/api/mail/messages/" + own[0]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const detail = parseMailDetail(await response.json());
    expect(detail.html).toContain("<script>");
    expect(detail.headers.Received![0]).toContain(
      rt.fixtures[0]!.tenant + ".jgw.test",
    );
    expect(detail).not.toHaveProperty("Read");
    const me = await admin.me(),
      rows = (
        await rt.pool.query(
          "SELECT s.access_token AS original,t.access_token AS reduced FROM sessions s JOIN service_tokens t USING(tenant_id,session_hash) WHERE s.tenant_id=$1 AND s.subject=$2 AND t.service_id='j-mail'",
          [rt.fixtures[0]!.tenant, me.subject],
        )
      ).rows;
    expect(rows).toHaveLength(1);
    expect(decodeJwt(rows[0].reduced).aud).toBe("j-mail");
    expect(rows[0].reduced).not.toBe(rows[0].original);
    for (const value of [rows[0].original, rows[0].reduced, ...rt.secretValues])
      expect(JSON.stringify(detail)).not.toContain(value);
  });
  it("shares the tenant inbox between owner and actual mail:read member", async () => {
    expect(
      parseMailPage(await (await member.request("/api/mail/messages")).json()),
    ).toEqual(
      parseMailPage(await (await admin.request("/api/mail/messages")).json()),
    );
  });
  it("rejects missing session, lacking role and source/tenant injection before service exchange", async () => {
    expect(
      (
        await new Browser(rt.fetch, rt.fixtures[0]!.origin).request(
          "/api/mail/messages",
        )
      ).status,
    ).toBe(401);
    expect((await denied.request("/api/mail/messages")).status).toBe(403);
    const before = rt.serviceTokenCount;
    for (const path of [
      "/api/mail/messages?tenant=other",
      "/api/mail/messages?url=http://example.invalid",
      "/api/mail/messages?limit=101",
      "/api/mail/messages/invalid",
    ])
      expect((await admin.request(path)).status).toBe(400);
    expect(rt.serviceTokenCount).toBe(before);
    expect((await admin.request("/api/v1/messages")).status).toBe(404);
  });
  it("returns safe 503 while actual Mailpit is stopped then recovers", async () => {
    capture.stopped();
    try {
      const response = await admin.request("/api/mail/messages");
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("bff-mail-");
    } finally {
      await capture.start();
    }
    expect((await admin.request("/api/mail/messages")).status).toBe(200);
  });
  it("returns 503 while actual compiled mail backend is stopped and resumes on restart", async () => {
    await stop(children[0]!);
    const response = await admin.request("/api/mail/messages");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private mail body");
    await start(0);
    expect((await admin.request("/api/mail/messages")).status).toBe(200);
  });
  it("revoking mail:read ends the actual target BFF session and future login has no mail access", async () => {
    expect(
      (
        await admin.change(
          `/api/members/${memberId}/roles/mail:read`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect((await member.request("/api/mail/messages")).status).toBe(401);
    const relogin = new Browser(rt.fetch, rt.fixtures[0]!.origin);
    await relogin.login(memberPassword, "mail-bff-0");
    expect((await relogin.request("/api/mail/messages")).status).toBe(403);
  });
  it("emits no fixture passwords, service keys, JWTs or mail body/subject in compiled logs", () => {
    const text = logs.join("");
    for (const value of rt.secretValues) expect(text).not.toContain(value);
    expect(text).not.toContain("private mail body");
    expect(text).not.toContain("bff-mail-");
  });
});
