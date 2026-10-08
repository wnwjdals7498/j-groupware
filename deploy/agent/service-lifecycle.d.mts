export class ServiceStateFiles {
  constructor(root: string, tenant: string);
  root: string;
  tenant: string;
  read(service: string): Promise<{
    tenant: string;
    service: string;
    status: string;
    phase: string;
    [key: string]: unknown;
  } | null>;
  write(service: string, state: Record<string, unknown>): Promise<void>;
}
export class ServiceLifecycle {
  constructor(options: {
    tenant: string;
    state: ServiceStateFiles;
    lock?: { acquire(): Promise<(() => Promise<void>) | null> };
    database: {
      ensure(service: string, password: string): Promise<unknown>;
      inspect(service: string): Promise<{ role: boolean; database: boolean }>;
      dump(service: string, destination: string): Promise<unknown>;
      disable(
        service: string,
        options: { expectDatabaseAbsent: boolean },
      ): Promise<unknown>;
    };
    platform: {
      preflight(service: string): Promise<unknown>;
      install(service: string): Promise<unknown>;
      start(service: string): Promise<unknown>;
      ready(service: string): Promise<unknown>;
      stop(
        service: string,
        options: { allowMissing: boolean },
      ): Promise<unknown>;
    };
    gateway: { set(service: string, enabled: boolean): Promise<unknown> };
    notifications?: {
      register(service: string, key: string): Promise<unknown>;
      remove(service: string): Promise<unknown>;
    };
    cleanup: { run(service: string): Promise<unknown> };
    environment: import("./service-environment.mjs").ServiceEnvironment;
  });
  run(
    service: string,
    kind?: "install" | "remove",
  ): Promise<{
    tenant: string;
    service: string;
    status: "active" | "removed";
    backup?: string;
  }>;
}
