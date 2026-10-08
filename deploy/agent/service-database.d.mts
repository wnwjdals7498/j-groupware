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
  ensure(
    service: string,
    password: string,
  ): Promise<{ database: string; user: string }>;
  inspect(
    service: string,
  ): Promise<{ role: boolean; database: boolean; login: boolean }>;
  disable(
    service: string,
    options?: { expectDatabaseAbsent?: boolean },
  ): Promise<{ database: string | false; role: boolean; login: false }>;
}
