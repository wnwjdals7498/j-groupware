import { createElement, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert,
  AppShell,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  TextField,
} from "@j-groupware/ui";
import "@j-groupware/ui/styles.css";
import { MessengerApp } from "@j-messenger/client-react";
import "@j-messenger/client-react/styles.css";
import { createMessengerClient } from "@j-messenger/client-core";

function Fixture() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const untrustedTitle = '<img src=x onerror="window.__xss=true">';
  const messenger = useMemo(
    () =>
      createMessengerClient({
        baseUrl: "https://fake-messenger.invalid",
        fetch: async () =>
          new Response(
            JSON.stringify({ data: [{ id: "fixture", name: "가짜 서버" }] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      }),
    [],
  );

  return (
    <>
      <AppShell
        brand={<strong>공통 UI fixture</strong>}
        navigation={
          <>
            <a href="#overview">개요</a>
            <a href="#records">목록</a>
          </>
        }
      >
        <section id="overview" aria-labelledby="fixture-heading">
          <h1 id="fixture-heading">브라우저 컴포넌트 시험</h1>
          <Button onClick={() => setDialogOpen(true)}>대화상자 열기</Button>
          <TextField
            label="표시 이름"
            value=""
            readOnly
            error="표시 이름을 입력해 주세요."
          />
          <DataTable
            caption="최근 항목"
            rows={[]}
            columns={[{ key: "name", header: "이름", cell: () => "" }]}
            getRowKey={(_, index) => String(index)}
          />
          <Alert title="저장 상태">변경 사항이 저장되었습니다.</Alert>
          <EmptyState
            title={untrustedTitle}
            description="사용자가 제공한 텍스트입니다."
          />
        </section>
        <Dialog
          title="키보드 대화상자"
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          actions={<Button onClick={() => setDialogOpen(false)}>완료</Button>}
        >
          <Button variant="secondary">대화상자 내부 동작</Button>
        </Dialog>
      </AppShell>
      <section
        className="messenger-fixture"
        aria-label="메신저 가짜 API fixture"
      >
        <MessengerApp client={messenger} />
      </section>
    </>
  );
}

Object.assign(window, {
  __fixtureProvenance: {
    acceptance_complete: false,
    source: "Chromium public component fixture with fake Messenger API",
    not_run_list: ["전체 제품 UI", "실제 Keycloak 로그인", "실제 메신저 API"],
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("fixture root element is missing");
createRoot(root).render(createElement(Fixture));
