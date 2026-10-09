export interface ProductProfile {
  port: number;
  certificate: string;
  key: string;
  ca: string;
  dataRoot?: string;
  mailpitOrigin?: string;
  customerAddress?: string;
  publicOrigin?: string;
  guestSigningKey?: string;
}
export interface ProductSecrets {
  databasePassword: string;
  notificationKey: string;
  cursorSigningKey?: string;
}
export const PRODUCT_SERVICES: readonly string[];
export const BUNDLE_SERVICES: readonly string[];
export class ProductEnvironment {
  constructor(options: {
    tenant: string;
    databasePort: number;
    keycloakOrigin: string;
    profiles: Record<string, ProductProfile>;
    notificationOrigin?: string;
    serviceKey?: string;
  });
  tenant: string;
  profile(
    service: string,
  ): Readonly<ProductProfile & { serverName?: string; publicHost?: string }>;
  variables(service: string, secrets: ProductSecrets): Record<string, string>;
  render(service: string, secrets: ProductSecrets): string;
  read(service: string, text: string): ProductSecrets;
}
