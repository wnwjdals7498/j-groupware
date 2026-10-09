const messages: Record<string, string> = {
  unauthenticated: "세션이 만료되었습니다. 다시 로그인해 주세요.",
  forbidden: "이 작업을 수행할 권한이 없습니다.",
  not_found: "항목을 찾을 수 없습니다. 목록을 새로 확인해 주세요.",
  conflict: "다른 변경 또는 중복 요청이 있습니다. 현재 상태를 확인해 주세요.",
  invalid_input: "입력 내용을 확인해 주세요.",
  rate_limited: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  unavailable:
    "처리 결과를 확인하지 못했습니다. 현재 목록을 확인한 뒤 다시 시도해 주세요.",
  member_created_incomplete:
    "회원 계정은 생성됐지만 조직도 등록이 완료되지 않았습니다. 회원 목록을 새로 확인한 뒤 해당 회원의 조직도 등록을 실행해 주세요.",
  member_roles_incomplete:
    "권한은 변경됐지만 세션 정리가 완료되지 않았습니다. 현재 권한을 확인하고 다시 시도해 주세요.",
  member_deleted_incomplete:
    "회원 계정은 삭제됐지만 조직도 또는 세션 정리가 완료되지 않았습니다. 목록을 확인하고 정리를 다시 시도해 주세요.",
};

const memberPartialMessages = new Map([
  [
    "Member created, but organisation registration is incomplete. Check the member list before retrying.",
    "member_created_incomplete",
  ],
  [
    "Roles changed, but local session cleanup is incomplete. Check the member roles before retrying.",
    "member_roles_incomplete",
  ],
  [
    "Member deleted, but local cleanup is incomplete. Check the member list before retrying.",
    "member_deleted_incomplete",
  ],
]);

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(messages[code] ?? messages.unavailable);
  }
}

export class Api {
  constructor(
    private readonly csrf: () => string | undefined,
    private readonly onExpired: () => void,
  ) {}

  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!/^\/api\/[A-Za-z0-9/_%?=&.-]+$/.test(path) && path !== "/auth/logout")
      throw new RequestError(400, "invalid_input");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      const token = this.csrf();
      if (!token) throw new RequestError(401, "unauthenticated");
      headers["x-csrf-token"] = token;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(signal ? [signal] : []),
        ]),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RequestError(503, "unavailable");
    }
    if (response.status === 401) this.onExpired();
    if (!response.ok) {
      const code = await response
        .json()
        .then((v: { code?: unknown; message?: unknown }) => {
          // Translate only exact fixed BFF outcomes, never arbitrary upstream messages.
          if (
            path.startsWith("/api/members") &&
            response.status === 503 &&
            v.code === "unavailable" &&
            typeof v.message === "string"
          )
            return memberPartialMessages.get(v.message) ?? "unavailable";
          return typeof v.code === "string" ? v.code : "unavailable";
        })
        .catch(() => "unavailable");
      throw new RequestError(response.status, code);
    }
    if (response.status === 204) return undefined as T;
    if (!response.headers.get("content-type")?.startsWith("application/json"))
      throw new RequestError(503, "unavailable");
    return response.json() as Promise<T>;
  }
}

export const encoded = (id: string) => encodeURIComponent(id);
export function errorText(error: unknown): string {
  return error instanceof RequestError ? error.message : messages.unavailable!;
}
