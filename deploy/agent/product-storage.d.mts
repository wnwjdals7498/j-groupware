export interface StorageProfile {
  root: string;
  maxBytes: number;
  maxEntries: number;
}
export function protectedStoragePath(
  target: string,
  directory?: boolean,
  traversable?: boolean,
): Promise<void>;
export function storageAccount(
  service: string,
): Promise<{ uid: number; gid: number }>;
export class ProductStorage {
  constructor(options: {
    tenant: string;
    stateRoot: string;
    backupRoot: string;
    profiles: Partial<Record<"j-messenger" | "j-mail", StorageProfile>>;
    stopped(service: string): Promise<boolean>;
    mailpit?: {
      inspect(): Promise<{ running: boolean } | null>;
      stop(): Promise<unknown>;
    };
  });
  preflight(service: string): Promise<unknown>;
  prepare(
    service: string,
  ): Promise<{ service: string; storage: "prepared"; changed: boolean }>;
  run(
    service: string,
    context?: { databaseBackup?: string },
  ): Promise<{
    service: string;
    data: "retained" | "absent";
    storageBackup?: string;
    bytes?: number;
    files?: number;
  }>;
  verify(
    service: string,
    destination: string,
    databaseBackup?: string,
  ): Promise<{
    service: string;
    storageBackup: string;
    bytes: number;
    files: number;
  }>;
}
