import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TdHTMLAttributes,
} from "react";
import { useEffect, useRef, useId } from "react";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "quiet";
};

export function Button({
  className = "",
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`jgw-button jgw-button--${variant} ${className}`.trim()}
      type={type}
      {...props}
    />
  );
}

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
};

export function TextField({
  id,
  label,
  hint,
  error,
  className = "",
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy =
    [props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={`jgw-field ${className}`.trim()}>
      <label className="jgw-field__label" htmlFor={fieldId}>
        {label}
      </label>
      <input
        {...props}
        className="jgw-input"
        id={fieldId}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={describedBy}
      />
      {hint ? (
        <span className="jgw-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="jgw-field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export type CardProps = HTMLAttributes<HTMLElement> & {
  title?: string;
  description?: string;
};

export function Card({
  title,
  description,
  className = "",
  children,
  ...props
}: CardProps) {
  return (
    <section className={`jgw-card ${className}`.trim()} {...props}>
      {title || description ? (
        <header className="jgw-card__header">
          {title ? <h2 className="jgw-card__title">{title}</h2> : null}
          {description ? (
            <p className="jgw-card__description">{description}</p>
          ) : null}
        </header>
      ) : null}
      <div className="jgw-card__body">{children}</div>
    </section>
  );
}

export type AppShellProps = {
  brand: ReactNode;
  navigation: ReactNode;
  children: ReactNode;
  className?: string;
};

export function AppShell({
  brand,
  navigation,
  children,
  className = "",
}: AppShellProps) {
  return (
    <div className={`jgw-app-shell ${className}`.trim()}>
      <aside className="jgw-sidebar">
        <div className="jgw-sidebar__brand">{brand}</div>
        <nav className="jgw-sidebar__navigation" aria-label="주 메뉴">
          {navigation}
        </nav>
      </aside>
      <main className="jgw-main">{children}</main>
    </div>
  );
}

export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  headerProps?: HTMLAttributes<HTMLTableCellElement>;
  cellProps?: (row: Row) => TdHTMLAttributes<HTMLTableCellElement>;
};

export function DataTable<Row>({
  caption,
  rows,
  columns,
  getRowKey,
}: {
  caption: string;
  rows: readonly Row[];
  columns: readonly DataTableColumn<Row>[];
  getRowKey: (row: Row, index: number) => string;
}) {
  return (
    <div
      className="jgw-table-wrap"
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table className="jgw-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" {...column.headerProps}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={getRowKey(row, index)}>
              {columns.map((column) => (
                <td key={column.key} {...column.cellProps?.(row)}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={Math.max(columns.length, 1)}
                className="jgw-table__empty"
              >
                데이터가 없습니다.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export type DialogProps = {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
};

export function Dialog({
  title,
  open,
  onClose,
  children,
  actions,
}: DialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const previousFocus = document.activeElement;
    const firstControl = dialogRef.current.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    firstControl?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="jgw-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="jgw-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onClose();
            return;
          }
          if (event.key !== "Tab" || !dialogRef.current) return;
          const controls = dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          );
          const first = controls.item(0);
          const last = controls.item(controls.length - 1);
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === dialogRef.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="jgw-dialog__header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="quiet" aria-label="닫기" onClick={onClose}>
            닫기
          </Button>
        </header>
        <div className="jgw-dialog__body">{children}</div>
        {actions ? (
          <footer className="jgw-dialog__actions">{actions}</footer>
        ) : null}
      </section>
    </div>
  );
}

export type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="jgw-empty-state">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action ? <div className="jgw-empty-state__action">{action}</div> : null}
    </div>
  );
}

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  live?: "polite" | "assertive";
};

export function Alert({
  tone = "info",
  title,
  live = "polite",
  className = "",
  children,
  ...props
}: AlertProps) {
  return (
    <div
      className={`jgw-alert jgw-alert--${tone} ${className}`.trim()}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={live}
      {...props}
    >
      {title ? <strong className="jgw-alert__title">{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}
