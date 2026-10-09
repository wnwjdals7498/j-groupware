import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert, DataTable, Dialog, TextField } from "../src/index.js";

afterEach(cleanup);

describe("shared UI primitives", () => {
  it("associates a labelled field with its hint and validation error", () => {
    render(
      <TextField
        label="이메일"
        name="email"
        id="email"
        hint="업무용 이메일을 입력하세요."
        error="형식을 확인하세요."
        aria-invalid={false}
        aria-describedby="policy-note"
      />,
    );

    const field = screen.getByRole("textbox", { name: "이메일" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(
      "policy-note email-hint email-error",
    );
    expect(screen.getByRole("alert").textContent).toBe("형식을 확인하세요.");
  });

  it("renders the data table as a captioned table with a clear empty state", () => {
    render(
      <DataTable
        caption="회원 목록"
        rows={[] as readonly { id: string; name: string }[]}
        columns={[{ key: "name", header: "이름", cell: (row) => row.name }]}
        getRowKey={(row) => row.id}
      />,
    );

    expect(screen.getByRole("table", { name: "회원 목록" })).toBeTruthy();
    expect(screen.getByText("데이터가 없습니다.")).toBeTruthy();
  });

  it("announces status and provides a labelled closeable dialog", () => {
    const { rerender } = render(<Alert tone="success">저장했습니다.</Alert>);
    expect(screen.getByRole("status").textContent).toContain("저장했습니다.");

    const onClose = vi.fn();
    rerender(
      <Dialog title="설정" open onClose={onClose}>
        설정 내용
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "설정" })).toBeTruthy();
    const close = screen.getByRole("button", { name: "닫기" });
    expect(close).toBeTruthy();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
