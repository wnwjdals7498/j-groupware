export function execute(
  command: string,
  args: string[],
  options?: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
): Promise<string>;
