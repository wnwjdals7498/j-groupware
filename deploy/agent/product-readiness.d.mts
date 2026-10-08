export interface ReadinessProfile {
  port: number;
  ca: string;
  serverName?: string;
  publicHost?: string;
}
export class ProductReadiness {
  constructor(options: {
    environment: { profile(service: string): ReadinessProfile };
    timeout?: number;
  });
  probe(service: string, signal?: AbortSignal): Promise<boolean>;
}
export class ServiceInventory {
  constructor(options: {
    tenant: string;
    state: {
      tenant: string;
      read(service: string): Promise<{ status: string } | null>;
    };
    readiness: Pick<ProductReadiness, "probe">;
  });
  read(
    signal?: AbortSignal,
  ): Promise<{ tenant: string; installed: string[]; incomplete: string[] }>;
}
