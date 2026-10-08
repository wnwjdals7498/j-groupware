import { createHash } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, errors } from "jose";
import type { JWTVerifyGetKey, JWTPayload } from "jose";
import {
  createTokenVerifier,
  TokenVerificationError,
} from "@j-auth/token-verifier";
import { CLIENT_IDS, customerRealmName } from "@j-auth/contracts";
import type { ServerConfig } from "./config.js";
import { ApiError, unauthenticated, unavailable } from "./errors.js";

interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
}
export interface LoginIdentity {
  subject: string;
  username: string;
  sid: string;
  roles: readonly string[];
  expires: Date;
}
export class OidcClient {
  readonly issuer: string;
  readonly endpoint: string;
  private readonly keys: JWTVerifyGetKey;
  private readonly access;
  private readonly fetch: typeof globalThis.fetch;
  constructor(
    private readonly config: Pick<
      ServerConfig,
      "tenant" | "origin" | "keycloakOrigin" | "clientSecret"
    >,
    options: {
      fetch?: typeof globalThis.fetch;
      keyResolver?: JWTVerifyGetKey;
    } = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.issuer = `${config.keycloakOrigin}/realms/${customerRealmName(config.tenant)}`;
    this.endpoint = this.issuer + "/protocol/openid-connect";
    this.keys =
      options.keyResolver ??
      createRemoteJWKSet(new URL(this.endpoint + "/certs"), {
        timeoutDuration: 5000,
        cacheMaxAge: 300000,
        cooldownDuration: 1000,
        [customFetch]: this.fetch,
      });
    this.access = createTokenVerifier({
      publicUrl: config.keycloakOrigin,
      fetch: this.fetch,
      ...(options.keyResolver ? { keyResolver: options.keyResolver } : {}),
    });
  }
  authorize(state: string, nonce: string, verifier: string): string {
    return (
      this.endpoint +
      "/auth?" +
      new URLSearchParams({
        client_id: CLIENT_IDS.groupware,
        response_type: "code",
        scope: "openid",
        redirect_uri: this.config.origin + "/auth/callback",
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      })
    );
  }
  logoutUrl(): string {
    // client_id permits RP logout without exposing an ID token in a browser URL.
    return (
      this.endpoint +
      "/logout?" +
      new URLSearchParams({
        client_id: CLIENT_IDS.groupware,
        post_logout_redirect_uri: this.config.origin + "/",
      })
    );
  }
  private async tokens(
    parameters: Record<string, string>,
    refresh: boolean,
  ): Promise<Tokens> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint + "/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({
          ...parameters,
          client_id: CLIENT_IDS.groupware,
          client_secret: this.config.clientSecret,
        }),
      });
    } catch {
      throw unavailable();
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      const error = (body as { error?: unknown })?.error;
      if (response.status === 400 && error === "invalid_grant")
        throw refresh
          ? unauthenticated()
          : new ApiError(
              400,
              "invalid_input",
              "Authorization code was rejected.",
            );
      throw unavailable();
    }
    const value = body as Partial<Tokens>;
    if (
      typeof value.access_token !== "string" ||
      value.access_token.length > 16384 ||
      typeof value.refresh_token !== "string" ||
      !value.refresh_token ||
      value.refresh_token.length > 16384 ||
      (!refresh && typeof value.id_token !== "string")
    )
      throw unavailable();
    return value as Tokens;
  }
  private verificationError(error: unknown): never {
    if (error instanceof ApiError) throw error;
    if (error instanceof TokenVerificationError)
      throw error.kind === "invalid" ? unauthenticated() : unavailable();
    if (
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JWTExpired ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JOSEAlgNotAllowed ||
      error instanceof errors.JOSENotSupported ||
      error instanceof errors.JWKSNoMatchingKey
    )
      throw unauthenticated();
    throw unavailable();
  }
  async validate(
    tokens: Tokens,
    nonce: string,
    previous?: { subject: string; sid: string },
  ): Promise<LoginIdentity> {
    try {
      const identity = await this.access.verify(tokens.access_token, {
        tenantId: this.config.tenant,
        audience: CLIENT_IDS.groupware,
      });
      const access = identity.claims;
      if (
        typeof access.sid !== "string" ||
        !access.sid ||
        typeof access.preferred_username !== "string" ||
        !access.preferred_username ||
        typeof access.exp !== "number"
      )
        throw unauthenticated();
      if (tokens.id_token) {
        if (tokens.id_token.length > 16384) throw unauthenticated();
        const { payload: id } = await jwtVerify(tokens.id_token, this.keys, {
          algorithms: ["RS256"],
          issuer: this.issuer,
          audience: CLIENT_IDS.groupware,
          requiredClaims: ["sub", "iss", "aud", "exp", "iat", "sid", "tenant"],
        });
        if (
          id.sub !== identity.subject ||
          id.sid !== access.sid ||
          id.tenant !== this.config.tenant ||
          (id.azp !== undefined && id.azp !== CLIENT_IDS.groupware) ||
          (!previous && id.nonce !== nonce) ||
          (previous && id.nonce !== undefined && id.nonce !== nonce) ||
          typeof id.iat !== "number" ||
          id.iat > Math.floor(Date.now() / 1000) + 30
        )
          throw unauthenticated();
        if (
          Array.isArray(id.aud) &&
          id.aud.length > 1 &&
          id.azp !== CLIENT_IDS.groupware
        )
          throw unauthenticated();
        if (
          id.at_hash !== undefined &&
          id.at_hash !==
            createHash("sha256")
              .update(tokens.access_token)
              .digest()
              .subarray(0, 16)
              .toString("base64url")
        )
          throw unauthenticated();
      } else if (!previous) throw unauthenticated();
      if (
        previous &&
        (previous.subject !== identity.subject || previous.sid !== access.sid)
      )
        throw unauthenticated();
      return {
        subject: identity.subject,
        username: access.preferred_username,
        sid: access.sid,
        roles: identity.roles,
        expires: new Date(access.exp * 1000),
      };
    } catch (error) {
      return this.verificationError(error);
    }
  }
  async exchange(code: string, verifier: string, nonce: string) {
    const tokens = await this.tokens(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: this.config.origin + "/auth/callback",
      },
      false,
    );
    return { tokens, identity: await this.validate(tokens, nonce) };
  }
  async refresh(
    refreshToken: string,
    nonce: string,
    previous: { subject: string; sid: string },
  ) {
    const tokens = await this.tokens(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      true,
    );
    return { tokens, identity: await this.validate(tokens, nonce, previous) };
  }
  async serviceToken(
    subjectToken: string,
    audience: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const abort = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);
    let response: Response;
    try {
      response = await this.fetch(this.endpoint + "/token", {
        method: "POST",
        redirect: "error",
        signal: abort,
        body: new URLSearchParams({
          client_id: CLIENT_IDS.groupware,
          client_secret: this.config.clientSecret,
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: subjectToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          audience,
        }),
      });
    } catch {
      signal?.throwIfAborted();
      throw unavailable();
    }
    let body: {
      access_token?: unknown;
      token_type?: unknown;
      issued_token_type?: unknown;
      error?: unknown;
    };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      signal?.throwIfAborted();
      throw unavailable();
    }
    if (!response.ok) {
      if (
        [400, 403].includes(response.status) &&
        ["invalid_target", "access_denied"].includes(String(body?.error))
      )
        throw new ApiError(403, "forbidden", "Service token denied.");
      throw unavailable();
    }
    if (
      !body ||
      typeof body.access_token !== "string" ||
      !body.access_token ||
      body.access_token.length > 16384 ||
      body.token_type !== "Bearer" ||
      body.issued_token_type !== "urn:ietf:params:oauth:token-type:access_token"
    )
      throw unavailable();
    signal?.throwIfAborted();
    return body.access_token;
  }
  async validateServiceToken(
    token: string,
    audience: string,
    session: { subject: string; sid: string; roles: readonly string[] },
    allowedRoles: readonly string[],
  ): Promise<Date> {
    try {
      const identity = await this.access.verify(token, {
        tenantId: this.config.tenant,
        audience,
      });
      const claims = identity.claims;
      const audiences =
        typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      const resources = claims.resource_access as
        Record<string, { roles?: unknown }> | undefined;
      const assigned = resources?.[audience]?.roles;
      if (
        !Array.isArray(audiences) ||
        audiences.length !== 1 ||
        audiences[0] !== audience ||
        identity.subject !== session.subject ||
        claims.sid !== session.sid ||
        typeof claims.exp !== "number" ||
        claims.exp * 1000 <= Date.now() + 30000 ||
        !Array.isArray(assigned) ||
        !assigned.length ||
        assigned.some(
          (role) =>
            typeof role !== "string" ||
            !allowedRoles.includes(role) ||
            !session.roles.includes(role),
        ) ||
        Object.keys(resources ?? {}).some((client) => client !== audience)
      )
        throw unavailable();
      return new Date(claims.exp * 1000);
    } catch {
      throw unavailable();
    }
  }
  async validateLogout(
    token: string,
  ): Promise<JWTPayload & { sid: string; jti: string }> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ["RS256"],
        issuer: this.issuer,
        audience: CLIENT_IDS.groupware,
        requiredClaims: ["iss", "aud", "iat", "jti", "sid"],
      });
      const now = Math.floor(Date.now() / 1000);
      const event = (payload.events as Record<string, unknown> | undefined)?.[
        "http://schemas.openid.net/event/backchannel-logout"
      ];
      if (
        typeof payload.sid !== "string" ||
        !payload.sid ||
        typeof payload.jti !== "string" ||
        !payload.jti ||
        typeof payload.iat !== "number" ||
        payload.iat > now + 30 ||
        payload.iat < now - 300 ||
        payload.nonce !== undefined ||
        !event ||
        typeof event !== "object" ||
        Array.isArray(event) ||
        (payload.sub !== undefined && typeof payload.sub !== "string")
      )
        throw unauthenticated();
      return payload as JWTPayload & { sid: string; jti: string };
    } catch (error) {
      try {
        this.verificationError(error);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401)
          throw new ApiError(400, "invalid_input", "Invalid logout token.");
        throw e;
      }
      throw unavailable();
    }
  }
}
