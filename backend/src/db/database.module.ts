import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import { databaseUrl } from '../config';
import type { DB } from './types';

// date 欄位（例：巡邏排程 once_date）照原字串 'YYYY-MM-DD' 回傳；預設會被轉成伺服器時區的午夜 Date
types.setTypeParser(types.builtins.DATE, (v) => v);

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
