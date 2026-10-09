import { useState } from "react";
import { Button, Card, DataTable, TextField } from "@j-groupware/ui";
import type { Api } from "./api.js";
import { encoded } from "./api.js";
import {
  Confirm,
  Feedback,
  Form,
  NextPage,
  Secret,
  field,
  useAction,
  useQuery,
} from "./common.js";

export function TalkSettings({ api, tenant }: { api: Api; tenant: string }) {
  const [after, setAfter] = useState("");
  const origins = useQuery<{ items: string[]; next: string | null }>(
    api,
    "/api/talk/settings/origins?limit=100" +
      (after ? "&after=" + encoded(after) : ""),
  );
  const key = useQuery<{ issued: boolean; previousValidUntil: string | null }>(
    api,
    "/api/talk/settings/widget-key",
  );
  const action = useAction();
  const [secret, setSecret] = useState<string>();
  const [rotating, setRotating] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const snippet = `<script src="https://gw.${tenant}.jgw.test/ext/talk/v1/widget.min.js" async></script>`;
  return (
    <>
      <h1>상담 설정</h1>
      <Feedback {...origins} />
      <Feedback {...key} />
      <Feedback {...action} />
      <Card title="허용 출처">
        <DataTable
          caption="위젯 허용 출처"
          rows={origins.value?.items ?? []}
          getRowKey={(row) => row}
          columns={[
            { key: "origin", header: "출처", cell: (row) => row },
            {
              key: "action",
              header: "작업",
              cell: (row) => (
                <Button variant="danger" onClick={() => setRemoving(row)}>
                  출처 삭제 {row}
                </Button>
              ),
            },
          ]}
        />
        <NextPage cursor={origins.value?.next} onNext={setAfter} />
        <Form
          label="허용 출처 추가"
          busy={action.busy}
          onSubmit={(form) =>
            action.run(async () => {
              await api.request("/api/talk/settings/origins", "POST", {
                origin: field(form, "origin"),
              });
              setAfter("");
              origins.reload();
            })
          }
        >
          <TextField
            label="HTTPS 출처"
            name="origin"
            type="url"
            required
            maxLength={2048}
            placeholder="https://site.example.com"
          />
          <Button type="submit">출처 추가</Button>
        </Form>
      </Card>
      <Card title="위젯 삽입">
        <pre>{snippet}</pre>
        <p>
          방문자 구분자는 사이트 서버에서 서명합니다. 비밀키를 HTML·브라우저
          코드에 넣지 마세요.
        </p>
        <pre>{`// 사이트 서버 전용 Node.js 예제\nimport { createHmac } from 'node:crypto';\nconst tenant = ${JSON.stringify(tenant)};\nconst guestId = verifiedGuestId;\nconst exp = Math.floor(Date.now() / 1000) + 300;\nconst sig = createHmac('sha256', Buffer.from(process.env.TALK_WIDGET_KEY, 'base64url'))\n  .update(tenant + '|' + guestId + '|' + exp).digest('base64url');\n// 스크립트의 data-guest-id, data-guest-exp, data-guest-sig 속성으로 전달\n// 속성값은 서버 템플릿의 HTML escaping을 거쳐 출력`}</pre>
      </Card>
      <Card title="위젯 서명 키">
        <p>{key.value?.issued ? "발급됨" : "미발급"}</p>
        {key.value?.previousValidUntil ? (
          <p>이전 키 유효 시각: {key.value.previousValidUntil}</p>
        ) : null}
        <Button
          disabled={action.busy || !key.value}
          onClick={() => setRotating(true)}
        >
          {key.value?.issued ? "위젯 키 교체" : "위젯 키 발급"}
        </Button>
      </Card>
      {secret ? (
        <Secret
          title="위젯 서명 키"
          value={secret}
          onClose={() => setSecret(undefined)}
        />
      ) : null}
      {rotating ? (
        <Confirm
          title="위젯 키 발급·교체 확인"
          busy={action.busy}
          onClose={() => setRotating(false)}
          onConfirm={() =>
            void action.run(async () => {
              const result = await api.request<{ key: string }>(
                "/api/talk/settings/widget-key",
                "POST",
                {},
              );
              setRotating(false);
              setSecret(result.key);
              key.reload();
            })
          }
        >
          사이트 서버의 비밀 설정도 새 키로 바꿔야 합니다. 새 키는 한 번만
          표시됩니다.
        </Confirm>
      ) : null}
      {removing ? (
        <Confirm
          title="위젯 출처 삭제 확인"
          busy={action.busy}
          onClose={() => setRemoving(undefined)}
          onConfirm={() =>
            void action.run(async () => {
              await api.request("/api/talk/settings/origins", "DELETE", {
                origin: removing,
              });
              setRemoving(undefined);
              origins.reload();
            })
          }
        >
          {removing} 출처의 위젯 접근을 해제합니다.
        </Confirm>
      ) : null}
    </>
  );
}
