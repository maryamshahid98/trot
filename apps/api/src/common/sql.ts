import type pg from 'pg';

/** What a service needs from its open transaction: run a query. Rows come back as pg gives them, with untyped columns. */
/** One row as pg returns it: columns by name, values untyped. Convert what you use (numbers arrive as strings, for example). */
export type Row = pg.QueryResultRow;

export type Tx = { query: (sql: string, params?: unknown[]) => Promise<{ rows: pg.QueryResultRow[]; rowCount: number | null }> };

/** SQL that turns a timestamp expression into epoch milliseconds, the unit the rules code uses. Only pass literal column expressions. */
export const epochMs = (expr: string) => `(extract(epoch from ${expr}) * 1000)::bigint`;

/** The horses of one session: those assigned to it, and any recorded as actually ridden in a lesson record. Null when there are none. */
export const sessionHorses = (occurrenceId: string) => `(SELECT string_agg(n.name, ', ' ORDER BY n.name) FROM (
  SELECT h.name FROM horse_assignments x JOIN horses h ON h.id = x.horse_id WHERE x.occurrence_id = ${occurrenceId}
  UNION SELECT h.name FROM bookings k JOIN horses h ON h.id = k.actual_horse_id WHERE k.occurrence_id = ${occurrenceId} AND k.status <> 'cancelled') n)`;

/** "Same day" for a branch means the day on that branch's own clock, not UTC. */
export function dayKeyFor(timeZone: string): (ms: number) => string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (ms) => f.format(new Date(ms));
}
