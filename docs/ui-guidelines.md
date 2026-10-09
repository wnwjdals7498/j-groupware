# J Groupware UI guidelines

This document is the shared visual and interaction baseline for the customer web app. `@j-groupware/ui` is its React implementation; embedded service screens such as j-messenger consume the public `--jgw-*` CSS custom properties.

## Design tokens

Load `@j-groupware/ui/styles.css` once from the application shell. The root variables are also safe to override inside a branded shell when a future product decision defines an approved theme.

| Token                             | Value                                   | Use                                         |
| --------------------------------- | --------------------------------------- | ------------------------------------------- |
| `--jgw-color-primary`             | `#2454d6`                               | Primary actions, links, selected navigation |
| `--jgw-color-text`                | `#172033`                               | Main text and headings                      |
| `--jgw-color-surface`             | `#ffffff`                               | Cards, panels, fields                       |
| `--jgw-color-background`          | `#f3f6fb`                               | App canvas                                  |
| `--jgw-color-muted`               | `#536078`                               | Secondary text                              |
| `--jgw-color-border`              | `#d8e0ed`                               | Control and panel borders                   |
| `--jgw-color-focus`               | `#2454d6`                               | Keyboard focus ring                         |
| `--jgw-color-danger`              | `#b42336`                               | Errors and destructive status               |
| `--jgw-color-success`             | `#16794b`                               | Successful status                           |
| `--jgw-space-1` … `--jgw-space-6` | `4, 8, 12, 16, 24, 32px`                | Padding, gaps, and margins                  |
| `--jgw-font-family`               | `system-ui, "Noto Sans KR", sans-serif` | All product text                            |
| `--jgw-radius-control`            | `8px`                                   | Buttons and form controls                   |
| `--jgw-radius-panel`              | `12px`                                  | Cards and panels                            |

## Layout

The desktop application shell uses a fixed-width navigation sidebar beside a flexible main content region. Keep the content column fluid and allow it to shrink with `min-width: 0`. At widths below `720px`, present navigation as a compact top or drawer region and give the main content the full viewport width. At `360px`, controls must remain reachable without horizontal page scrolling; long labels and values wrap or truncate within their own region.

Use a page canvas, surface panels, clear headings, and consistent spacing tokens. Prefer a single main landmark and a labelled navigation landmark. Keep dialogs and transient errors associated with their triggering controls.

## Components and interaction

The package provides `Button`, `TextField`, `Card`, `AppShell`, `DataTable`, `Dialog`, `EmptyState`, and `Alert`. Components accept normal HTML attributes where appropriate, expose semantic elements, and leave content decisions to the application. Use `aria-label` for icon-only controls and `aria-describedby` for field hints or errors.

All controls must work by keyboard. Focus is always visible, never removed without an equivalent, and does not rely on color alone. Disabled controls use the native `disabled` attribute. Error and success messages use `role="alert"` or `role="status"` according to urgency.

## Accessibility and responsive checks

- Text uses the high-contrast `--jgw-color-text` on white or the app background. Primary actions use white text on `#2454d6` (contrast ratio approximately 6.34:1).
- Interactive targets have a visible focus ring with offset and sufficient contrast. Pointer hover is an enhancement, not the only state cue.
- Tables use real table markup and captions; dialogs have a labelled heading and modal semantics.
- Verify the shell at 360px and desktop widths, keyboard tab order, focus visibility, label-to-control association, and screen-reader announcement of errors and status.
