import type { Pool } from "pg";
export class PostgresServiceDatabase {
  constructor(options: {
    admin: Pool;
    tenant: string;
    connection: (service?: string) => { host: string; port: number };
    dumpBinary?: string;
    dumpEnv?: Record<string, string>;
  });
  prepareBase(): Promise<void>;
  ensure(service: string, password: string): Promise<void>;
  inspect(
    service: string,
  ): Promise<{ role: boolean; database: boolean; login: boolean }>;
  disable(
    service: string,
    options?: { databaseAbsent?: boolean },
  ): Promise<void>;
}
