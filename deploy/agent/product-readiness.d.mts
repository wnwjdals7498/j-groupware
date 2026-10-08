export class ProductReadiness {
  constructor(options: {
    environment: {
      profile(service: string): {
        port: number;
        ca: string;
        serverName?: string;
        publicHost?: string;
      };
    };
    timeout?: number;
  });
  probe(service: string, signal?: AbortSignal): Promise<boolean>;
}
