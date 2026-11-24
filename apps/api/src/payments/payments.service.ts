import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { canConfirmUnpaid } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { lockOccurrence } from '../bookings/core.ts';
import { OWNS_RIDER, writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { loadPolicy } from '../common/policy.ts';
import { parse } from '../common/validate.ts';
import { ADJUSTMENT_KIND, AUDIT, BOOKING_STATUS, ENTITY, PAYMENT_PROBLEM, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { queueForRider } from '../notifications/outbox.ts';
import { ConfirmUnpaid, CreateAdjustment, IdParam, ListReceipts, RecordPayment } from './payments.schemas.ts';
import { ensureBookingInvoice, issueCreditNote, markInvoicePaid } from './invoices.ts';
import { issueReceipt } from './receipts.ts';
import type { Row, Tx } from '../common/sql.ts';

const problem = (message: string, code: string, extra: object = {}) => ({ message, problems: [{ code, message }], ...extra });
const RECEIPT_COLS = `r.id, r.number, r.amount_minor AS "amountMinor", r.vat_minor AS "vatMinor", r.method, r.issued_at AS "issuedAt",
  r.rider_id AS "riderId", rd.full_name AS "riderName", r.for_booking_id AS "forBookingId", r.for_rider_package_id AS "forPackageId", r.issued_by AS "issuedBy"`;

@Injectable()
export class PaymentsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Loads a booking and locks its class first, the same order every other booking action uses. */
  private async lockBooking(c: Tx, id: string) {
    const pre = (await c.query(`SELECT occurrence_id AS "occurrenceId" FROM bookings WHERE id = $1`, [id])).rows[0];
    if (!pre) throw new NotFoundException('Booking not found.');
    const occ = (await lockOccurrence(c, pre.occurrenceId))!;
    const b = (
      await c.query(
        `SELECT id, branch_id AS "branchId", rider_id AS "riderId", status, hold_expires_at AS "holdExpiresAt", occurrence_id AS "occurrenceId" FROM bookings WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    return { b, occ };
  }

  private mustBePending(b: Row, now: number) {
    if (b.status === BOOKING_STATUS.CONFIRMED || b.status === BOOKING_STATUS.CHECKED_IN || b.status === BOOKING_STATUS.COMPLETED) {
      return problem('This booking is already paid.', PAYMENT_PROBLEM.ALREADY_PAID);
    }
    if (b.status !== BOOKING_STATUS.PENDING_OFFICE_PAYMENT) return problem('This booking is not waiting for payment.', PAYMENT_PROBLEM.NOT_PENDING_PAYMENT);
    if (b.holdExpiresAt && Date.parse(b.holdExpiresAt) <= now) return problem('The hold on this place has run out. Book again.', PAYMENT_PROBLEM.HOLD_EXPIRED);
    return null;
  }

  /** The rider paid at the desk: record the payment, issue the receipt, confirm the booking. */
  async recordPayment(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(RecordPayment, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { b: booking, occ } = await this.lockBooking(c, id);
      const bad = this.mustBePending(booking, Date.now());
      if (bad) throw new ConflictException(bad);
      const price = occ.priceMinor as number;
      if (b.amountMinor !== price) throw new UnprocessableEntityException(problem(`The class costs ${price} halalas.`, PAYMENT_PROBLEM.AMOUNT_MISMATCH));
      // A free class has nothing to receipt.
      const receipt = price > 0 ? await issueReceipt(c, { branchId: booking.branchId, riderId: booking.riderId, amountMinor: price, method: b.method, bookingId: id, userId: user.id }) : null;
      await c.query(`UPDATE bookings SET status = $2, hold_expires_at = NULL WHERE id = $1`, [id, BOOKING_STATUS.CONFIRMED]);
      if (receipt) {
        const invoice = await ensureBookingInvoice(c, id, user.id);
        if (invoice) await markInvoicePaid(c, invoice.id, receipt.id);
      }
      await queueForRider(c, booking.riderId, {
        event: receipt ? 'payment.received' : 'booking.confirmed', branchId: booking.branchId, occurrenceId: booking.occurrenceId,
        dedupeKey: `booking:${id}:paid`, data: { receiptNumber: receipt?.number ?? null, amountMinor: price },
      });
      await writeAudit(c, user, booking.branchId, AUDIT.PAYMENT_RECORD, ENTITY.BOOKING, id, { amountMinor: price, method: b.method, receipt: receipt?.number ?? null });
      return { id, status: BOOKING_STATUS.CONFIRMED, receipt };
    });
  }

  /** A manager lets a rider ride before paying (OD-14). It is recorded with a reason, so unpaid classes can be chased. */
  async confirmUnpaid(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { reason } = parse(ConfirmUnpaid, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { b: booking } = await this.lockBooking(c, id);
      if (!canConfirmUnpaid(user.role as 'reception' | 'manager' | 'owner', await loadPolicy(c, booking.branchId))) {
        throw new ForbiddenException(problem('Only a manager can confirm an unpaid booking, and only where the club allows it.', PAYMENT_PROBLEM.UNPAID_NOT_ALLOWED));
      }
      const bad = this.mustBePending(booking, Date.now());
      if (bad) throw new ConflictException(bad);
      await c.query(`UPDATE bookings SET status = $2, hold_expires_at = NULL WHERE id = $1`, [id, BOOKING_STATUS.CONFIRMED]);
      await writeAudit(c, user, booking.branchId, AUDIT.BOOKING_CONFIRM_UNPAID, ENTITY.BOOKING, id, { reason });
      return { id, status: BOOKING_STATUS.CONFIRMED, paid: false };
    });
  }

  async listReceipts(query: unknown, user: AuthUser) {
    const q = parse(ListReceipts, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const rows = (
        await c.query(
          `SELECT ${RECEIPT_COLS}, count(*) OVER ()::int AS total FROM receipts r LEFT JOIN riders rd ON rd.id = r.rider_id
            WHERE r.branch_id = $1 AND ($2::uuid IS NULL OR r.rider_id = $2) AND ($3::text IS NULL OR r.method = $3)
              AND ($4::timestamptz IS NULL OR r.issued_at >= $4) AND ($5::timestamptz IS NULL OR r.issued_at < $5)
            ORDER BY r.issued_at DESC, r.id LIMIT $6 OFFSET $7`,
          [branchId, q.riderId ?? null, q.method ?? null, q.from ?? null, q.to ?? null, q.limit, q.offset],
        )
      ).rows;
      return { total: rows[0]?.total ?? 0, receipts: rows.map(({ total: _total, ...r }) => r) };
    });
  }

  async mine(user: AuthUser) {
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => ({
      receipts: (
        await c.query(`SELECT ${RECEIPT_COLS} FROM receipts r JOIN riders rd ON rd.id = r.rider_id WHERE ${OWNS_RIDER('rd', '$1')} ORDER BY r.issued_at DESC LIMIT 200`, [user.id])
      ).rows,
    }));
  }

  async getReceipt(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = (
        await c.query(`SELECT ${RECEIPT_COLS} FROM receipts r LEFT JOIN riders rd ON rd.id = r.rider_id WHERE r.id = $1 AND ($2::boolean = false OR (rd.id IS NOT NULL AND ${OWNS_RIDER('rd', '$3')}))`, [id, user.role === ROLE.CUSTOMER, user.id])
      ).rows[0];
      if (!r) throw new NotFoundException('Receipt not found.');
      const adjustments =
        user.role === ROLE.CUSTOMER
          ? []
          : (await c.query(`SELECT id, kind, amount_minor AS "amountMinor", reason, requested_by AS "requestedBy", approved_by AS "approvedBy", created_at AS "createdAt" FROM financial_adjustments WHERE receipt_id = $1 ORDER BY created_at`, [id])).rows;
      return { ...r, adjustments };
    });
  }

  /** A mistake is fixed with a new adjustment, never by editing the receipt. Reception may handle small ones; a manager approves large ones. */
  async adjust(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(CreateAdjustment, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = (await c.query(`SELECT id, branch_id AS "branchId", rider_id AS "riderId", amount_minor AS "amountMinor" FROM receipts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw new NotFoundException('Receipt not found.');
      // A correction can go either way; everything else is an amount of money and must be positive.
      if (b.kind !== ADJUSTMENT_KIND.CORRECTION && b.amountMinor < 0) {
        throw new UnprocessableEntityException(problem('Enter the amount as a positive number.', PAYMENT_PROBLEM.AMOUNT_MISMATCH));
      }
      const isManager = user.role === ROLE.MANAGER || user.role === ROLE.OWNER;
      if (!isManager && Math.abs(b.amountMinor) > (await loadPolicy(c, r.branchId)).adjustmentManagerThresholdMinor) {
        throw new ForbiddenException(problem('An adjustment this large needs a manager.', PAYMENT_PROBLEM.NEEDS_MANAGER));
      }
      if (b.kind === ADJUSTMENT_KIND.REFUND) {
        // The receipt row is locked above, so two refunds on it are decided one after the other and the total can never exceed what was paid.
        const done = (await c.query(`SELECT coalesce(sum(amount_minor),0)::int AS n FROM financial_adjustments WHERE receipt_id = $1 AND kind = $2`, [id, ADJUSTMENT_KIND.REFUND])).rows[0].n as number;
        if (done + b.amountMinor > r.amountMinor) {
          throw new UnprocessableEntityException(problem(`Only ${r.amountMinor - done} halalas can still be refunded on this receipt.`, PAYMENT_PROBLEM.OVER_REFUND));
        }
      }
      const adj = (
        await c.query(
          `INSERT INTO financial_adjustments (branch_id, receipt_id, rider_id, kind, amount_minor, reason, requested_by, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [r.branchId, id, r.riderId, b.kind, b.amountMinor, b.reason, user.id, isManager ? user.id : null],
        )
      ).rows[0];
      // A refund or a credit is also a credit note against the invoice that receipt paid.
      if (b.kind === ADJUSTMENT_KIND.REFUND || b.kind === ADJUSTMENT_KIND.CREDIT) await issueCreditNote(c, { receiptId: id, adjustmentId: adj.id, amountMinor: b.amountMinor, reason: b.reason, userId: user.id });
      await writeAudit(c, user, r.branchId, AUDIT.ADJUSTMENT_CREATE, ENTITY.ADJUSTMENT, adj.id, { receiptId: id, kind: b.kind, amountMinor: b.amountMinor, reason: b.reason });
      return { id: adj.id as string, approved: isManager };
    });
  }
}
