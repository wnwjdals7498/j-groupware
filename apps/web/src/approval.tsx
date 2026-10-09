import { useState } from "react";
import { Button, Card, DataTable, TextField } from "@j-groupware/ui";
import type {
  OrganizationApprovalLine,
  OrganizationMemberPage,
} from "@j-groupware/contracts";
import type {
  ApprovalDocument,
  DocumentPage,
  HistoryPage,
} from "@j-approval/contracts";
import type { Api } from "./api.js";
import { encoded } from "./api.js";
import {
  Feedback,
  Form,
  NextPage,
  Select,
  TextArea,
  field,
  useAction,
  useQuery,
} from "./common.js";

export function Approval({
  api,
  subject,
  initialId,
}: {
  api: Api;
  subject: string;
  initialId?: string | undefined;
}) {
  const [view, setView] = useState("authored");
  const [cursor, setCursor] = useState("");
  const [candidateCursor, setCandidateCursor] = useState("");
  const [selected, setSelected] = useState("");
  const [line, setLine] = useState<string[]>([]);
  const [id, setId] = useState(initialId ?? "");
  const list = useQuery<DocumentPage>(
    api,
    "/api/approval/documents?view=" +
      view +
      (cursor ? "&cursor=" + encoded(cursor) : ""),
  );
  const defaults = useQuery<OrganizationApprovalLine>(
    api,
    "/api/organization/approval-line",
  );
  const candidates = useQuery<OrganizationMemberPage>(
    api,
    "/api/organization/candidates" +
      (candidateCursor ? "?cursor=" + encoded(candidateCursor) : ""),
  );
  const action = useAction();
  const move = (index: number, delta: number) =>
    setLine((old) => {
      const next = [...old];
      const target = index + delta;
      const current = next[index];
      const other = next[target];
      if (current !== undefined && other !== undefined) {
        next[index] = other;
        next[target] = current;
      }
      return next;
    });
  return (
    <>
      <h1>결재</h1>
      <Feedback {...list} />
      <Feedback {...action} />
      <Card title="결재함">
        <Select
          label="문서 구분"
          name="view"
          value={view}
          onChange={(next) => {
            setView(next);
            setCursor("");
          }}
        >
          <option value="authored">내 문서</option>
          <option value="pending">결재 대기</option>
          <option value="processed">처리한 문서</option>
        </Select>
        <Button variant="secondary" onClick={list.reload}>
          새로고침
        </Button>
        <DataTable
          caption="결재 문서"
          rows={list.value?.items ?? []}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "title",
              header: "제목",
              cell: (row) => (
                <Button variant="quiet" onClick={() => setId(row.id)}>
                  {row.title}
                </Button>
              ),
            },
            { key: "status", header: "상태", cell: (row) => row.status },
            {
              key: "stage",
              header: "진행 단계",
              cell: (row) => row.currentStage ?? "종결",
            },
          ]}
        />
        <NextPage cursor={list.value?.nextCursor} onNext={setCursor} />
      </Card>
      <Card title="문서 상신">
        <Feedback {...defaults} />
        <Feedback {...candidates} />
        <Button
          variant="secondary"
          disabled={!defaults.value || action.busy}
          onClick={() => setLine([...(defaults.value?.memberIds ?? [])])}
        >
          기본 결재선 불러오기
        </Button>
        <ol aria-label="결재 순서">
          {line.map((memberId, index) => (
            <li key={memberId}>
              {candidates.value?.items.find((row) => row.id === memberId)
                ?.username ?? memberId}
              <Button
                variant="quiet"
                disabled={index === 0 || action.busy}
                onClick={() => move(index, -1)}
              >
                위로 {index + 1}
              </Button>
              <Button
                variant="quiet"
                disabled={index === line.length - 1 || action.busy}
                onClick={() => move(index, 1)}
              >
                아래로 {index + 1}
              </Button>
              <Button
                variant="quiet"
                disabled={action.busy}
                onClick={() =>
                  setLine((old) => old.filter((value) => value !== memberId))
                }
              >
                제외 {index + 1}
              </Button>
            </li>
          ))}
        </ol>
        <Select
          label="결재자 후보"
          name="candidate"
          value={selected}
          onChange={setSelected}
        >
          <option value="">선택</option>
          {candidates.value?.items
            .filter((row) => row.id !== subject && !line.includes(row.id))
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.username}
              </option>
            ))}
        </Select>
        <Button
          variant="secondary"
          disabled={!selected || line.length >= 32 || action.busy}
          onClick={() => {
            setLine((old) => [...old, selected]);
            setSelected("");
          }}
        >
          결재자 추가
        </Button>
        <NextPage
          cursor={candidates.value?.nextCursor}
          onNext={setCandidateCursor}
        />
        <Form
          label="문서 상신"
          busy={action.busy}
          onSubmit={(form) =>
            action.run(async () => {
              const validated = await api.request<OrganizationApprovalLine>(
                "/api/organization/approval-line/validate",
                "POST",
                { memberIds: line },
              );
              const document = await api.request<ApprovalDocument>(
                "/api/approval/documents",
                "POST",
                {
                  title: field(form, "title"),
                  body: field(form, "body"),
                  memberIds: validated.memberIds,
                },
              );
              setId(document.id);
              list.reload();
            })
          }
        >
          <TextField label="결재 제목" name="title" required maxLength={200} />
          <TextArea label="결재 본문" name="body" />
          <Button type="submit" disabled={line.length === 0}>
            상신
          </Button>
        </Form>
      </Card>
      {id ? (
        <DocumentDetail
          key={id}
          api={api}
          subject={subject}
          id={id}
          onChanged={list.reload}
        />
      ) : null}
    </>
  );
}

function DocumentDetail({
  api,
  subject,
  id,
  onChanged,
}: {
  api: Api;
  subject: string;
  id: string;
  onChanged: () => void;
}) {
  const document = useQuery<ApprovalDocument>(
    api,
    "/api/approval/documents/" + encoded(id),
  );
  const [cursor, setCursor] = useState("");
  const history = useQuery<HistoryPage>(
    api,
    "/api/approval/documents/" +
      encoded(id) +
      "/history" +
      (cursor ? "?cursor=" + encoded(cursor) : ""),
  );
  const action = useAction();
  const current = document.value;
  const canDecide =
    current?.status === "pending" &&
    current.currentStage !== null &&
    current.memberIds[current.currentStage - 1] === subject;
  const decide = async (choice: "approve" | "reject", reason?: string) => {
    if (!current) return;
    await api.request(
      "/api/approval/documents/" + encoded(id) + "/decisions",
      "POST",
      {
        revision: current.revision,
        action: choice,
        ...(choice === "reject" ? { reason } : {}),
      },
    );
    document.reload();
    history.reload();
    onChanged();
  };
  return (
    <Card title="문서 상세">
      <Feedback {...document} />
      <Feedback {...history} />
      <Feedback {...action} />
      <Button
        variant="secondary"
        onClick={() => {
          document.reload();
          history.reload();
        }}
      >
        문서 상태 다시 확인
      </Button>
      {current ? (
        <>
          <h2>{current.title}</h2>
          <p className="plain-body">{current.body}</p>
          <p>
            상태: {current.status} / 단계: {current.currentStage ?? "종결"}
          </p>
          <ol>
            {current.memberIds.map((memberId) => (
              <li key={memberId}>{memberId}</li>
            ))}
          </ol>
          {canDecide ? (
            <>
              <Button
                disabled={action.busy}
                onClick={() => void action.run(() => decide("approve"))}
              >
                승인
              </Button>
              <Form
                label="문서 반려"
                busy={action.busy}
                onSubmit={(form) =>
                  action.run(() => decide("reject", field(form, "reason")))
                }
              >
                <TextArea label="반려 사유" name="reason" maxLength={2000} />
                <Button type="submit" variant="danger">
                  반려
                </Button>
              </Form>
            </>
          ) : null}
          <DataTable
            caption="문서 처리 이력"
            rows={history.value?.items ?? []}
            getRowKey={(row) => row.id}
            columns={[
              { key: "action", header: "행동", cell: (row) => row.action },
              { key: "actor", header: "처리자", cell: (row) => row.actorId },
              {
                key: "reason",
                header: "사유",
                cell: (row) => row.reason ?? "",
              },
              { key: "time", header: "시각", cell: (row) => row.createdAt },
            ]}
          />
          <NextPage cursor={history.value?.nextCursor} onNext={setCursor} />
        </>
      ) : null}
    </Card>
  );
}
