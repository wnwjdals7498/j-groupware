import { useState } from "react";
import { Button, Card, DataTable, Dialog, TextField } from "@j-groupware/ui";
import type {
  GroupwareGrantableRoles,
  MemberListResponse,
  MemberResponse,
} from "@j-groupware/contracts";
import type { Api } from "./api.js";
import { encoded } from "./api.js";
import {
  Confirm,
  Feedback,
  Form,
  NextPage,
  useAction,
  useQuery,
} from "./common.js";

function RoleChecks({
  catalog,
  selected,
  onChange,
  disabled = false,
}: {
  catalog: GroupwareGrantableRoles;
  selected: readonly string[];
  onChange: (role: string, grant: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>서비스 권한</legend>
      {catalog.roles.map((role) => {
        const implied = catalog.roles.some(
          (parent) =>
            selected.includes(parent.name) &&
            parent.implies.includes(role.name),
        );
        return (
          <label key={role.name} className="role-check">
            <input
              type="checkbox"
              checked={selected.includes(role.name) || implied}
              disabled={implied}
              onChange={(event) => onChange(role.name, event.target.checked)}
            />
            {role.name}
            {implied ? " (쓰기 권한에 포함)" : ""}
          </label>
        );
      })}
    </fieldset>
  );
}

export function Members({ api, subject }: { api: Api; subject: string }) {
  const [cursor, setCursor] = useState("");
  const list = useQuery<MemberListResponse>(
    api,
    "/api/members" + (cursor ? "?cursor=" + encoded(cursor) : ""),
  );
  const catalog = useQuery<GroupwareGrantableRoles>(
    api,
    "/api/members/grantable-roles",
  );
  const action = useAction();
  const [roles, setRoles] = useState<string[]>([]);
  const [editing, setEditing] = useState<MemberResponse>();
  const [deleting, setDeleting] = useState<MemberResponse>();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <>
      <h1>회원 관리</h1>
      <Feedback {...list} />
      <Feedback {...catalog} />
      <Feedback {...action} />
      <Card title="회원">
        <Button variant="secondary" onClick={list.reload}>
          현재 목록 확인
        </Button>
        <DataTable
          caption="회원 목록"
          rows={list.value?.items ?? []}
          getRowKey={(row) => row.id}
          columns={[
            { key: "name", header: "계정", cell: (row) => row.username },
            {
              key: "roles",
              header: "권한",
              cell: (row) => row.roles.join(", "),
            },
            {
              key: "actions",
              header: "작업",
              cell: (row) => (
                <>
                  <Button variant="secondary" onClick={() => setEditing(row)}>
                    권한 편집 {row.username}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await api.request(
                          "/api/members/" + encoded(row.id) + "/organization",
                          "POST",
                        );
                      }, "조직도 등록 상태를 확인했습니다.")
                    }
                  >
                    조직도 등록 {row.username}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={
                      row.id === subject ||
                      row.roles.includes("tenant:admin") ||
                      action.busy
                    }
                    onClick={() => setDeleting(row)}
                  >
                    삭제 {row.username}
                  </Button>
                </>
              ),
            },
          ]}
        />
        <NextPage cursor={list.value?.nextCursor} onNext={setCursor} />
      </Card>
      <Card title="회원 추가">
        <Form
          label="회원 추가"
          busy={action.busy}
          onSubmit={() =>
            action.run(async () => {
              const credential = password;
              setPassword("");
              await api.request("/api/members", "POST", {
                username,
                password: credential,
                roles,
              });
              setUsername("");
              setRoles([]);
              setCursor("");
              list.reload();
            })
          }
        >
          <TextField
            label="계정 이름"
            name="username"
            required
            maxLength={255}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
          <TextField
            label="초기 비밀번호"
            name="password"
            type="password"
            required
            maxLength={1024}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {catalog.value ? (
            <RoleChecks
              catalog={catalog.value}
              selected={roles}
              onChange={(role, grant) =>
                setRoles((old) =>
                  grant ? [...old, role] : old.filter((v) => v !== role),
                )
              }
            />
          ) : null}
          <Button type="submit" disabled={!catalog.value}>
            회원 추가
          </Button>
        </Form>
        <p>
          처리 결과가 불명확하면 현재 목록부터 확인하세요. 생성된 회원은 조직도
          등록으로 복구할 수 있습니다.
        </p>
      </Card>
      {editing && catalog.value ? (
        <Dialog
          open
          title={`${editing.username} 권한 편집`}
          onClose={() => {
            if (!action.busy) setEditing(undefined);
          }}
        >
          <Feedback {...action} />
          <RoleChecks
            catalog={catalog.value}
            selected={editing.roles}
            disabled={action.busy}
            onChange={(role, grant) =>
              void action.run(async () => {
                const next = await api.request<MemberResponse>(
                  "/api/members/" +
                    encoded(editing.id) +
                    "/roles/" +
                    encoded(role),
                  grant ? "PUT" : "DELETE",
                );
                setEditing(next);
                list.reload();
              }, "권한을 반영했습니다. 대상 회원은 다시 로그인해야 합니다.")
            }
          />
        </Dialog>
      ) : null}
      {deleting ? (
        <Confirm
          title="회원 삭제 확인"
          busy={action.busy}
          onClose={() => setDeleting(undefined)}
          onConfirm={() =>
            void action.run(async () => {
              await api.request(
                "/api/members/" + encoded(deleting.id),
                "DELETE",
              );
              setDeleting(undefined);
              list.reload();
            })
          }
        >
          {deleting.username} 계정을 삭제합니다. 처리 결과가 불명확하면 목록을
          확인한 뒤 재시도하세요.
        </Confirm>
      ) : null}
    </>
  );
}
