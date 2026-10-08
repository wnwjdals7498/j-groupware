export interface BootstrapInput {
  tenant: string;
  clientSecret: string;
  serviceKey: string;
  agentKey: string;
  authOrigin: string;
  consoleOrigin: string;
  localCa: string;
  bundles: { service: string; archive: string; digest: string }[];
}
export class BootstrapFiles {
  constructor(root: string);
  prepare(
    input: BootstrapInput,
  ): Promise<{
    tenant: string;
    phase: string;
    bundles: string[];
    caFingerprint: string;
  }>;
}
