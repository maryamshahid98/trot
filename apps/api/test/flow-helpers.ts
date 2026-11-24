// Shared builders for the attendance and waitlist tests. Setup writes straight to the database, so it never depends on the code under test.
import { api, BRANCH, ctx, makeAccount, tokenFor } from './helpers.ts';
import { readyRider } from './booking-helpers.ts';

export const MIN = 60_000;

export async function customer(opts: { branchId?: string } = {}) {
  const acct = await makeAccount({ role: 'customer', branchIds: [opts.branchId ?? BRANCH] });
  return { ...acct, token: await tokenFor(acct), riderId: await readyRider({ accountId: acct.id, branchId: opts.branchId }) };
}
export async function staff(role = 'reception', branchIds = [BRANCH]) {
  const acct = await makeAccount({ role, branchIds });
  return { ...acct, token: await tokenFor(acct) };
}

/** A booking written directly, for situations the API refuses to create (a class that has already started, a lapsed hold). */
export async function directBooking(o: { occurrenceId: string; riderId: string; status?: string; payWith?: 'package' | 'office'; packageId?: string; holdExpiresInMin?: number; branchId?: string }): Promise<string> {
  const status = o.status ?? 'confirmed';
  const payWith = o.payWith ?? (o.packageId ? 'package' : 'office');
  const hold = o.holdExpiresInMin === undefined ? null : new Date(Date.now() + o.holdExpiresInMin * MIN).toISOString();
  const created = o.holdExpiresInMin !== undefined && o.holdExpiresInMin < 0 ? new Date(Date.now() - 60 * MIN).toISOString() : new Date().toISOString();
  const id: string = (
    await ctx.admin.query(
      `INSERT INTO bookings (branch_id, occurrence_id, rider_id, status, pay_with, rider_package_id, hold_expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [o.branchId ?? BRANCH, o.occurrenceId, o.riderId, status, payWith, o.packageId ?? null, hold, created],
    )
  ).rows[0].id;
  if (payWith === 'package' && o.packageId && status !== 'cancelled') {
    await ctx.admin.query(`INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key, booking_id) VALUES ($1,-1,'use',$2,$3)`, [o.packageId, `use:${id}`, id]);
  }
  return id;
}

export const statusOf = async (bookingId: string): Promise<string> => (await ctx.admin.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId])).rows[0].status;
export const post = (path: string, token: string | undefined, body: unknown = {}) => api('POST', path, { token, body });
export const entryStatus = async (id: string): Promise<string> => (await ctx.admin.query(`SELECT status FROM waitlist_entries WHERE id = $1`, [id])).rows[0].status;
export const waitlistEntryFor = async (occurrenceId: string, riderId: string): Promise<string> =>
  (await ctx.admin.query(`SELECT id FROM waitlist_entries WHERE occurrence_id = $1 AND rider_id = $2 ORDER BY joined_at DESC LIMIT 1`, [occurrenceId, riderId])).rows[0].id;
export const auditActions = async (entityId: string): Promise<string[]> =>
  (await ctx.admin.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [entityId])).rows.map((r: any) => r.action);
