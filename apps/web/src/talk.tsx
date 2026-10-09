import { useCallback, useEffect, useState } from "react";
import { Button, Card, DataTable } from "@j-groupware/ui";
import type { Api } from "./api.js";
import { encoded, RequestError } from "./api.js";
import {
  Confirm,
  Feedback,
  Form,
  NextPage,
  Select,
  TextArea,
  field,
  useAction,
  useQuery,
} from "./common.js";

interface Room {
  id: string;
  status: string;
  assignedMemberId: string | null;
  guestId: string | null;
  guestName?: string | null;
}
interface Message {
  id: string;
  text: string;
  senderMemberId: string | null;
  createdAt: string;
}
interface Page<T> {
  items: T[];
  next: string | null;
}

function useTalkStream(api: Api, onChange: () => void) {
  const [status, setStatus] = useState("상담 연결 중…");
  useEffect(() => {
    let active = true,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      cursor: string | undefined,
      retry = 0;
    const controller = new AbortController();
    const connect = async () => {
      if (!active) return;
      try {
        let more = true;
        while (more && active) {
          const sync = await api.request<{
            cursor: string;
            hasMore: boolean;
            items: unknown[];
          }>(
            "/api/talk/sync" + (cursor ? "?cursor=" + encoded(cursor) : ""),
            "GET",
            undefined,
            controller.signal,
          );
          cursor = sync.cursor;
          more = sync.hasMore;
          if (sync.items.length) onChange();
        }
        if (!active) return;
        const url = new URL("/api/talk/ws", location.origin);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url);
        socket.onopen = () => {
          if (active) {
            retry = 0;
            setStatus("상담 실시간 연결됨");
          }
        };
        socket.onmessage = (event) => {
          if (
            !active ||
            typeof event.data !== "string" ||
            event.data.length > 1048576
          )
            return;
          try {
            const value: unknown = JSON.parse(event.data);
            if (
              value &&
              typeof value === "object" &&
              "type" in value &&
              value.type === "events" &&
              "items" in value &&
              Array.isArray(value.items) &&
              value.items.length
            )
              onChange();
          } catch {
            socket?.close();
          }
        };
        socket.onclose = () => {
          if (active) {
            setStatus("상담 연결이 끊겼습니다. 다시 연결하는 중…");
            timer = setTimeout(
              () => void connect(),
              Math.min(10000, 500 * 2 ** Math.min(retry++, 5)),
            );
          }
        };
      } catch (error) {
        if (!active) return;
        if (error instanceof RequestError && error.status === 401) return;
        if (error instanceof RequestError && error.status === 400)
          cursor = undefined;
        setStatus("상담 연결을 확인하지 못했습니다. 재시도 중…");
        timer = setTimeout(
          () => void connect(),
          Math.min(10000, 500 * 2 ** Math.min(retry++, 5)),
        );
      }
    };
    void connect();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [api, onChange]);
  return status;
}

export function Talk({
  api,
  canWrite,
  initialId,
}: {
  api: Api;
  canWrite: boolean;
  initialId?: string | undefined;
}) {
  const [filter, setFilter] = useState("");
  const [after, setAfter] = useState("");
  const [id, setId] = useState(initialId ?? "");
  const [revision, setRevision] = useState(0);
  const list = useQuery<Page<Room>>(
    api,
    "/api/talk/rooms?limit=50" +
      (filter ? "&status=" + filter : "") +
      (after ? "&after=" + encoded(after) : ""),
  );
  const invalidate = useCallback(() => {
    list.reload();
    setRevision((old) => old + 1);
  }, [list.reload]);
  const status = useTalkStream(api, invalidate);
  return (
    <>
      <h1>상담</h1>
      <p role="status">{status}</p>
      <Feedback {...list} />
      <Card title="문의방">
        <Select
          label="상담 상태"
          name="status"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setAfter("");
          }}
        >
          <option value="">전체</option>
          <option value="waiting">대기</option>
          <option value="in_progress">진행 중</option>
          <option value="closed">종료</option>
        </Select>
        <Button variant="secondary" onClick={invalidate}>
          새로고침
        </Button>
        <DataTable
          caption="상담 목록"
          rows={list.value?.items ?? []}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "id",
              header: "문의방",
              cell: (row) => (
                <Button variant="quiet" onClick={() => setId(row.id)}>
                  {row.id}
                </Button>
              ),
            },
            {
              key: "guest",
              header: "손님",
              cell: (row) =>
                row.guestName ?? (row.guestId ? "손님 문의" : "익명 문의"),
            },
            { key: "status", header: "상태", cell: (row) => row.status },
            {
              key: "assignee",
              header: "담당자",
              cell: (row) => row.assignedMemberId ?? "미배정",
            },
          ]}
        />
        <NextPage cursor={list.value?.next} onNext={setAfter} />
      </Card>
      {id ? (
        <RoomDetail
          key={id}
          api={api}
          id={id}
          canWrite={canWrite}
          revision={revision}
          onChanged={invalidate}
        />
      ) : null}
    </>
  );
}

function RoomDetail({
  api,
  id,
  canWrite,
  revision,
  onChanged,
}: {
  api: Api;
  id: string;
  canWrite: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const detail = useQuery<Room>(api, "/api/talk/rooms/" + encoded(id));
  const [after, setAfter] = useState("");
  const messages = useQuery<Page<Message>>(
    api,
    "/api/talk/rooms/" +
      encoded(id) +
      "/messages?limit=50" +
      (after ? "&after=" + encoded(after) : ""),
  );
  const action = useAction();
  const [text, setText] = useState("");
  const [retry, setRetry] = useState<{ requestId: string; text: string }>();
  const [closing, setClosing] = useState(false);
  const [assigneeCursor, setAssigneeCursor] = useState("");
  const candidates = useQuery<{
    items: { id: string; username: string }[];
    nextCursor: string | null;
  }>(
    api,
    canWrite
      ? "/api/talk/assignees" +
          (assigneeCursor ? "?cursor=" + encoded(assigneeCursor) : "")
      : undefined,
  );
  useEffect(() => {
    detail.reload();
    messages.reload();
  }, [revision, detail.reload, messages.reload]);
  const refresh = () => {
    detail.reload();
    messages.reload();
    onChanged();
  };
  const send = async (payload: { requestId: string; text: string }) => {
    setRetry(payload);
    await api.request(
      "/api/talk/rooms/" + encoded(id) + "/messages",
      "POST",
      payload,
    );
    setRetry(undefined);
    setText("");
    setAfter("");
    refresh();
  };
  const current = detail.value;
  const canReply = canWrite && current?.status === "in_progress";
  return (
    <Card title="상담 상세">
      <Feedback {...detail} />
      <Feedback {...messages} />
      <Feedback {...action} />
      <Button variant="secondary" onClick={refresh}>
        상담 상태 다시 확인
      </Button>
      {current ? (
        <>
          <p>
            상태: {current.status} / 담당자:{" "}
            {current.assignedMemberId ?? "미배정"}
          </p>
          {current.guestName !== undefined ? (
            <p>
              손님: {current.guestName ?? "익명 또는 조회 가능한 이름 없음"}
            </p>
          ) : null}
          <ol className="message-list">
            {messages.value?.items.map((row) => (
              <li key={row.id}>
                <span>
                  {row.senderMemberId ? "상담원" : "방문자"} · {row.createdAt}
                </span>
                <p className="plain-body">{row.text}</p>
              </li>
            ))}
          </ol>
          <NextPage cursor={messages.value?.next} onNext={setAfter} />
          {canWrite && current.status !== "closed" ? (
            <>
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api.request(
                      "/api/talk/rooms/" + encoded(id) + "/assign-self",
                      "POST",
                      {},
                    );
                    refresh();
                  })
                }
              >
                내게 배정
              </Button>
              <Feedback {...candidates} />
              <Form
                label="상담 배정"
                busy={action.busy}
                onSubmit={(form) =>
                  action.run(async () => {
                    await api.request(
                      "/api/talk/rooms/" + encoded(id) + "/assign",
                      "POST",
                      { memberId: field(form, "memberId") },
                    );
                    refresh();
                  })
                }
              >
                <Select label="담당 상담원" name="memberId" required>
                  <option value="">선택</option>
                  {candidates.value?.items?.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.username}
                    </option>
                  ))}
                </Select>
                <Button type="submit">배정 저장</Button>
              </Form>
              <NextPage
                cursor={candidates.value?.nextCursor}
                onNext={setAssigneeCursor}
              />
              {canReply ? (
                <>
                  <Form
                    label="상담 답장"
                    busy={action.busy}
                    onSubmit={() =>
                      action.run(() =>
                        send({ requestId: crypto.randomUUID(), text }),
                      )
                    }
                  >
                    <TextArea
                      label="답장 내용"
                      name="text"
                      maxLength={4096}
                      value={text}
                      onChange={setText}
                    />
                    <Button
                      type="submit"
                      disabled={
                        !!retry || new TextEncoder().encode(text).length > 4096
                      }
                    >
                      답장 보내기
                    </Button>
                  </Form>
                  {retry ? (
                    <Button
                      disabled={action.busy}
                      onClick={() => void action.run(() => send(retry))}
                    >
                      같은 답장 재시도
                    </Button>
                  ) : null}
                </>
              ) : null}
              {canWrite && current.status !== "closed" ? (
                <Button
                  variant="danger"
                  disabled={action.busy}
                  onClick={() => setClosing(true)}
                >
                  상담 종료
                </Button>
              ) : null}
            </>
          ) : null}
          {closing ? (
            <Confirm
              title="상담 종료 확인"
              busy={action.busy}
              onClose={() => setClosing(false)}
              onConfirm={() =>
                void action.run(async () => {
                  await api.request(
                    "/api/talk/rooms/" + encoded(id) + "/close",
                    "POST",
                    {},
                  );
                  setClosing(false);
                  refresh();
                })
              }
            >
              상담을 종료하면 이 문의방에 답장할 수 없습니다.
            </Confirm>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
