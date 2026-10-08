export function buildProductBundle(options: {
  service: string;
  sourceRoot: string;
  output: string;
  npmConfig: string;
  cache: string;
  npmCli: string;
  registryOrigin?: string;
}): Promise<{
  service: string;
  output: string;
  sha256: string;
  bytes: number;
  sourceFiles: number;
}>;
