import { useState } from "react";
import { Button, Card, DataTable, Dialog, TextField } from "@j-groupware/ui";
import type {
  OrganizationSnapshot,
  OrganizationDepartment,
  OrganizationPosition,
} from "@j-groupware/contracts";
import type { Api } from "./api.js";
import { encoded } from "./api.js";
import {
  Confirm,
  Feedback,
  Form,
  NextPage,
  Select,
  field,
  nullableField,
  useAction,
  useQuery,
} from "./common.js";

function departmentTree(departments: readonly OrganizationDepartment[]) {
  const children = new Map<string | null, OrganizationDepartment[]>();
  for (const row of departments) {
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  for (const rows of children.values())
    rows.sort(
      (a, b) => a.name.localeCompare(b.name, "ko") || a.id.localeCompare(b.id),
    );
  const result: (OrganizationDepartment & { depth: number })[] = [];
  const seen = new Set<string>();
  const stack = [...(children.get(null) ?? [])]
    .reverse()
    .map((row) => ({ row, depth: 0 }));
  while (stack.length) {
    const item = stack.pop()!;
    if (seen.has(item.row.id)) continue;
    seen.add(item.row.id);
    result.push({ ...item.row, depth: item.depth });
    for (const row of [...(children.get(item.row.id) ?? [])].reverse())
      stack.push({ row, depth: item.depth + 1 });
  }
  for (const row of departments)
    if (!seen.has(row.id)) result.push({ ...row, depth: 0 });
  return result;
}

export function Organization({ api }: { api: Api }) {
  const [cursor, setCursor] = useState("");
  const snapshot = useQuery<OrganizationSnapshot>(
    api,
    "/api/organization" + (cursor ? "?cursor=" + encoded(cursor) : ""),
  );
  const action = useAction();
  const [department, setDepartment] = useState<OrganizationDepartment>();
  const [position, setPosition] = useState<OrganizationPosition>();
  const [deleting, setDeleting] = useState<{
    kind: "departments" | "positions";
    id: string;
    name: string;
  }>();
  const data = snapshot.value;
  const revision = data?.revision;
  const mutate = async (
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) => {
    if (revision === undefined) return;
    await api.request(path, method, { ...body, revision });
    snapshot.reload();
  };
  return (
    <>
      <h1>조직도</h1>
      <Feedback {...snapshot} />
      <Feedback {...action} />
      <Button variant="secondary" onClick={snapshot.reload}>
        현재 조직도 다시 불러오기
      </Button>
      {data ? (
        <>
          <Card title="부서">
            <DataTable
              caption="부서 트리"
              rows={departmentTree(data.departments)}
              getRowKey={(row) => row.id}
              columns={[
                {
                  key: "name",
                  header: "부서",
                  cell: (row) => (
                    <span>
                      {row.depth ? (
                        <span aria-hidden="true">
                          {"› ".repeat(Math.min(row.depth, 8))}
                        </span>
                      ) : null}
                      {row.name}
                      {row.depth ? (
                        <span className="jgw-visually-hidden">
                          {" "}
                          (부서 단계 {row.depth + 1})
                        </span>
                      ) : null}
                    </span>
                  ),
                },
                {
                  key: "parent",
                  header: "상위 부서",
                  cell: (row) =>
                    data.departments.find((item) => item.id === row.parentId)
                      ?.name ?? "최상위",
                },
                {
                  key: "head",
                  header: "부서장",
                  cell: (row) =>
                    data.members.items.find(
                      (item) => item.id === row.headMemberId,
                    )?.username ??
                    row.headMemberId ??
                    "미지정",
                },
                {
                  key: "actions",
                  header: "작업",
                  cell: (row) => (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => setDepartment(row)}
                      >
                        부서 편집 {row.name}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() =>
                          setDeleting({
                            kind: "departments",
                            id: row.id,
                            name: row.name,
                          })
                        }
                      >
                        부서 삭제 {row.name}
                      </Button>
                    </>
                  ),
                },
              ]}
            />
            <Form
              label="부서 추가"
              busy={action.busy}
              onSubmit={(form) =>
                action.run(() =>
                  mutate("/api/organization/departments", "POST", {
                    name: field(form, "name"),
                    parentId: nullableField(form, "parentId"),
                  }),
                )
              }
            >
              <TextField
                label="새 부서 이름"
                name="name"
                required
                maxLength={120}
              />
              <DepartmentSelect departments={data.departments} />
              <Button type="submit">부서 추가</Button>
            </Form>
          </Card>
          <Card title="직책">
            <DataTable
              caption="직책 목록"
              rows={data.positions}
              getRowKey={(row) => row.id}
              columns={[
                { key: "name", header: "직책", cell: (row) => row.name },
                {
                  key: "actions",
                  header: "작업",
                  cell: (row) => (
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => setPosition(row)}
                      >
                        직책 편집 {row.name}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() =>
                          setDeleting({
                            kind: "positions",
                            id: row.id,
                            name: row.name,
                          })
                        }
                      >
                        직책 삭제 {row.name}
                      </Button>
                    </>
                  ),
                },
              ]}
            />
            <Form
              label="직책 추가"
              busy={action.busy}
              onSubmit={(form) =>
                action.run(() =>
                  mutate("/api/organization/positions", "POST", {
                    name: field(form, "name"),
                  }),
                )
              }
            >
              <TextField
                label="새 직책 이름"
                name="name"
                required
                maxLength={120}
              />
              <Button type="submit">직책 추가</Button>
            </Form>
          </Card>
          <Card title="회원 배치">
            <DataTable
              caption="회원 소속"
              rows={data.members.items}
              getRowKey={(row) => row.id + ":" + data.revision}
              columns={[
                { key: "name", header: "계정", cell: (row) => row.username },
                {
                  key: "placement",
                  header: "배치 편집",
                  cell: (row) => (
                    <Form
                      label={`${row.username} 배치`}
                      busy={action.busy}
                      onSubmit={(form) =>
                        action.run(() =>
                          mutate(
                            "/api/organization/members/" + encoded(row.id),
                            "PATCH",
                            {
                              departmentId: nullableField(form, "departmentId"),
                              positionId: nullableField(form, "positionId"),
                            },
                          ),
                        )
                      }
                    >
                      <Select
                        label="소속 부서"
                        name="departmentId"
                        defaultValue={row.departmentId ?? ""}
                      >
                        <option value="">미배치</option>
                        {data.departments.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label="직책"
                        name="positionId"
                        defaultValue={row.positionId ?? ""}
                      >
                        <option value="">미지정</option>
                        {data.positions.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit">배치 저장 {row.username}</Button>
                    </Form>
                  ),
                },
              ]}
            />
            <NextPage cursor={data.members.nextCursor} onNext={setCursor} />
            <Form
              label="기존 회원 등록"
              busy={action.busy}
              onSubmit={(form) =>
                action.run(async () => {
                  await api.request(
                    "/api/organization/members/" + encoded(field(form, "id")),
                    "PUT",
                  );
                  snapshot.reload();
                })
              }
            >
              <TextField
                label="등록할 기존 회원 ID"
                name="id"
                required
                maxLength={128}
              />
              <Button type="submit">미배치로 등록</Button>
            </Form>
          </Card>
          {department ? (
            <Dialog
              open
              title="부서 편집"
              onClose={() => {
                if (!action.busy) setDepartment(undefined);
              }}
            >
              <Feedback {...action} />
              <Form
                label="부서 편집"
                busy={action.busy}
                onSubmit={(form) =>
                  action.run(async () => {
                    await mutate(
                      "/api/organization/departments/" + encoded(department.id),
                      "PATCH",
                      {
                        name: field(form, "name"),
                        parentId: nullableField(form, "parentId"),
                        headMemberId: nullableField(form, "headMemberId"),
                      },
                    );
                    setDepartment(undefined);
                  })
                }
              >
                <TextField
                  label="부서 이름"
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={department.name}
                />
                <DepartmentSelect
                  departments={data.departments.filter(
                    (row) => row.id !== department.id,
                  )}
                  value={department.parentId ?? ""}
                />
                <Select
                  label="부서장"
                  name="headMemberId"
                  defaultValue={department.headMemberId ?? ""}
                >
                  <option value="">미지정</option>
                  {department.headMemberId &&
                  !data.members.items.some(
                    (row) =>
                      row.id === department.headMemberId &&
                      row.departmentId === department.id,
                  ) ? (
                    <option value={department.headMemberId}>
                      현재 부서장 ({department.headMemberId})
                    </option>
                  ) : null}
                  {data.members.items
                    .filter((row) => row.departmentId === department.id)
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.username}
                      </option>
                    ))}
                </Select>
                <Button type="submit">부서 저장</Button>
              </Form>
            </Dialog>
          ) : null}
          {position ? (
            <Dialog
              open
              title="직책 편집"
              onClose={() => {
                if (!action.busy) setPosition(undefined);
              }}
            >
              <Feedback {...action} />
              <Form
                label="직책 편집"
                busy={action.busy}
                onSubmit={(form) =>
                  action.run(async () => {
                    await mutate(
                      "/api/organization/positions/" + encoded(position.id),
                      "PATCH",
                      { name: field(form, "name") },
                    );
                    setPosition(undefined);
                  })
                }
              >
                <TextField
                  label="직책 이름"
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={position.name}
                />
                <Button type="submit">직책 저장</Button>
              </Form>
            </Dialog>
          ) : null}
          {deleting ? (
            <Confirm
              title="조직 항목 삭제 확인"
              busy={action.busy}
              onClose={() => setDeleting(undefined)}
              onConfirm={() =>
                void action.run(async () => {
                  await mutate(
                    "/api/organization/" +
                      deleting.kind +
                      "/" +
                      encoded(deleting.id),
                    "DELETE",
                    {},
                  );
                  setDeleting(undefined);
                })
              }
            >
              {deleting.name} 항목을 삭제합니다. 연결된 소속과 하위 부서 제약은
              서버에서 확인합니다.
            </Confirm>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function DepartmentSelect({
  departments,
  value,
}: {
  departments: readonly OrganizationDepartment[];
  value?: string;
}) {
  return (
    <Select
      label="상위 부서"
      name="parentId"
      {...(value === undefined ? {} : { defaultValue: value })}
    >
      <option value="">최상위</option>
      {departments.map((row) => (
        <option key={row.id} value={row.id}>
          {row.name}
        </option>
      ))}
    </Select>
  );
}
