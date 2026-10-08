export class BundleInstaller {
  constructor(options: {
    root: string;
    npmConfig: string;
    cache: string;
    npmCli: string;
  });
  install(
    input: { service: string; archive: string; digest: string },
    signal?: AbortSignal,
  ): Promise<{
    service: string;
    phase: string;
    changed: boolean;
    archiveSha256: string;
  }>;
}
