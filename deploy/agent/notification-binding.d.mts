import type { NotificationManifest } from "./notification-manifest.mjs";
export interface NotificationInstallerBinding {
  readonly tenant: string;
  readonly root: string;
  readonly databasePort: number;
  readonly baseEnvironmentFile: string;
  readonly inputFiles: readonly string[];
  readonly manifest: NotificationManifest;
  preflight(
    service: string,
    kind?: "install" | "remove",
    signal?: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}
export function isNotificationInstallerBinding(
  value: unknown,
): value is NotificationInstallerBinding;
export function loadNotificationInstallerBinding(options: {
  controlFile: string;
  tenant: string;
  databasePort: number;
  baseEnvironmentFile: string;
  authOrigin: string;
  fetch?: typeof globalThis.fetch;
}): Promise<NotificationInstallerBinding>;
