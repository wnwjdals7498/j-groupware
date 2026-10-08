export class NotificationManifest {
  constructor(options: {
    root: string;
    tenant: string;
    projector: {
      reconcile(
        manifest: {
          tenantId: string;
          revision: string;
          keys: Partial<
            Record<"j-approval" | "j-talk" | "j-mail", { currentHash: string }>
          >;
        },
        signal?: AbortSignal,
      ): Promise<void>;
    };
  });
  read(): Promise<{
    tenantId: string;
    revision: string;
    keys: Partial<
      Record<"j-approval" | "j-talk" | "j-mail", { currentHash: string }>
    >;
  } | null>;
  register(
    service: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ tenant: string; revision: string }>;
  remove(
    service: string,
    signal?: AbortSignal,
  ): Promise<{ tenant: string; revision: string }>;
  refresh(signal?: AbortSignal): Promise<{ tenant: string; revision: string }>;
}
