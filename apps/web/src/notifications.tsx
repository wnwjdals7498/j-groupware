import { useEffect, useState } from "react";
import { Button, Card, DataTable } from "@j-groupware/ui";
import { NOTIFICATION_TYPES } from "@j-groupware/permissions/notifications";
import type {
  NotificationPage,
  NotificationItem,
} from "@j-groupware/permissions/notifications";
import type { Api } from "./api.js";
import { encoded } from "./api.js";
import { Feedback, NextPage, useAction, useQuery } from "./common.js";

export function safeNotificationLink(item: NotificationItem): boolean {
  if (!Object.hasOwn(NOTIFICATION_TYPES, item.type)) return false;
  const rule = NOTIFICATION_TYPES[item.type];
  return !!rule && rule.service === item.service && rule.link.test(item.link);
}

const serviceIcons = {
  "j-approval": "📄",
  "j-talk": "💬",
  "j-mail": "✉",
} as const;

export function useNotificationFeed(
  api: Api,
  identityKey: string | undefined,
  onRecheck: () => void,
) {
  const [unread, setUnread] = useState(0);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setUnread(0);
    if (!identityKey) return;
    const refresh = () => {
      void api
        .request<NotificationPage>("/api/notifications")
        .then((page) => {
          if (active) setUnread(page.unread);
        })
        .catch(() => undefined);
    };
    refresh();
    const stream = new EventSource("/api/notifications/stream");
    stream.addEventListener("notifications", () => {
      refresh();
      setVersion((old) => old + 1);
    });
    stream.onerror = onRecheck;
    return () => {
      active = false;
      stream.close();
    };
  }, [api, identityKey, onRecheck]);
  return { unread, version };
}

export function Notifications({
  api,
  onNavigate,
  version,
}: {
  api: Api;
  onNavigate: (path: string) => void;
  version: number;
}) {
  const [cursor, setCursor] = useState("");
  const list = useQuery<NotificationPage>(
    api,
    "/api/notifications" + (cursor ? "?cursor=" + encoded(cursor) : ""),
  );
  const action = useAction();
  useEffect(() => {
    list.reload();
  }, [list.reload, version]);
  return (
    <>
      <h1>알림</h1>
      <Feedback {...list} />
      <Feedback {...action} />
      <Card title={`읽지 않은 알림 ${list.value?.unread ?? 0}개`}>
        <Button variant="secondary" onClick={list.reload}>
          새로고침
        </Button>
        <DataTable
          caption="알림 목록"
          rows={list.value?.items ?? []}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "service",
              header: "서비스",
              cell: (row) => (
                <>
                  <span aria-hidden="true">{serviceIcons[row.service]}</span>{" "}
                  {row.service}
                </>
              ),
            },
            { key: "type", header: "종류", cell: (row) => row.label },
            {
              key: "title",
              header: "내용",
              cell: (row) => (
                <>
                  <strong>{row.title}</strong>
                  <p>{row.body}</p>
                </>
              ),
            },
            {
              key: "read",
              header: "상태",
              cell: (row) => (row.readAt ? "읽음" : "읽지 않음"),
            },
            {
              key: "created",
              header: "수신 시각",
              cell: (row) => (
                <time dateTime={row.createdAt}>
                  {new Date(row.createdAt).toLocaleString("ko-KR")}
                </time>
              ),
            },
            {
              key: "action",
              header: "작업",
              cell: (row) => (
                <Button
                  disabled={action.busy || !safeNotificationLink(row)}
                  onClick={() =>
                    void action.run(async () => {
                      await api.request(
                        "/api/notifications/" + encoded(row.id) + "/read",
                        "POST",
                      );
                      list.reload();
                      onNavigate(row.link);
                    })
                  }
                >
                  열기 {row.title}
                </Button>
              ),
            },
          ]}
        />
        <NextPage cursor={list.value?.nextCursor} onNext={setCursor} />
      </Card>
    </>
  );
}
