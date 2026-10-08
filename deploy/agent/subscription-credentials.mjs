import { externalPath } from "../gateway/gateway.mjs";
import { readControlJson } from "./control-files.mjs";
import { ProvisionError } from "./provision-error.mjs";

// Supplied short-lived control-plane access token only. No passwords, grants,
// token issuance/refresh, permanent credential creation or BFF installation.
export class FileSubscriptionCredentials {
  constructor(file) {
    this.file = externalPath(file);
  }
  read = async () => {
    const value = await readControlJson(this.file, 20000);
    if (
      Object.keys(value).sort().join(",") !== "bearer,serviceKey" ||
      typeof value.bearer !== "string" ||
      value.bearer.length > 16384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.bearer) ||
      typeof value.serviceKey !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.serviceKey)
    )
      throw new ProvisionError("invalid_subscription_credentials");
    let claims;
    try {
      claims = JSON.parse(
        Buffer.from(value.bearer.split(".")[1], "base64url").toString("utf8"),
      );
    } catch {
      throw new ProvisionError("invalid_subscription_credentials");
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      !claims ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= now + 5 ||
      claims.exp > now + 900
    )
      throw new ProvisionError("expired_subscription_credentials");
    // This expiry check is only local input hygiene. j-auth verifies the actual
    // JWT signature, issuer/audience, operator role and console service key.
    return { bearer: value.bearer, serviceKey: value.serviceKey };
  };
}
