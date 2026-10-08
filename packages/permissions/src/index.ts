import { SERVICE_CATALOG } from "@j-auth/contracts";
import type { FunctionalRoleName } from "@j-auth/contracts";

export type Access =
  | { readonly kind: "public" | "oidc" | "backchannel" }
  | { readonly kind: "session"; readonly role?: FunctionalRoleName };

export const ROUTES = {
  "GET /": { kind: "public" },
  "GET /health/live": { kind: "public" },
  "GET /health/ready": { kind: "public" },
  "GET /auth/login": { kind: "oidc" },
  "GET /auth/callback": { kind: "oidc" },
  "POST /auth/logout": { kind: "session" },
  "POST /auth/backchannel-logout": { kind: "backchannel" },
  "GET /api/mail/messages": { kind: "session", role: "mail:read" },
  "GET /api/mail/messages/:id": { kind: "session", role: "mail:read" },
  "GET /api/me": { kind: "session" },
  "GET /api/board/posts": { kind: "session", role: "board:read" },
  "GET /api/board/posts/:id": { kind: "session", role: "board:read" },
  "POST /api/board/posts": { kind: "session", role: "board:write" },
  "GET /api/members": { kind: "session", role: "member:manage" },
  "GET /api/members/grantable-roles": {
    kind: "session",
    role: "member:manage",
  },
  "POST /api/members": { kind: "session", role: "member:manage" },
  "PUT /api/members/:id/roles/:role": {
    kind: "session",
    role: "member:manage",
  },
  "DELETE /api/members/:id/roles/:role": {
    kind: "session",
    role: "member:manage",
  },
  "DELETE /api/members/:id": { kind: "session", role: "member:manage" },
  "POST /api/members/:id/organization": {
    kind: "session",
    role: "member:manage",
  },
  "GET /api/organization": { kind: "session", role: "org:manage" },
  "PUT /api/organization/members/:id": { kind: "session", role: "org:manage" },
  "PATCH /api/organization/members/:id": {
    kind: "session",
    role: "org:manage",
  },
  "POST /api/organization/departments": { kind: "session", role: "org:manage" },
  "PATCH /api/organization/departments/:id": {
    kind: "session",
    role: "org:manage",
  },
  "DELETE /api/organization/departments/:id": {
    kind: "session",
    role: "org:manage",
  },
  "POST /api/organization/positions": { kind: "session", role: "org:manage" },
  "PATCH /api/organization/positions/:id": {
    kind: "session",
    role: "org:manage",
  },
  "DELETE /api/organization/positions/:id": {
    kind: "session",
    role: "org:manage",
  },
  "GET /api/organization/candidates": { kind: "session", role: "approval:use" },
  "GET /api/organization/approval-line": {
    kind: "session",
    role: "approval:use",
  },
  "POST /api/organization/approval-line/validate": {
    kind: "session",
    role: "approval:use",
  },
  "GET /api/messenger/ws": { kind: "session", role: "messenger:use" },
  "GET /api/messenger/api/v1/me": { kind: "session", role: "messenger:use" },
  "GET /api/messenger/api/v1/users": { kind: "session", role: "messenger:use" },
  "GET /api/messenger/api/v1/conversations": {
    kind: "session",
    role: "messenger:use",
  },
  "POST /api/messenger/api/v1/conversations": {
    kind: "session",
    role: "messenger:use",
  },
  "GET /api/messenger/api/v1/conversations/:id/messages": {
    kind: "session",
    role: "messenger:use",
  },
  "POST /api/messenger/api/v1/conversations/:id/messages": {
    kind: "session",
    role: "messenger:use",
  },
  "GET /api/messenger/api/v1/conversations/:id/read": {
    kind: "session",
    role: "messenger:use",
  },
  "PUT /api/messenger/api/v1/conversations/:id/read": {
    kind: "session",
    role: "messenger:use",
  },
  "GET /api/messenger/api/v1/sync": { kind: "session", role: "messenger:use" },
  "GET /api/notifications/stream": { kind: "session" },
  "GET /api/notifications": { kind: "session" },
  "POST /api/notifications/:id/read": { kind: "session" },
  "POST /api/approval/documents": { kind: "session", role: "approval:use" },
  "GET /api/approval/documents": { kind: "session", role: "approval:use" },
  "GET /api/approval/documents/:id": { kind: "session", role: "approval:use" },
  "GET /api/approval/documents/:id/history": {
    kind: "session",
    role: "approval:use",
  },
  "POST /api/approval/documents/:id/decisions": {
    kind: "session",
    role: "approval:use",
  },
} as const satisfies Record<string, Access>;

export const MENUS = [
  { id: "board", label: "게시판", path: "/board", role: "board:read" },
  {
    id: "members",
    label: "회원 관리",
    path: "/members",
    role: "member:manage",
  },
  {
    id: "organization",
    label: "조직도",
    path: "/organization",
    role: "org:manage",
  },
  {
    id: "messenger",
    label: "메신저",
    path: "/messenger",
    role: "messenger:use",
  },
  { id: "mail", label: "메일", path: "/mail", role: "mail:read" },
  { id: "guests", label: "손님", path: "/guests", role: "guest:read" },
  { id: "approval", label: "결재", path: "/approval", role: "approval:use" },
  { id: "talk", label: "상담", path: "/talk", role: "talk:read" },
  { id: "web", label: "웹 관리", path: "/web", role: "web:read" },
] as const;

const known = new Set(
  SERVICE_CATALOG.flatMap((service) => service.roles.map((role) => role.name)),
);
for (const entry of [...Object.values(ROUTES), ...MENUS]) {
  if ("role" in entry && !known.has(entry.role))
    throw new Error("Unknown permission role.");
}

export function visibleMenus(roles: readonly string[]) {
  return MENUS.filter((menu) => roles.includes(menu.role)).map(
    ({ id, label, path }) => ({ id, label, path }),
  );
}
