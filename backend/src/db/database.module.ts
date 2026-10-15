import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { databaseUrl } from '../config';
import type { DB } from './types';

export const KYSELY = Symbol('KYSELY');
export type Database = Kysely<DB>;

export function createDatabase(url = databaseUrl()): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 10 }) }) });
}

@Injectable()
class DatabaseCloser implements OnModuleDestroy {
  constructor(@Inject(KYSELY) private readonly db: Database) {}
  async onModuleDestroy() {
    await this.db.destroy();
  }
}

@Global()
@Module({
  providers: [{ provide: KYSELY, useFactory: () => createDatabase() }, DatabaseCloser],
  exports: [KYSELY],
})
export class DatabaseModule {}
