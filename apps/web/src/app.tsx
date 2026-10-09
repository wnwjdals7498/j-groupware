import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell, Button, Card } from "@j-groupware/ui";
import { MENUS } from "@j-groupware/permissions";
import type { MeResponse } from "@j-groupware/contracts";
import { Api, RequestError, errorText } from "./api.js";
import { Feedback } from "./common.js";
import { Board } from "./board.js";
import { Members } from "./members.js";
import { Organization } from "./organization.js";
import { Mail } from "./mail.js";
import { Guests } from "./guests.js";
import { Approval } from "./approval.js";
import { Talk } from "./talk.js";
import { TalkSettings } from "./talk-settings.js";
import { WebSites } from "./web-sites.js";
import { Messenger } from "./messenger.js";
import { Notifications, useNotificationFeed } from "./notifications.js";

export function App() {
  const [me, setMe] = useState<MeResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [path, setPath] = useState(location.pathname);
  const identity = useRef<MeResponse | undefined>(undefined);
  const generation = useRef(0);
  identity.current = me;
  const expired = useCallback(() => {
    generation.current++;
    identity.current = undefined;
    setMe(undefined);
  }, []);
  const [api] = useState(
    () => new Api(() => identity.current?.csrfToken, expired),
  );
  const recheck = useCallback(() => {
    const current = generation.current;
    void api
      .request<MeResponse>("/api/me")
      .then((value) => {
        if (current === generation.current) {
          setMe(value);
          setError(undefined);
        }
      })
      .catch((failure: unknown) => {
        if (!(failure instanceof RequestError && failure.status === 401))
          setError(errorText(failure));
      })
      .finally(() => setLoading(false));
  }, [api]);
  useEffect(() => {
    recheck();
    const timer = setInterval(recheck, 30000);
    const visible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    const pop = () => setPath(location.pathname);
    addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", visible);
    addEventListener("popstate", pop);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", visible);
      removeEventListener("popstate", pop);
    };
  }, [recheck]);
  const navigate = useCallback((next: string) => {
    if (
      !/^\/(?:board|members|organization|messenger|mail(?:\/messages\/[A-Za-z0-9_-]{1,128})?|guests|approval(?:\/documents\/[a-f0-9-]{36})?|talk(?:\/settings|\/rooms\/[A-Za-z0-9_-]{1,128})?|web|notifications)$/.test(
        next,
      )
    )
      return;
    history.pushState(null, "", next);
    setPath(next);
  }, []);
  const logout = useCallback(async () => {
    const result = await api.request<{ logoutUrl: string }>(
      "/auth/logout",
      "POST",
    );
    expired();
    const url = new URL(result.logoutUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new RequestError(503, "unavailable");
    location.assign(url.href);
  }, [api, expired]);
  const feed = useNotificationFeed(
    api,
    me ? me.subject + ":" + me.csrfToken : undefined,
    recheck,
  );
  const unread = feed.unread;
  if (!me)
    return (
      <main className="login-page">
        <Card title="J 그룹웨어">
          <Feedback error={error} loading={loading} />
          {!loading ? (
            <>
              <p>업무 서비스를 이용하려면 로그인해 주세요.</p>
              <a className="jgw-button jgw-button--primary" href="/auth/login">
                로그인
              </a>
            </>
          ) : null}
        </Card>
      </main>
    );
  const menu = MENUS.find(
    (item) => path === item.path || path.startsWith(item.path + "/"),
  );
  const authorized =
    path === "/" ||
    path === "/notifications" ||
    !!(
      menu &&
      me.roles.includes(menu.role) &&
      me.menus.some((item) => item.id === menu.id)
    );
  const instance = me.subject + ":" + me.csrfToken + ":" + me.roles.join(",");
  const content = () => {
    if (!authorized)
      return (
        <Card title="접근 권한 없음">
          <p>이 화면을 이용할 권한이 없습니다.</p>
        </Card>
      );
    if (path === "/notifications")
      return (
        <Notifications api={api} onNavigate={navigate} version={feed.version} />
      );
    switch (menu?.id) {
      case "board":
        return <Board api={api} canWrite={me.roles.includes("board:write")} />;
      case "members":
        return <Members api={api} subject={me.subject} />;
      case "organization":
        return <Organization api={api} />;
      case "messenger":
        return <Messenger me={me} onLogout={logout} onExpired={expired} />;
      case "mail":
        return <Mail api={api} initialId={path.split("/")[3]} />;
      case "guests":
        return <Guests api={api} canWrite={me.roles.includes("guest:write")} />;
      case "approval":
        return (
          <Approval
            api={api}
            subject={me.subject}
            initialId={path.split("/")[3]}
          />
        );
      case "talk":
        return path === "/talk/settings" ? (
          me.roles.includes("talk:write") ? (
            <TalkSettings api={api} tenant={me.tenant} />
          ) : (
            <Card title="접근 권한 없음" />
          )
        ) : (
          <Talk
            api={api}
            canWrite={me.roles.includes("talk:write")}
            initialId={path.split("/")[3]}
          />
        );
      case "web":
        return <WebSites api={api} canWrite={me.roles.includes("web:write")} />;
      default:
        return (
          <>
            <h1>업무 홈</h1>
            <Card title={`${me.username}님`}>
              <p>메뉴에서 업무 서비스를 선택해 주세요.</p>
            </Card>
          </>
        );
    }
  };
  return (
    <AppShell
      brand="J 그룹웨어"
      navigation={
        <>
          <p>{me.username}</p>
          {me.menus
            .filter((item) =>
              MENUS.some(
                (entry) =>
                  entry.id === item.id &&
                  entry.path === item.path &&
                  me.roles.includes(entry.role),
              ),
            )
            .map((item) => (
              <a
                key={item.id}
                href={item.path}
                aria-current={menu?.id === item.id ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(item.path);
                }}
              >
                {item.label}
              </a>
            ))}
          {me.roles.includes("talk:write") && me.roles.includes("talk:read") ? (
            <a
              href="/talk/settings"
              onClick={(event) => {
                event.preventDefault();
                navigate("/talk/settings");
              }}
            >
              상담 설정
            </a>
          ) : null}
          <a
            href="/notifications"
            onClick={(event) => {
              event.preventDefault();
              navigate("/notifications");
            }}
          >
            알림
          </a>
          <Button
            variant="secondary"
            onClick={() =>
              void logout().catch((failure: unknown) =>
                setError(errorText(failure)),
              )
            }
          >
            로그아웃
          </Button>
        </>
      }
    >
      <header className="customer-header">
        <span>{me.username}</span>
        <a
          href="/notifications"
          aria-label={`알림 (${unread})`}
          onClick={(event) => {
            event.preventDefault();
            navigate("/notifications");
          }}
        >
          <span aria-hidden="true">🔔</span> {unread}
        </a>
      </header>
      <Feedback error={error} />
      <div key={instance + ":" + path}>{content()}</div>
    </AppShell>
  );
}
