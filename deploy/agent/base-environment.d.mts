export interface PreparedBootstrap {
  tenant: string;
  keycloakOrigin: string;
  consoleOrigin: string;
  clientSecret: string;
  serviceKey: string;
  agentKey: string;
  ca: string;
  bundles: { service: string; archive: string; digest: string }[];
}
export function readPreparedBootstrap(root: string): Promise<PreparedBootstrap>;
export class BaseEnvironment {
  constructor(options: {
    bootstrap: PreparedBootstrap;
    databasePort: number;
    port: number;
    publicOrigin: string;
    authApiOrigin: string;
    certificate: string;
    key: string;
    services?: Record<string, string>;
  });
  profile(service: string): {
    port: number;
    ca: string;
    serverName: string;
    publicHost: string;
  };
  variables(
    service: string,
    secrets: { databasePassword: string; notificationKey: string },
  ): Record<string, string>;
  render(
    service: string,
    secrets: { databasePassword: string; notificationKey: string },
  ): string;
  read(
    service: string,
    text: string,
  ): { databasePassword: string; notificationKey: string };
}
