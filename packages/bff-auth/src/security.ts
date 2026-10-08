import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SESSION_POLICY } from "@j-groupware/contracts";
import { ApiError } from "./errors.js";
export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  const matches = (header ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(name + "="));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function checkCsrf(
  headers: Record<string, unknown>,
  origin: string,
  expected: string,
): void {
  const supplied = headers[SESSION_POLICY.csrfHeader];
  if (
    headers.origin !== origin ||
    typeof supplied !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    throw new ApiError(403, "forbidden", "CSRF validation failed.");
}
