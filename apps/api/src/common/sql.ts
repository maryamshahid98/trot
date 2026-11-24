import type pg from 'pg';

/** What a service needs from its open transaction: run a query. Rows come back as pg gives them, with untyped columns. */
/** One row as pg returns it: columns by name, values untyped. Convert what you use (numbers arrive as strings, for example). */
export type Row = pg.QueryResultRow;

export type Tx = { query: (sql: string, params?: unknown[]) => Promise<{ rows: pg.QueryResultRow[]; rowCount: number | null }> };

/** SQL that turns a timestamp expression into epoch milliseconds, the unit the rules code uses. Only pass literal column expressions. */
export const epochMs = (expr: string) => `(extract(epoch from ${expr}) * 1000)::bigint`;

/** "Same day" for a branch means the day on that branch's own clock, not UTC. */
export function dayKeyFor(timeZone: string): (ms: number) => string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (ms) => f.format(new Date(ms));
}
