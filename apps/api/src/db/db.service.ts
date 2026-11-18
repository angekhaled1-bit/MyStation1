import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Queryable = Pick<pg.PoolClient, 'query'>;

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/fuelprice',
  });

  async onModuleInit() {
    await this.migrate();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  /** Migrations SQL appliquées dans l'ordre alphabétique, une seule fois chacune. */
  async migrate() {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    await this.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await this.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await this.tx(async (c) => {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('insert into schema_migrations(name) values ($1)', [f]);
      });
      this.log.log(`migration appliquée : ${f}`);
    }
  }
}
