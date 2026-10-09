import { useState } from "react";
import { Button, Card, DataTable, Dialog, TextField } from "@j-groupware/ui";
import type {
  ApiKey,
  ApiKeyScope,
  Guest,
  GuestPage,
  IssuedApiKey,
} from "@j-customer-auth-db/contracts";
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

export function Guests({ api, canWrite }: { api: Api; canWrite: boolean }) {
  const [cursor, setCursor] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const list = useQuery<GuestPage>(
    api,
    "/api/customer-auth/guests?limit=50" +
      (cursor ? "&cursor=" + encoded(cursor) : "") +
      (query ? "&q=" + encoded(query) : ""),
  );
  const action = useAction();
  const [editing, setEditing] = useState<Guest>();
  const [deleting, setDeleting] = useState<Guest>();
  const [password, setPassword] = useState("");
  return (
    <>
      <h1>손님 관리</h1>
      <Feedback {...list} />
      <Feedback {...action} />
      <Card title="손님 목록">
        <Form
          label="손님 검색"
          busy={false}
          onSubmit={async () => {
            setQuery(search);
            setCursor("");
          }}
        >
          <TextField
            label="이름 검색"
            name="q"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type="submit">검색</Button>
        </Form>
        <Button variant="secondary" onClick={list.reload}>
          새로고침
        </Button>
        <DataTable
          caption="손님 목록"
          rows={list.value?.items ?? []}
          getRowKey={(row) => row.id}
          columns={[
            { key: "name", header: "이름", cell: (row) => row.name },
            { key: "login", header: "로그인 ID", cell: (row) => row.loginId },
            { key: "contact", header: "연락처", cell: (row) => row.contact },
            ...(canWrite
              ? [
                  {
                    key: "actions",
                    header: "작업",
                    cell: (row: Guest) => (
                      <>
                        <Button
                          variant="secondary"
                          onClick={() => setEditing(row)}
                        >
                          수정 {row.name}
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => setDeleting(row)}
                        >
                          삭제 {row.name}
                        </Button>
                      </>
                    ),
                  },
                ]
              : []),
          ]}
        />
        <NextPage cursor={list.value?.next} onNext={setCursor} />
      </Card>
      {canWrite ? (
        <>
          <Card title="손님 등록">
            <Form
              label="손님 등록"
              busy={action.busy}
              onSubmit={(form) =>
                action.run(async () => {
                  const credential = password;
                  setPassword("");
                  await api.request("/api/customer-auth/guests", "POST", {
                    name: field(form, "name"),
                    loginId: field(form, "loginId"),
                    contact: field(form, "contact"),
                    password: credential,
                  });
                  setCursor("");
                  list.reload();
                })
              }
            >
              <GuestFields />
              <TextField
                label="손님 비밀번호"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Button type="submit">손님 등록</Button>
            </Form>
          </Card>
          <ApiKeys api={api} />
        </>
      ) : null}
      {editing ? (
        <Dialog
          open
          title="손님 수정"
          onClose={() => {
            if (!action.busy) setEditing(undefined);
          }}
        >
          <Feedback {...action} />
          <Form
            label="손님 수정"
            busy={action.busy}
            onSubmit={(form) =>
              action.run(async () => {
                await api.request(
                  "/api/customer-auth/guests/" + encoded(editing.id),
                  "PATCH",
                  {
                    name: field(form, "name"),
                    loginId: field(form, "loginId"),
                    contact: field(form, "contact"),
                  },
                );
                setEditing(undefined);
                list.reload();
              })
            }
          >
            <GuestFields guest={editing} />
            <Button type="submit">수정 저장</Button>
          </Form>
        </Dialog>
      ) : null}
      {deleting ? (
        <Confirm
          title="손님 삭제 확인"
          busy={action.busy}
          onClose={() => setDeleting(undefined)}
          onConfirm={() =>
            void action.run(async () => {
              await api.request(
                "/api/customer-auth/guests/" + encoded(deleting.id),
                "DELETE",
              );
              setDeleting(undefined);
              list.reload();
            })
          }
        >
          {deleting.name} 손님을 삭제합니다.
        </Confirm>
      ) : null}
    </>
  );
}

function GuestFields({ guest }: { guest?: Guest }) {
  return (
    <>
      <TextField
        label="손님 이름"
        name="name"
        required
        maxLength={120}
        defaultValue={guest?.name}
      />
      <TextField
        label="로그인 ID"
        name="loginId"
        required
        minLength={3}
        maxLength={64}
        pattern="[a-z0-9][a-z0-9._-]{2,63}"
        defaultValue={guest?.loginId}
      />
      <TextField
        label="연락처"
        name="contact"
        maxLength={256}
        defaultValue={guest?.contact}
      />
    </>
  );
}

function ApiKeys({ api }: { api: Api }) {
  const list = useQuery<{ items: ApiKey[] }>(
    api,
    "/api/customer-auth/api-keys",
  );
  const action = useAction();
  const [secret, setSecret] = useState<string>();
  const [revoking, setRevoking] = useState<ApiKey>();
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["guest:read"]);
  return (
    <Card title="API 키">
      <Feedback {...list} />
      <Feedback {...action} />
      <DataTable
        caption="API 키 목록"
        rows={list.value?.items ?? []}
        getRowKey={(row) => row.id}
        columns={[
          { key: "name", header: "이름", cell: (row) => row.name },
          {
            key: "scope",
            header: "스코프",
            cell: (row) => row.scopes.join(", "),
          },
          {
            key: "status",
            header: "상태",
            cell: (row) => (row.revokedAt ? "회수됨" : "유효"),
          },
          {
            key: "actions",
            header: "작업",
            cell: (row) => (
              <Button
                variant="danger"
                disabled={!!row.revokedAt || action.busy}
                onClick={() => setRevoking(row)}
              >
                회수 {row.name}
              </Button>
            ),
          },
        ]}
      />
      <Form
        label="API 키 발급"
        busy={action.busy}
        onSubmit={(form) =>
          action.run(async () => {
            const result = await api.request<IssuedApiKey>(
              "/api/customer-auth/api-keys",
              "POST",
              { name: field(form, "name"), scopes },
            );
            setSecret(result.secret);
            list.reload();
          })
        }
      >
        <TextField label="API 키 이름" name="name" required maxLength={120} />
        <fieldset>
          <legend>API 키 스코프</legend>
          {(["guest:read", "guest:write"] as const).map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes((old) =>
                    event.target.checked
                      ? [...old, scope]
                      : old.filter((value) => value !== scope),
                  )
                }
              />
              {scope}
            </label>
          ))}
        </fieldset>
        <Button type="submit" disabled={scopes.length === 0}>
          키 발급
        </Button>
      </Form>
      {secret ? (
        <Secret
          title="발급된 API 키"
          value={secret}
          onClose={() => setSecret(undefined)}
        />
      ) : null}
      {revoking ? (
        <Confirm
          title="API 키 회수 확인"
          busy={action.busy}
          onClose={() => setRevoking(undefined)}
          onConfirm={() =>
            void action.run(async () => {
              await api.request(
                "/api/customer-auth/api-keys/" + encoded(revoking.id),
                "DELETE",
              );
              setRevoking(undefined);
              list.reload();
            })
          }
        >
          {revoking.name} 키를 회수하면 즉시 사용할 수 없습니다.
        </Confirm>
      ) : null}
    </Card>
  );
}
