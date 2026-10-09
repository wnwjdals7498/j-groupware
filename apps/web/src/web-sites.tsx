import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, DataTable, TextField } from "@j-groupware/ui";
import type {
  ContentView,
  PageContent,
  HostingList,
  SiteHostingView,
  SiteMutationResult,
  PreviewView,
  DeploymentView,
  DnsAdvice,
} from "@j-web/contracts";
import type { Api } from "./api.js";
import { encoded, RequestError } from "./api.js";
import {
  Confirm,
  Feedback,
  Form,
  NextPage,
  Secret,
  TextArea,
  field,
  useAction,
  useQuery,
} from "./common.js";
import { SandboxedHtml } from "./mail.js";

export function WebSites({ api, canWrite }: { api: Api; canWrite: boolean }) {
  const [after, setAfter] = useState("");
  const [id, setId] = useState("");
  const list = useQuery<HostingList>(
    api,
    "/api/web/sites/hosting?limit=50" +
      (after ? "&after=" + encoded(after) : ""),
  );
  const action = useAction();
  const [secret, setSecret] = useState<string>();
  const [backup, setBackup] = useState<string>();
  return (
    <>
      <h1>웹 관리</h1>
      <Feedback {...list} />
      <Feedback {...action} />
      <Card title="사이트">
        <Button variant="secondary" onClick={list.reload}>
          새로고침
        </Button>
        <DataTable
          caption="사이트 목록과 용량"
          rows={list.value?.items ?? []}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "domain",
              header: "사이트",
              cell: (row) => (
                <Button variant="quiet" onClick={() => setId(row.id)}>
                  {row.domain}
                </Button>
              ),
            },
            {
              key: "status",
              header: "상태",
              cell: (row) => `${row.state} / ${row.phase}`,
            },
            {
              key: "account",
              header: "계정",
              cell: (row) => row.account ?? "미생성",
            },
            {
              key: "usage",
              header: "사용량 (바이트)",
              cell: (row) => row.usedBytes ?? "확인 안 됨",
            },
          ]}
        />
        <NextPage cursor={list.value?.next} onNext={setAfter} />
      </Card>
      {canWrite ? (
        <Card title="사이트 생성">
          <Form
            label="사이트 생성"
            busy={action.busy}
            onSubmit={(form) =>
              action.run(async () => {
                const result = await api.request<SiteMutationResult>(
                  "/api/web/sites",
                  "POST",
                  { domain: field(form, "domain") },
                );
                setSecret(
                  `계정: ${result.account}\n비밀번호: ${result.password}`,
                );
                setId(result.id);
                setAfter("");
                list.reload();
              })
            }
          >
            <TextField
              label="사이트 도메인"
              name="domain"
              required
              maxLength={253}
              placeholder="www.company.jgw.test"
            />
            <Button type="submit">사이트 생성</Button>
          </Form>
        </Card>
      ) : null}
      {id ? (
        <SiteDetail
          key={id}
          api={api}
          id={id}
          canWrite={canWrite}
          onChanged={list.reload}
          onSecret={setSecret}
          onDeleted={(backupId) => {
            setBackup(backupId);
            setId("");
            list.reload();
          }}
        />
      ) : null}
      {backup ? <p role="status">삭제 백업 ID: {backup}</p> : null}
      {secret ? (
        <Secret
          title="사이트 계정 비밀번호"
          value={secret}
          onClose={() => setSecret(undefined)}
        />
      ) : null}
    </>
  );
}

function SiteDetail({
  api,
  id,
  canWrite,
  onChanged,
  onSecret,
  onDeleted,
}: {
  api: Api;
  id: string;
  canWrite: boolean;
  onChanged: () => void;
  onSecret: (value: string) => void;
  onDeleted: (backupId: string) => void;
}) {
  const hosting = useQuery<SiteHostingView>(
    api,
    "/api/web/sites/" + encoded(id) + "/hosting",
  );
  const dns = useQuery<DnsAdvice>(
    api,
    "/api/web/sites/" + encoded(id) + "/dns",
  );
  const saved = useQuery<ContentView>(
    api,
    "/api/web/sites/" + encoded(id) + "/content",
  );
  const action = useAction();
  const [content, setContent] = useState<PageContent>({
    name: "",
    introduction: "",
    contact: "",
    logo: null,
  });
  const [preview, setPreview] = useState<PreviewView>();
  const [deployment, setDeployment] = useState<
    DeploymentView & { originRegistration: { status: string; message: string } }
  >();
  const [confirming, setConfirming] = useState<
    "delete" | "password" | "retry" | "deploy"
  >();
  const [dirty, setDirty] = useState(false);
  const loadedRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (saved.value && saved.value.revision !== loadedRevision.current) {
      loadedRevision.current = saved.value.revision;
      if (dirty) return;
      setContent(
        saved.value.content ?? {
          name: "",
          introduction: "",
          contact: "",
          logo: null,
        },
      );
      setDirty(false);
    }
  }, [saved.value, dirty]);
  const change = (patch: Partial<PageContent>) => {
    setContent((old) => ({ ...old, ...patch }));
    setDirty(true);
    setPreview(undefined);
    setDeployment(undefined);
  };
  const upload = async (file: File) => {
    if (file.type !== "image/png" || file.size > 1048576)
      throw new RequestError(400, "invalid_input");
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width > 1024 || bitmap.height > 1024)
        throw new RequestError(400, "invalid_input");
    } finally {
      bitmap.close();
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    change({ logo: { mimeType: "image/png", base64: btoa(binary) } });
  };
  const confirm = async () => {
    const operation = confirming;
    if (operation === "delete") {
      const result = await api.request<{ backupId: string }>(
        "/api/web/sites/" + encoded(id),
        "DELETE",
      );
      setConfirming(undefined);
      onDeleted(result.backupId);
    } else if (operation === "deploy") {
      if (!saved.value || saved.value.revision === 0 || dirty) return;
      const result = await api.request<
        DeploymentView & {
          originRegistration: { status: string; message: string };
        }
      >("/api/web/sites/" + encoded(id) + "/deploy", "POST", {
        expectedRevision: saved.value.revision,
      });
      setDeployment(result);
      setConfirming(undefined);
      hosting.reload();
      onChanged();
    } else if (operation) {
      const result = await api.request<SiteMutationResult>(
        "/api/web/sites/" +
          encoded(id) +
          (operation === "retry" ? "/retry" : "/account-password"),
        "POST",
        {},
      );
      onSecret(`계정: ${result.account}\n비밀번호: ${result.password}`);
      setConfirming(undefined);
      hosting.reload();
      onChanged();
    }
  };
  return (
    <Card title="사이트 상세">
      <Feedback {...hosting} />
      <Feedback {...dns} />
      <Feedback {...saved} />
      <Feedback {...action} />
      <Button
        variant="secondary"
        onClick={() => {
          hosting.reload();
          dns.reload();
          saved.reload();
        }}
      >
        현재 사이트 상태 다시 확인
      </Button>
      {hosting.value ? (
        <>
          <p>도메인: {hosting.value.domain}</p>
          <p>
            계정: {hosting.value.account ?? "미생성"} / 단계:{" "}
            {hosting.value.phase}
          </p>
          <p>
            사용량: {hosting.value.usedBytes ?? "미확인"} 바이트 / 디스크 사용
            가능: {hosting.value.disk.availableBytes} 바이트
          </p>
          <p>
            SFTP: {hosting.value.sftp.port} / FTPS: {hosting.value.ftps.port},
            패시브 {hosting.value.ftps.passivePorts.join("–")}
          </p>
        </>
      ) : null}
      {dns.value ? (
        <>
          <p>{dns.value.guidance}</p>
          <p>
            DNS {dns.value.type}: {dns.value.name} →{" "}
            {dns.value.address ?? "주소 입력 필요"}
          </p>
          {dns.value.hostsEntry ? <pre>{dns.value.hostsEntry}</pre> : null}
        </>
      ) : null}
      {canWrite ? (
        <>
          <Form
            label="사이트 콘텐츠 편집"
            busy={action.busy}
            onSubmit={() =>
              action.run(async () => {
                const result = await api.request<ContentView>(
                  "/api/web/sites/" + encoded(id) + "/content",
                  "PUT",
                  { expectedRevision: saved.value?.revision, content },
                );
                loadedRevision.current = result.revision;
                setContent(result.content ?? content);
                setDirty(false);
                saved.reload();
              })
            }
          >
            <TextField
              label="회사 이름"
              name="name"
              required
              maxLength={120}
              value={content.name}
              onChange={(event) => change({ name: event.target.value })}
            />
            <TextArea
              label="소개"
              name="introduction"
              required={false}
              maxLength={4096}
              value={content.introduction}
              onChange={(value) => change({ introduction: value })}
            />
            <TextField
              label="공개 연락처"
              name="contact"
              maxLength={512}
              value={content.contact}
              onChange={(event) => change({ contact: event.target.value })}
            />
            <label className="jgw-field">
              로고 PNG (1 MiB, 1024px 이하)
              <input
                type="file"
                accept="image/png"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file)
                    void action.run(() => upload(file), "로고를 선택했습니다.");
                }}
              />
            </label>
            {content.logo ? (
              <>
                <img
                  className="logo-preview"
                  alt="선택한 로고"
                  src={"data:image/png;base64," + content.logo.base64}
                />
                <Button
                  variant="secondary"
                  onClick={() => change({ logo: null })}
                >
                  로고 제거
                </Button>
              </>
            ) : null}
            <Button type="submit" disabled={!saved.value}>
              콘텐츠 저장
            </Button>
          </Form>
          <Button
            variant="secondary"
            disabled={action.busy || !content.name.trim()}
            onClick={() =>
              void action.run(async () => {
                setPreview(
                  await api.request<PreviewView>(
                    "/api/web/sites/" + encoded(id) + "/preview",
                    "POST",
                    { content },
                  ),
                );
              }, "미리보기를 준비했습니다.")
            }
          >
            미리보기
          </Button>
          <Button
            disabled={action.busy || !saved.value?.revision || dirty}
            onClick={() => setConfirming("deploy")}
          >
            저장한 버전 배포
          </Button>
          <Button
            variant="secondary"
            disabled={action.busy}
            onClick={() => setConfirming("password")}
          >
            계정 비밀번호 재설정
          </Button>
          {hosting.value?.state === "failed" ? (
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() => setConfirming("retry")}
            >
              사이트 준비 재시도
            </Button>
          ) : null}
          <Button
            variant="danger"
            disabled={action.busy}
            onClick={() => setConfirming("delete")}
          >
            사이트 삭제
          </Button>
        </>
      ) : null}
      {preview ? (
        <>
          <SandboxedHtml title="사이트 미리보기" html={preview.html} />
          <pre>{preview.widgetSnippet}</pre>
        </>
      ) : null}
      {deployment ? (
        <Alert
          tone={
            deployment.originRegistration.status === "registered"
              ? "success"
              : "warning"
          }
        >
          사이트 배포 완료: {deployment.origin}
          <br />
          {deployment.originRegistration.message}
        </Alert>
      ) : null}
      {confirming ? (
        <Confirm
          title={
            confirming === "delete"
              ? "사이트 삭제 확인"
              : confirming === "deploy"
                ? "사이트 배포 확인"
                : "사이트 계정 변경 확인"
          }
          busy={action.busy}
          onClose={() => setConfirming(undefined)}
          onConfirm={() => void action.run(confirm)}
        >
          {confirming === "delete"
            ? "사이트를 삭제하고 기존 데이터의 백업 ID를 반환합니다."
            : confirming === "deploy"
              ? "저장한 콘텐츠 버전을 배포합니다. 상담 출처 등록 결과는 배포 결과와 별도로 표시됩니다."
              : "새 비밀번호는 한 번만 표시됩니다. 기존 접속 설정도 갱신해야 합니다."}
        </Confirm>
      ) : null}
    </Card>
  );
}
