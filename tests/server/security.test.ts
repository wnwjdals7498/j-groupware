import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { OidcClient } from "../../apps/server/src/oidc.js";
import {
  cookieValue,
  checkCsrf,
  randomToken,
} from "../../apps/server/src/security.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { visibleMenus, ROUTES } from "@j-groupware/permissions";
import { createApp } from "../../apps/server/src/app.js";
import type { Pool } from "pg";
import { serviceOrigin } from "../../apps/server/src/services.js";

describe("BFF cryptographic and request boundaries", () => {
  let key: Awaited<ReturnType<typeof generateKeyPair>>;
  const config = {
    tenant: "sample-a",
    origin: "https://gw.sample-a.jgw.test",
    keycloakOrigin: "https://auth.jgw.test",
    clientSecret: "unit-secret",
  };
  const issuer = config.keycloakOrigin + "/realms/tenant-sample-a";
  const nonce = randomToken();
  beforeAll(async () => {
    key = await generateKeyPair("RS256");
  });
  const sign = async (claims: JWTPayload) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .sign(key.privateKey);
  const claims = () => ({
    iss: issuer,
    aud: "j-groupware",
    azp: "j-groupware",
    sub: "member-1",
    sid: "sid-1",
    tenant: "sample-a",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const tokens = async (access: JWTPayload = {}, id: JWTPayload = {}) => ({
    access_token: await sign({
      ...claims(),
      typ: "Bearer",
      preferred_username: "member",
      resource_access: {
        "j-groupware": { roles: ["board:write", "board:read"] },
      },
      ...access,
    }),
    id_token: await sign({ ...claims(), nonce, ...id }),
    refresh_token: "unit-refresh",
  });
  const oidc = () =>
    new OidcClient(config, { keyResolver: async () => key.publicKey });
  const serviceClaims = () => ({
    ...claims(),
    aud: "j-mail",
    typ: "Bearer",
    resource_access: { "j-mail": { roles: ["mail:read"] } },
  });
  const serviceSession = {
    subject: "member-1",
    sid: "sid-1",
    roles: ["mail:read"],
  };
  it("validates a signed single-audience service token against its original session", async () => {
    expect(
      await oidc().validateServiceToken(
        await sign(serviceClaims()),
        "j-mail",
        serviceSession,
        ["mail:read"],
      ),
    ).toBeInstanceOf(Date);
  });
  it.each([
    { aud: ["j-mail", "j-messenger"] },
    { sub: "other" },
    { sid: "other" },
    { tenant: "sample-b" },
    { exp: Math.floor(Date.now() / 1000) + 10 },
    {
      resource_access: {
        "j-mail": { roles: ["mail:read"] },
        "j-messenger": { roles: ["messenger:use"] },
      },
    },
    { resource_access: { "j-mail": { roles: ["not-granted"] } } },
  ])("rejects signed service token widening/drift %j", async (claims) => {
    await expect(
      oidc().validateServiceToken(
        await sign({ ...serviceClaims(), ...claims }),
        "j-mail",
        serviceSession,
        ["mail:read"],
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    "https://attacker.test:54240",
    "http://localhost:54240",
    "http://127.0.0.1:3001",
    "http://127.0.0.1",
    "http://user:password@127.0.0.1:54240",
    "http://127.0.0.1:54240/path",
    "http://127.0.0.1:54240/?query=yes",
    "http://127.0.0.1:54240/#fragment",
  ])("rejects a non-canonical loopback endpoint %s", (value) =>
    expect(() => serviceOrigin(value)).toThrow(),
  );
  it("accepts signed ID/access claims and exposes only catalog roles", async () => {
    const identity = await oidc().validate(await tokens(), nonce);
    expect(identity.subject).toBe("member-1");
    expect(identity.roles).toEqual(["board:read", "board:write"]);
  });
  it.each([
    ["nonce", { nonce: "other" }],
    ["subject", { sub: "other" }],
    ["sid", { sid: "other" }],
    ["tenant", { tenant: "sample-b" }],
    ["issuer", { iss: issuer + "/wrong" }],
    ["audience", { aud: "j-console" }],
    ["azp", { azp: "j-console" }],
    ["multi-audience azp", { aud: ["j-groupware", "other"], azp: null }],
    ["at_hash", { at_hash: "wrong" }],
    ["expiry", { exp: 1 }],
    ["future issuance", { iat: Math.floor(Date.now() / 1000) + 60 }],
  ])("rejects ID %s mismatch", async (_name, id) => {
    await expect(
      oidc().validate(await tokens({}, id), nonce),
    ).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { tenant: "sample-b" },
    { aud: "j-talk" },
    { iss: config.keycloakOrigin + "/realms/operator" },
    { azp: "j-console" },
    { typ: "ID" },
    { sid: null },
  ])("rejects access identity drift %j", async (access) => {
    await expect(
      oidc().validate(await tokens(access), nonce),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("rejects missing ID, forged signature and refresh subject/sid drift", async () => {
    const issued = await tokens();
    await expect(
      oidc().validate({ ...issued, id_token: "" }, nonce),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      oidc().validate(
        {
          ...issued,
          id_token: issued.id_token.slice(0, -16) + "aaaaaaaaaaaaaaaa",
        },
        nonce,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      oidc().validate(issued, nonce, { subject: "other", sid: "sid-1" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      oidc().validate(issued, nonce, { subject: "member-1", sid: "other" }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("preserves verification-source failure as 503", async () => {
    const client = new OidcClient(config, {
      keyResolver: async () => {
        throw new Error("unavailable");
      },
    });
    await expect(client.validate(await tokens(), nonce)).rejects.toMatchObject({
      status: 503,
    });
  });
  const logoutClaims = () => ({
    ...claims(),
    jti: randomToken(),
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
  });
  it("accepts signed logout events and rejects access-token substitution", async () => {
    expect((await oidc().validateLogout(await sign(logoutClaims()))).sid).toBe(
      "sid-1",
    );
    await expect(
      oidc().validateLogout((await tokens()).access_token),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    { nonce: "unexpected" },
    { events: {} },
    { events: { "http://schemas.openid.net/event/backchannel-logout": [] } },
    { sid: null },
    { aud: "j-console" },
    { iss: issuer + "/other" },
    { iat: Math.floor(Date.now() / 1000) - 301 },
  ])("rejects invalid logout claims %j", async (overrides) => {
    await expect(
      oidc().validateLogout(await sign({ ...logoutClaims(), ...overrides })),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("rejects CSRF mismatches, non-ASCII and foreign origin without throwing a crypto length error", () => {
    const token = randomToken();
    expect(() =>
      checkCsrf(
        { origin: config.origin, "x-csrf-token": token },
        config.origin,
        token,
      ),
    ).not.toThrow();
    for (const value of [undefined, "wrong", "é".repeat(43), randomToken()])
      expect(() =>
        checkCsrf(
          { origin: config.origin, "x-csrf-token": value },
          config.origin,
          token,
        ),
      ).toThrow("CSRF");
    expect(() =>
      checkCsrf(
        { origin: "https://evil.jgw.test", "x-csrf-token": token },
        config.origin,
        token,
      ),
    ).toThrow("CSRF");
  });
  it("rejects duplicate and malformed cookies", () => {
    const token = randomToken();
    expect(cookieValue("other=x; session=" + token, "session")).toBe(token);
    expect(
      cookieValue("session=" + token + "; session=" + token, "session"),
    ).toBeUndefined();
    expect(cookieValue("session=%00", "session")).toBeUndefined();
  });
  it("uses catalog roles for menus and refuses an undeclared server route", () => {
    expect(visibleMenus([])).toEqual([]);
    expect(visibleMenus(["board:read"]).map((menu) => menu.id)).toEqual([
      "board",
    ]);
    expect(Object.values(ROUTES).every((access) => access.kind)).toBe(true);
    const app = createApp({ pool: {} as Pool, config });
    expect(() => app.get("/undeclared", async () => ({ ok: true }))).toThrow(
      "declare access",
    );
  });
  it("pins tenant, dedicated DB identity, HTTPS and external TLS files", () => {
    const env = {
      JGW_TENANT: "sample-a",
      JGW_PUBLIC_ORIGIN: config.origin,
      KC_PUBLIC_URL: config.keycloakOrigin,
      JGW_CLIENT_SECRET: "unit-client",
      JGW_DB_PASSWORD: "unit-db",
      JGW_TLS_CERTIFICATE: "/tmp/unit.crt",
      JGW_TLS_KEY: "/tmp/unit.key",
    };
    expect(loadConfig(env).database.database).toBe("jgw_groupware");
    for (const invalid of [
      { JGW_TENANT: "operator" },
      { JGW_PUBLIC_ORIGIN: "https://gw.sample-b.jgw.test" },
      { JGW_PUBLIC_ORIGIN: "http://gw.sample-a.jgw.test" },
      { JGW_DB_USER: "postgres" },
      { JGW_DB_NAME: "jauth" },
      { JGW_PORT: "3001" },
      { JGW_TLS_KEY: "/workspace/j-groupware/private.key" },
    ])
      expect(() => loadConfig({ ...env, ...invalid })).toThrow();
  });
});
