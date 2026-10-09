import { useState } from "react";
import { Button, Card, DataTable } from "@j-groupware/ui";
import type { MailDetail, MailPage } from "@j-mail/contracts";
import type { Api } from "./api.js";
import { encoded } from "./api.js";
import { Feedback, useAction, useQuery } from "./common.js";

export function SandboxedHtml({
  html,
  title,
}: {
  html: string;
  title: string;
}) {
  // The first CSP applies in addition to any untrusted policy in the document.
  const policy =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  return (
    <iframe
      className="html-preview"
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8">${html}`}
    />
  );
}

export function Mail({
  api,
  initialId,
}: {
  api: Api;
  initialId?: string | undefined;
}) {
  const [offset, setOffset] = useState(0);
  const [id, setId] = useState(initialId ?? "");
  const list = useQuery<MailPage>(
    api,
    "/api/mail/messages?offset=" + offset + "&limit=20",
  );
  const detail = useQuery<MailDetail>(
    api,
    id ? "/api/mail/messages/" + encoded(id) : undefined,
  );
  const action = useAction();
  return (
    <>
      <h1>메일</h1>
      <Feedback {...list} />
      <Feedback {...action} />
      <Card title="공유 받은편지함">
        <Button variant="secondary" onClick={list.reload}>
          새로고침
        </Button>
        <DataTable
          caption="메일 목록"
          rows={list.value?.items ?? []}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "subject",
              header: "제목",
              cell: (row) => (
                <Button variant="quiet" onClick={() => setId(row.id)}>
                  {row.subject || "(제목 없음)"}
                </Button>
              ),
            },
            {
              key: "from",
              header: "보낸 사람",
              cell: (row) => `${row.from.name} <${row.from.address}>`,
            },
            { key: "date", header: "수신 시각", cell: (row) => row.receivedAt },
          ]}
        />
        <div className="actions">
          <Button
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            이전 페이지
          </Button>
          <Button
            variant="secondary"
            disabled={
              !list.value || offset + 20 >= Math.min(1000, list.value.total)
            }
            onClick={() => setOffset(offset + 20)}
          >
            다음 페이지
          </Button>
        </div>
      </Card>
      {id ? (
        <Card title="메일 상세">
          <Feedback {...detail} />
          {detail.value ? (
            <>
              <h2>{detail.value.subject}</h2>
              <p>수신: {detail.value.to.map((v) => v.address).join(", ")}</p>
              {detail.value.html ? (
                <SandboxedHtml
                  title="메일 HTML 본문"
                  html={detail.value.html}
                />
              ) : (
                <p className="plain-body">{detail.value.text}</p>
              )}
              <details>
                <summary>텍스트 본문</summary>
                <p className="plain-body">{detail.value.text}</p>
              </details>
            </>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
