import type { ProductSecrets } from "./product-environment.mjs";
export class ServiceEnvironment {
  constructor(options: {
    root: string;
    backups: string;
    render(service: string, secrets: ProductSecrets): string;
    read(service: string, text: string): ProductSecrets;
  });
  file(service: string): string;
  prepare(
    service: string,
    generate: () => ProductSecrets,
  ): Promise<ProductSecrets>;
  remove(service: string): Promise<void>;
  backupPath(service: string): Promise<string>;
}
