import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { UUID_RE } from '../config/constants.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';

interface Scope {
  /** Branches this request may see. Row-level security uses this. */
  branchIds: string[];
  role: string;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger(DbService.name);
  // DATABASE_URL must connect as the limited trot_app role, so branch isolation is enforced by the database.
  private readonly pool: pg.Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new pg.Pool({
      connectionString: config.db.url,
      max: config.db.poolMax,
      idleTimeoutMillis: config.db.idleTimeoutMs,
      statement_timeout: config.db.statementTimeoutMs,
      ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
    });
    // Without this handler, a dropped idle connection is an unhandled 'error' event and kills the process.
    this.pool.on('error', (e) => this.log.error(`Idle database connection failed: ${e.message}`));
  }

  /** Unscoped query. Branch-owned tables return NO rows here by design. Fine for accounts and sign-in tables. */
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  /** One transaction with no branch scope (sign-in work). Rolls back if fn throws. */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Runs fn in one transaction limited to the given branches. Rolls back on any error.
   * The branch list lives only as long as the transaction (set_config ... true).
   */
  async scoped<T>(scope: Scope, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const ids = scope.branchIds.filter((id) => UUID_RE.test(id));
    return this.tx(async (c) => {
      await c.query(`SELECT set_config('app.branch_ids', $1, true), set_config('app.role', $2, true)`, [ids.join(','), scope.role]);
      return fn(c);
    });
  }

  /**
   * For a check inside a transaction that has no branch scope of its own, such as "does this coach have classes ahead
   * in the branches they work in". Those branches are visible only while fn runs, then the old scope is put back.
   * If fn throws, the caller's transaction rolls back and the scope goes with it.
   */
  async withBranches<T>(c: pg.PoolClient, branchIds: string[], fn: () => Promise<T>): Promise<T> {
    const ids = branchIds.filter((id) => UUID_RE.test(id)).join(',');
    const before = (await c.query(`SELECT coalesce(current_setting('app.branch_ids', true), '') AS ids`)).rows[0].ids as string;
    await c.query(`SELECT set_config('app.branch_ids', $1, true)`, [ids]);
    const out = await fn();
    await c.query(`SELECT set_config('app.branch_ids', $1, true)`, [before]);
    return out;
  }

  /** Like withBranches, for every branch this account works in. */
  async withAccountBranches<T>(c: pg.PoolClient, accountId: string, fn: () => Promise<T>): Promise<T> {
    const rows = (await c.query(`SELECT branch_id::text AS id FROM account_branches WHERE account_id = $1`, [accountId])).rows;
    return this.withBranches(c, rows.map((r) => r.id as string), fn);
  }

  /**
   * Runs fn only if no other server is already holding this lock (a Postgres advisory lock, shared by every API instance
   * that uses the same database). Returns undefined, without running fn, when someone else holds it.
   * The lock belongs to one connection and is released when fn ends, or if this server dies.
   */
  async withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | undefined> {
    const c = await this.pool.connect();
    try {
      const got = (await c.query('SELECT pg_try_advisory_lock($1) AS ok', [key])).rows[0].ok as boolean;
      if (!got) return undefined;
      try {
        return await fn();
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [key]);
      }
    } finally {
      c.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
