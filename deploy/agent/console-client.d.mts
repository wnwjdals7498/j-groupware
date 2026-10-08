export class ConsoleAgentClient {
  constructor(options: {
    tenant: string;
    origin: string;
    key: string;
    fetch?: typeof globalThis.fetch;
  });
  desired(
    signal?: AbortSignal,
  ): Promise<{ tenant: string; services: string[] }>;
  report(
    result: {
      tenant: string;
      outcome: string;
      installed?: string[];
      phase?: string;
      error?: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}
