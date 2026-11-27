// Issuing invoices and credit notes. Plain functions over the caller's transaction, like receipts: the sale, the invoice and the receipt
// succeed or fail together. What the database guarantees on top (money never edited, status only forward, credit notes never above
// the invoice, an unpaid invoice voided when its booking is cancelled) lives in migration 0014.
import { writeAudit } from '../common/audit.ts';
import type { Tx } from '../common/sql.ts';
import { AUDIT, CREDIT_NOTE_PREFIX, ENTITY, INVOICE_PREFIX, VAT_PERCENT } from '../config/constants.ts';
import { vatOf } from './receipts.ts';

/** The person the invoice is addressed to: the rider's first guardian, or the rider's own account. */
async function payerOf(c: Tx, riderId: string): Promise<string | null> {
  const g = (await c.query(`SELECT guardian_account_id AS id FROM guardian_riders WHERE rider_id = $1 ORDER BY is_billing DESC, is_primary DESC, guardian_account_id LIMIT 1`, [riderId])).rows[0]?.id as string | undefined;
  if (g) return g;
  return ((await c.query(`SELECT account_id AS id FROM riders WHERE id = $1`, [riderId])).rows[0]?.id as string | null | undefined) ?? null;
}

async function insertInvoice(
  c: Tx,
  p: { branchId: string; riderId: string; bookingId?: string; packageId?: string; description: string; grossMinor: number; currency: string; status: 'issued' | 'paid'; receiptId?: string; userId: string | null },
): Promise<{ id: string; number: string; vatMinor: number }> {
  const vat = vatOf(p.grossMinor);
  const payer = await payerOf(c, p.riderId);
  const row = (
    await c.query(
      `INSERT INTO invoices (branch_id, number, rider_id, payer_account_id, booking_id, rider_package_id, status, currency, gross_minor, vat_minor, vat_percent, receipt_id, issued_by, paid_at)
       VALUES ($1, $2 || nextval('invoice_number_seq')::text, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $7 = 'paid' THEN now() END) RETURNING id, number`,
      [p.branchId, INVOICE_PREFIX, p.riderId, payer, p.bookingId ?? null, p.packageId ?? null, p.status, p.currency, p.grossMinor, vat, VAT_PERCENT, p.receiptId ?? null, p.userId],
    )
  ).rows[0];
  await c.query(`INSERT INTO invoice_lines (invoice_id, description, quantity, total_minor, vat_minor) VALUES ($1,$2,1,$3,$4)`, [row.id, p.description, p.grossMinor, vat]);
  await writeAudit(c, p.userId ? { id: p.userId } : null, p.branchId, AUDIT.INVOICE_ISSUE, ENTITY.INVOICE, row.id, { number: row.number, grossMinor: p.grossMinor, status: p.status, bookingId: p.bookingId ?? null, packageId: p.packageId ?? null });
  return { id: row.id as string, number: row.number as string, vatMinor: vat };
}

/**
 * The invoice for a booking that has to be paid for, created if it does not exist yet (so a booking made before invoices existed still gets one
 * when it is paid). A booking with nothing to pay (a free class) has no invoice, and a package booking has none either: the package was invoiced when sold.
 */
export async function ensureBookingInvoice(c: Tx, bookingId: string, userId: string | null): Promise<{ id: string; number: string } | null> {
  const existing = (await c.query(`SELECT id, number FROM invoices WHERE booking_id = $1`, [bookingId])).rows[0];
  if (existing) return { id: existing.id as string, number: existing.number as string };
  const b = (
    await c.query(
      `SELECT b.branch_id AS "branchId", b.rider_id AS "riderId", o.title, o.price_minor AS "priceMinor", lower(o.during) AS "startsAt", br.currency, br.time_zone AS "timeZone"
         FROM bookings b JOIN occurrences o ON o.id = b.occurrence_id JOIN branches br ON br.id = b.branch_id WHERE b.id = $1`,
      [bookingId],
    )
  ).rows[0];
  if (!b || (b.priceMinor as number) <= 0) return null;
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: b.timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(b.startsAt));
  const inv = await insertInvoice(c, { branchId: b.branchId, riderId: b.riderId, bookingId, description: `${b.title} · ${when}`, grossMinor: b.priceMinor, currency: b.currency, status: 'issued', userId });
  return { id: inv.id, number: inv.number };
}

/** The payment arrived: the invoice is paid, and says by which receipt. */
export async function markInvoicePaid(c: Tx, invoiceId: string, receiptId: string): Promise<void> {
  await c.query(`UPDATE invoices SET status = 'paid', paid_at = now(), receipt_id = $2 WHERE id = $1 AND status = 'issued'`, [invoiceId, receiptId]);
}

/** A package is paid for when it is sold, so its invoice is issued already paid. */
export async function issuePackageInvoice(c: Tx, p: { branchId: string; riderId: string; packageId: string; description: string; grossMinor: number; receiptId: string; userId: string }): Promise<{ id: string; number: string }> {
  const currency = (await c.query(`SELECT currency FROM branches WHERE id = $1`, [p.branchId])).rows[0].currency as string;
  const inv = await insertInvoice(c, { ...p, currency, status: 'paid' });
  return { id: inv.id, number: inv.number };
}

/**
 * A refund or a credit given against a receipt is also a credit note against the invoice that receipt paid, so the customer's account
 * and the tax figures stay right. A receipt that has no invoice (issued before invoices existed) gets no credit note.
 * When the credit notes add up to the whole invoice, the invoice becomes "credited".
 */
export async function issueCreditNote(c: Tx, p: { receiptId: string; adjustmentId: string; amountMinor: number; reason: string; userId: string }): Promise<{ id: string; number: string } | null> {
  const inv = (await c.query(`SELECT id, branch_id AS "branchId", gross_minor AS "grossMinor" FROM invoices WHERE receipt_id = $1`, [p.receiptId])).rows[0];
  if (!inv) return null;
  // A credit note can only reduce what the invoice charged. A goodwill credit larger than that (or a refund after earlier credits) is credited
  // here only up to what is left on the invoice; the rest is simply a credit on the family's account and has no tax effect.
  const soFar = (await c.query(`SELECT coalesce(sum(amount_minor), 0)::int AS n FROM credit_notes WHERE invoice_id = $1`, [inv.id])).rows[0].n as number;
  const amountMinor = Math.min(p.amountMinor, (inv.grossMinor as number) - soFar);
  if (amountMinor <= 0) return null;
  const note = (
    await c.query(
      `INSERT INTO credit_notes (branch_id, number, invoice_id, adjustment_id, amount_minor, vat_minor, reason, issued_by)
       VALUES ($1, $2 || nextval('credit_note_number_seq')::text, $3,$4,$5,$6,$7,$8) RETURNING id, number`,
      [inv.branchId, CREDIT_NOTE_PREFIX, inv.id, p.adjustmentId, amountMinor, vatOf(amountMinor), p.reason, p.userId],
    )
  ).rows[0];
  const credited = (await c.query(`SELECT coalesce(sum(amount_minor), 0)::int AS n FROM credit_notes WHERE invoice_id = $1`, [inv.id])).rows[0].n as number;
  if (credited >= (inv.grossMinor as number)) await c.query(`UPDATE invoices SET status = 'credited' WHERE id = $1 AND status = 'paid'`, [inv.id]);
  await writeAudit(c, { id: p.userId }, inv.branchId, AUDIT.CREDIT_NOTE_ISSUE, ENTITY.CREDIT_NOTE, note.id, { number: note.number, invoiceId: inv.id, amountMinor });
  return { id: note.id as string, number: note.number as string };
}
