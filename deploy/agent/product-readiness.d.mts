export class ProductReadiness {
  constructor(options: {
    environment: { profile(service: string): { port: number; ca: string } };
    timeout?: number;
  });
  probe(service: string, signal?: AbortSignal): Promise<boolean>;
}
