import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser } from '../auth/decorators.ts';
import { OWNS_RIDER } from '../common/audit.ts';
import { parse } from '../common/validate.ts';
import { ROLE, UUID_RE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';

const uuid = z.string().regex(UUID_RE, 'must be an id');
const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');
const STATUSES = ['issued', 'paid', 'voided', 'credited'] as const;
const IdParam = z.object({ id: uuid });
const ListQuery = z.object({
  branchId: uuid.optional(),
  status: z.enum(STATUSES).optional(),
  riderId: uuid.optional(),
  number: z.string().trim().min(1).max(30).optional(),
  from: isoTime.optional(),
  to: isoTime.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
const AccountQuery = z.object({ from: isoTime.optional(), to: isoTime.optional() });

const COLS = `i.id, i.number, i.status, i.rider_id AS "riderId", r.full_name AS "riderName", i.currency, i.gross_minor AS "grossMinor", i.vat_minor AS "vatMinor",
  i.vat_percent::float AS "vatPercent", i.issued_at AS "issuedAt", i.paid_at AS "paidAt", i.voided_at AS "voidedAt", rc.number AS "receiptNumber",
  (SELECT l.description FROM invoice_lines l WHERE l.invoice_id = i.id ORDER BY l.id LIMIT 1) AS description`;
const FROM = `FROM invoices i JOIN riders r ON r.id = i.rider_id LEFT JOIN receipts rc ON rc.id = i.receipt_id`;

@Injectable()
export class InvoicesService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private branchFor(requested: string | undefined, user: AuthUser): string {
    if (requested) {
      if (!user.branchIds.includes(requested)) throw new NotFoundException('Branch not found.');
      return requested;
    }
    if (user.branchIds.length === 1) return user.branchIds[0];
    throw new BadRequestException({ message: 'branchId is required.', problems: [{ field: 'branchId', message: 'is required for people who work in more than one branch' }] });
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListQuery, query);
    const branchId = this.branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const rows = (
        await c.query(
          `SELECT ${COLS}, count(*) OVER ()::int AS total ${FROM}
            WHERE i.branch_id = $1 AND ($2::text IS NULL OR i.status = $2) AND ($3::uuid IS NULL OR i.rider_id = $3)
              AND ($4::text IS NULL OR i.number ILIKE $4 || '%') AND ($5::timestamptz IS NULL OR i.issued_at >= $5) AND ($6::timestamptz IS NULL OR i.issued_at < $6)
            ORDER BY i.issued_at DESC, i.number DESC LIMIT $7 OFFSET $8`,
          [branchId, q.status ?? null, q.riderId ?? null, q.number ?? null, q.from ?? null, q.to ?? null, q.limit, q.offset],
        )
      ).rows;
      return { total: rows[0]?.total ?? 0, invoices: rows.map(({ total: _total, ...r }) => r) };
    });
  }

  /** The invoices of the riders this customer looks after. */
  async mine(user: AuthUser) {
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => ({
      invoices: (await c.query(`SELECT ${COLS} ${FROM} WHERE ${OWNS_RIDER('r', '$1')} AND i.status <> 'voided' ORDER BY i.issued_at DESC LIMIT 200`, [user.id])).rows,
    }));
  }

  /** One invoice with its lines, its credit notes and the receipt that paid it. Staff of the branch, or the family it is addressed to. */
  async get(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const family = user.role === ROLE.CUSTOMER;
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const inv = (
        await c.query(
          `SELECT ${COLS}, br.name AS "branchName", pa.full_name AS "payerName" ${FROM} JOIN branches br ON br.id = i.branch_id LEFT JOIN accounts pa ON pa.id = i.payer_account_id
            WHERE i.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')})`,
          [id, family, user.id],
        )
      ).rows[0];
      if (!inv) throw new NotFoundException('Invoice not found.');
      const lines = (await c.query(`SELECT description, quantity, total_minor AS "totalMinor", vat_minor AS "vatMinor" FROM invoice_lines WHERE invoice_id = $1 ORDER BY id`, [id])).rows;
      const creditNotes = (await c.query(`SELECT id, number, amount_minor AS "amountMinor", vat_minor AS "vatMinor", reason, issued_at AS "issuedAt" FROM credit_notes WHERE invoice_id = $1 ORDER BY issued_at`, [id])).rows;
      return { ...inv, lines, creditNotes };
    });
  }

  /**
   * A rider's account for a period (BRD PAY-006, PAY-007): what was charged, what was paid, what was credited or refunded, and the balance after each line.
   * A positive balance is what the family owes; a negative one is a credit the club owes them. It is worked out from the records, never stored or edited (PAY-009).
   */
  async account(rawId: string, query: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const q = parse(AccountQuery, query);
    const family = user.role === ROLE.CUSTOMER;
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const rider = (
        await c.query(`SELECT r.id, r.full_name AS "fullName", br.currency FROM riders r JOIN branches br ON br.id = r.branch_id WHERE r.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')})`, [id, family, user.id])
      ).rows[0];
      if (!rider) throw new NotFoundException('Rider not found.');
      const all = (
        await c.query(
          `SELECT * FROM (
             SELECT i.issued_at AS at, 'invoice' AS type, i.number, coalesce((SELECT l.description FROM invoice_lines l WHERE l.invoice_id = i.id ORDER BY l.id LIMIT 1), 'Invoice') AS description,
                    i.gross_minor AS debit, 0 AS credit
               FROM invoices i WHERE i.rider_id = $1 AND i.status <> 'voided'
             UNION ALL
             SELECT rc.issued_at, 'receipt', rc.number, 'Payment received (' || replace(rc.method, '_', ' ') || ')', 0, rc.amount_minor
               FROM receipts rc WHERE rc.id IN (SELECT receipt_id FROM invoices WHERE rider_id = $1 AND receipt_id IS NOT NULL)
             UNION ALL
             SELECT cn.issued_at, 'credit_note', cn.number, 'Credit note: ' || cn.reason, 0, cn.amount_minor
               FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id WHERE i.rider_id = $1
             UNION ALL
             SELECT fa.created_at, 'refund_paid', 'refund', 'Refund paid back: ' || fa.reason, fa.amount_minor, 0
               FROM financial_adjustments fa WHERE fa.kind = 'refund' AND fa.receipt_id IN (SELECT receipt_id FROM invoices WHERE rider_id = $1 AND receipt_id IS NOT NULL)
           ) x ORDER BY at, type, number LIMIT 1000`,
          [id],
        )
      ).rows;
      const from = q.from ? Date.parse(q.from) : -Infinity;
      const to = q.to ? Date.parse(q.to) : Infinity;
      let balance = 0;
      let opening = 0;
      const entries: { at: string; type: string; number: string; description: string; debitMinor: number; creditMinor: number; balanceMinor: number }[] = [];
      for (const e of all) {
        const t = new Date(e.at).getTime();
        balance += Number(e.debit) - Number(e.credit);
        if (t < from) { opening = balance; continue; }
        if (t >= to) continue;
        entries.push({ at: new Date(e.at).toISOString(), type: e.type, number: e.number, description: e.description, debitMinor: Number(e.debit), creditMinor: Number(e.credit), balanceMinor: balance });
      }
      const owing = (await c.query(`SELECT coalesce(sum(gross_minor), 0)::int AS n FROM invoices WHERE rider_id = $1 AND status = 'issued'`, [id])).rows[0].n as number;
      return { riderId: id, riderName: rider.fullName, currency: rider.currency, openingBalanceMinor: opening, entries, balanceMinor: balance, unpaidInvoicesMinor: owing };
    });
  }
}
