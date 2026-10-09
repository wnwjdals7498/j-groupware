import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Alert, Button, Dialog } from "@j-groupware/ui";
import type { Api } from "./api.js";
import { errorText } from "./api.js";

export function useQuery<T>(api: Api, path: string | undefined) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setValue(undefined);
    if (!path) {
      setLoading(false);
      return () => controller.abort();
    }
    void api
      .request<T>(path, "GET", undefined, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setValue(next);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorText(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, path, version]);
  const reload = useCallback(() => setVersion((old) => old + 1), []);
  return { value, error, loading, reload };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  // The disabled form/button is complemented by a lock before React renders.
  const [lock] = useState(() => ({ busy: false, mounted: true }));
  useEffect(() => {
    lock.mounted = true;
    return () => {
      lock.mounted = false;
    };
  }, [lock]);
  async function run(
    work: () => Promise<void>,
    message = "변경 사항이 반영되었습니다.",
  ) {
    if (lock.busy) return;
    lock.busy = true;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await work();
      if (lock.mounted) setStatus(message);
    } catch (failure) {
      if (lock.mounted) setError(errorText(failure));
    } finally {
      lock.busy = false;
      if (lock.mounted) setBusy(false);
    }
  }
  return { busy, error, status, run };
}

export function Feedback({
  error,
  loading,
  status,
}: {
  error?: string | undefined;
  loading?: boolean;
  status?: string | undefined;
}) {
  return (
    <>
      {loading ? <p role="status">불러오는 중…</p> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {status ? <Alert tone="success">{status}</Alert> : null}
    </>
  );
}

export function Form({
  label,
  onSubmit,
  busy,
  children,
}: {
  label: string;
  onSubmit: (form: FormData) => Promise<void>;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <form
      aria-label={label}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!busy) void onSubmit(new FormData(event.currentTarget));
      }}
    >
      <fieldset disabled={busy}>{children}</fieldset>
    </form>
  );
}

export const field = (form: FormData, name: string) =>
  String(form.get(name) ?? "");
export const nullableField = (form: FormData, name: string) =>
  field(form, name) || null;

export function TextArea({
  label,
  name,
  value,
  onChange,
  maxLength = 20000,
  required = true,
}: {
  label: string;
  name: string;
  value?: string;
  onChange?: (value: string) => void;
  maxLength?: number;
  required?: boolean;
}) {
  return (
    <label className="jgw-field">
      {label}
      <textarea
        name={name}
        required={required}
        maxLength={maxLength}
        {...(value === undefined ? {} : { value })}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  );
}

export function Select({
  label,
  name,
  value,
  defaultValue,
  onChange,
  children,
  required = false,
}: {
  label: string;
  name: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="jgw-field">
      {label}
      <select
        aria-label={label}
        name={name}
        {...(value === undefined ? {} : { value })}
        {...(defaultValue === undefined ? {} : { defaultValue })}
        required={required}
        onChange={(event) => onChange?.(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

export function Confirm({
  title,
  children,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            취소
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            확인
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

export function Secret({
  title,
  value,
  onClose,
}: {
  title: string;
  value: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(value))
                .then(() => {
                  setCopied(true);
                  setCopyError(false);
                })
                .catch(() => setCopyError(true));
            }}
          >
            복사
          </Button>
          <Button onClick={onClose}>보관 완료</Button>
        </>
      }
    >
      <p>이 값은 지금 한 번만 표시됩니다. 안전한 곳에 보관한 후 닫아 주세요.</p>
      <pre className="secret" aria-label={title}>
        {value}
      </pre>
      {copied ? (
        <p role="status">복사했습니다. 안전한 곳에 보관해 주세요.</p>
      ) : null}
      {copyError ? (
        <p role="alert">
          브라우저가 복사를 허용하지 않았습니다. 값을 직접 선택해 보관해 주세요.
        </p>
      ) : null}
    </Dialog>
  );
}

export function NextPage({
  cursor,
  onNext,
}: {
  cursor: string | null | undefined;
  onNext: (cursor: string) => void;
}) {
  return cursor ? (
    <Button variant="secondary" onClick={() => onNext(cursor)}>
      다음 페이지
    </Button>
  ) : null;
}
