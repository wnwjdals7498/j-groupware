export class ProductGateway {
  constructor(options: {
    root: string;
    profile: Record<string, string>;
    state: {
      tenant: string;
      read(service: string): Promise<{ status: string } | null>;
    };
    commands: { validate(): Promise<unknown>; reload(): Promise<unknown> };
    substitute?(
      input: string,
      variables: Record<string, string>,
    ): Promise<string>;
  });
  set(
    service: string,
    enabled: boolean,
  ): Promise<{ changed: boolean; reloaded: boolean }>;
}
