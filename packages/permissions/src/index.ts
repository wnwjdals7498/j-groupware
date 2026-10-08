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
  "GET /api/me": { kind: "session" },
  "GET /api/board/posts": { kind: "session", role: "board:read" },
  "GET /api/board/posts/:id": { kind: "session", role: "board:read" },
  "POST /api/board/posts": { kind: "session", role: "board:write" },
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
