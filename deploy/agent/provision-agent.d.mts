import type { PreparedBootstrap } from "./base-environment.mjs";
import type { ProductEnvironment } from "./product-environment.mjs";
export interface ProvisionAgentControl {
  bootstrap: PreparedBootstrap;
  environment: ProductEnvironment;
  installer: string;
  stateRoot: string;
  lockRoot: string;
}
export interface ProvisionAgentResult {
  tenant: string;
  outcome: "busy" | "failed" | "synchronized";
  actions: { kind: "install" | "remove"; service: string; outcome: string }[];
  reported: boolean;
  installed?: string[];
  incomplete?: string[];
  desired?: string[];
  error?: string;
  phase?: string;
  reportError?: string;
}
export function loadProvisionAgentControl(
  file: string,
): Promise<ProvisionAgentControl>;
export function createProvisionAgentRuntime(
  options: ProvisionAgentControl & { fetch?: typeof globalThis.fetch },
): { runOnce(signal?: AbortSignal): Promise<ProvisionAgentResult> };
