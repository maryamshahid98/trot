import type { AuthUser } from '../auth/decorators.ts';

/** Writes one audit row inside the caller's transaction, so the action and its record succeed or fail together. */
export async function writeAudit(c: { query: (sql: string, params: unknown[]) => Promise<unknown> }, user: Pick<AuthUser, 'id'> | null, branchId: string, action: string, entity: string, entityId: string, detail: object) {
  await c.query(`INSERT INTO audit_log (actor_account_id, branch_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)`, [
    user?.id ?? null, branchId, action, entity, entityId, JSON.stringify(detail), // no user = the system did it (for example an offer that timed out)
  ]);
}

/** SQL: this rider belongs to the signed-in customer (their own profile, or a ward they guard). */
export const OWNS_RIDER = (rider: string, acct: string) =>
  `(${rider}.account_id = ${acct} OR EXISTS (SELECT 1 FROM guardian_riders g WHERE g.rider_id = ${rider}.id AND g.guardian_account_id = ${acct}))`;
