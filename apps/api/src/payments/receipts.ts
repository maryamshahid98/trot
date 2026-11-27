import { RECEIPT_PREFIX, VAT_PERCENT } from '../config/constants.ts';
import type { Tx } from '../bookings/core.ts';

/** The part of a VAT-inclusive price that is VAT, in halalas. */
export const vatOf = (amountMinor: number) => Math.round((amountMinor * VAT_PERCENT) / (100 + VAT_PERCENT));

/** Issues a receipt inside the caller's transaction, so a sale and its receipt succeed or fail together. */
export async function issueReceipt(
  c: Tx,
  p: { branchId: string; riderId: string; amountMinor: number; method: string; bookingId?: string; packageId?: string; userId: string; terminalRef?: string },
): Promise<{ id: string; number: string; vatMinor: number }> {
  const guardian = (await c.query(`SELECT guardian_account_id AS id FROM guardian_riders WHERE rider_id = $1 ORDER BY guardian_account_id LIMIT 1`, [p.riderId])).rows[0]?.id ?? null;
  const vat = vatOf(p.amountMinor);
  const row = (
    await c.query(
      `INSERT INTO receipts (branch_id, number, rider_id, guardian_account_id, amount_minor, vat_minor, method, for_booking_id, for_rider_package_id, issued_by, terminal_ref)
       VALUES ($1, $2 || nextval('receipt_number_seq')::text, $3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, number`,
      [p.branchId, RECEIPT_PREFIX, p.riderId, guardian, p.amountMinor, vat, p.method, p.bookingId ?? null, p.packageId ?? null, p.userId, p.terminalRef ?? null],
    )
  ).rows[0];
  return { id: row.id, number: row.number, vatMinor: vat };
}
