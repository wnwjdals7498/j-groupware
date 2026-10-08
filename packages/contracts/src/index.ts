export const SESSION_POLICY = {
  cookie: "__Host-jgw-session",
  flowCookie: "__Host-jgw-login",
  csrfHeader: "x-csrf-token",
  loginLifetimeSeconds: 300,
  idleSeconds: 1800,
  maxSeconds: 28800,
  refreshThresholdSeconds: 30,
} as const;

export interface MeResponse {
  readonly tenant: string;
  readonly subject: string;
  readonly username: string;
  readonly roles: readonly string[];
  readonly menus: readonly { id: string; label: string; path: string }[];
  readonly csrfToken: string;
}

export interface BoardPost {
  readonly id: string;
  readonly authorId: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface CreateBoardPost {
  readonly title: string;
  readonly body: string;
}
export interface BoardList {
  readonly items: readonly BoardPost[];
  readonly nextCursor: string | null;
}
export type {
  CreateMemberRequest,
  MemberResponse,
  MemberListResponse,
} from "@j-auth/contracts";
export interface GroupwareGrantableRoles {
  readonly roles: readonly {
    readonly name: string;
    readonly implies: readonly string[];
  }[];
}
