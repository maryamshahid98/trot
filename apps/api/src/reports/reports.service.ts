import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { MS } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { branchFor } from '../common/branch.ts';
import { epochMs } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import { ADJUSTMENT_KIND, AUDIT, BOOKING_STATUS, LIMITS, OCCURRENCE_STATUS, REPORT_PROBLEM, RIDE_FORMAT } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { AuditQuery, RangeQuery, UnpaidQuery } from './reports.schemas.ts';

const problem = (message: string, code: string, field = 'to') => ({ message, problems: [{ code, field, message }] });
const iso = (ms: number) => new Date(ms).toISOString();

@Injectable()
export class ReportsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private range(q: { from: string; to: string }) {
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (to <= from) throw new BadRequestException(problem('The end must be after the start.', REPORT_PROBLEM.BAD_RANGE));
    if (to - from > LIMITS.reportMaxDays * MS.day) throw new BadRequestException(problem(`A report may cover at most ${LIMITS.reportMaxDays} days.`, REPORT_PROBLEM.RANGE_TOO_LONG));
    return { from: iso(from), to: iso(to) };
  }

  /** Money taken, split by method and by day (on the branch's own clock), less refunds. Receipts are never edited, so this never drifts. */
  async revenue(query: unknown, user: AuthUser) {
    const q = parse(RangeQuery, query);
    const { from, to } = this.range(q);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const tz = (await c.query(`SELECT time_zone FROM branches WHERE id = $1`, [branchId])).rows[0].time_zone as string;
      const w = `branch_id = $1 AND issued_at >= $2::timestamptz AND issued_at < $3::timestamptz`;
      const total = (await c.query(`SELECT count(*)::int AS n, coalesce(sum(amount_minor),0)::bigint AS gross, coalesce(sum(vat_minor),0)::bigint AS vat FROM receipts WHERE ${w}`, [branchId, from, to])).rows[0];
      const byMethod = (await c.query(`SELECT method, count(*)::int AS receipts, sum(amount_minor)::bigint AS "amountMinor" FROM receipts WHERE ${w} GROUP BY method ORDER BY method`, [branchId, from, to])).rows;
      const byDay = (await c.query(`SELECT to_char(issued_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, sum(amount_minor)::bigint AS "amountMinor" FROM receipts WHERE ${w} GROUP BY 1 ORDER BY 1`, [branchId, from, to, tz])).rows;
      const adj = (
        await c.query(`SELECT kind, count(*)::int AS n, sum(amount_minor)::bigint AS total FROM financial_adjustments WHERE branch_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz GROUP BY kind`, [branchId, from, to])
      ).rows;
      const adjusted = (kind: string) => Number(adj.find((a: any) => a.kind === kind)?.total ?? 0);
      const grossMinor = Number(total.gross);
      return {
        from, to, timeZone: tz,
        receipts: total.n, grossMinor, vatMinor: Number(total.vat),
        refundsMinor: adjusted(ADJUSTMENT_KIND.REFUND),
        netMinor: grossMinor - adjusted(ADJUSTMENT_KIND.REFUND),
        otherAdjustments: { creditMinor: adjusted(ADJUSTMENT_KIND.CREDIT), writeOffMinor: adjusted(ADJUSTMENT_KIND.WRITE_OFF), correctionMinor: adjusted(ADJUSTMENT_KIND.CORRECTION) },
        byMethod: byMethod.map((r: any) => ({ ...r, amountMinor: Number(r.amountMinor) })),
        byDay: byDay.map((r: any) => ({ ...r, amountMinor: Number(r.amountMinor) })),
      };
    });
  }

  /** Who came and who did not, for classes that finished in the range. */
  async attendance(query: unknown, user: AuthUser) {
    const q = parse(RangeQuery, query);
    const { from, to } = this.range(q);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const base = `FROM occurrences o LEFT JOIN bookings b ON b.occurrence_id = o.id WHERE o.branch_id = $1 AND o.status = $4 AND lower(o.during) >= $2::timestamptz AND lower(o.during) < $3::timestamptz`;
      const args = [branchId, from, to, OCCURRENCE_STATUS.COMPLETED];
      const counts = (await c.query(`SELECT count(DISTINCT o.id)::int AS classes, count(*) FILTER (WHERE b.status = $5)::int AS attended, count(*) FILTER (WHERE b.status = $6)::int AS "noShows", count(*) FILTER (WHERE b.status = $7)::int AS cancelled ${base}`, [...args, BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW, BOOKING_STATUS.CANCELLED])).rows[0];
      const perCoach = (
        await c.query(
          `SELECT o.coach_id AS "coachId", a.full_name AS "coachName", count(DISTINCT o.id)::int AS classes, count(*) FILTER (WHERE b.status = $5)::int AS attended, count(*) FILTER (WHERE b.status = $6)::int AS "noShows"
             ${base.replace('LEFT JOIN bookings b', 'JOIN accounts a ON a.id = o.coach_id LEFT JOIN bookings b')} GROUP BY o.coach_id, a.full_name ORDER BY a.full_name`,
          [...args, BOOKING_STATUS.COMPLETED, BOOKING_STATUS.NO_SHOW],
        )
      ).rows;
      const expected = counts.attended + counts.noShows;
      return { from, to, ...counts, attendanceRate: expected === 0 ? null : Math.round((counts.attended / expected) * 1000) / 1000, perCoach };
    });
  }

  /** How full the classes were, by arena. Cancelled and draft classes are left out. */
  async utilisation(query: unknown, user: AuthUser) {
    const q = parse(RangeQuery, query);
    const { from, to } = this.range(q);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const rows = (
        await c.query(
          `SELECT a.id AS "arenaId", a.name AS "arenaName", count(*)::int AS classes, sum(o.capacity)::int AS places,
                  sum((SELECT count(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status = ANY($5::booking_status[])))::int AS filled
             FROM occurrences o JOIN arenas a ON a.id = o.arena_id
            WHERE o.branch_id = $1 AND o.status = ANY($4::occurrence_status[]) AND lower(o.during) >= $2::timestamptz AND lower(o.during) < $3::timestamptz
            GROUP BY a.id, a.name ORDER BY a.name`,
          [branchId, from, to, [OCCURRENCE_STATUS.PUBLISHED, OCCURRENCE_STATUS.IN_PROGRESS, OCCURRENCE_STATUS.COMPLETED],
           [BOOKING_STATUS.PENDING_OFFICE_PAYMENT, BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.COMPLETED]],
        )
      ).rows.map((r: any) => ({ ...r, utilisation: r.places === 0 ? null : Math.round((r.filled / r.places) * 1000) / 1000 }));
      const places = rows.reduce((s: number, r: any) => s + r.places, 0);
      const filled = rows.reduce((s: number, r: any) => s + r.filled, 0);
      return { from, to, classes: rows.reduce((s: number, r: any) => s + r.classes, 0), places, filled, utilisation: places === 0 ? null : Math.round((filled / places) * 1000) / 1000, byArena: rows };
    });
  }

  /**
   * Rides by ride type: how full they were, who did not turn up, and what was taken at the desk (BRD: ride schedule and occupancy, ride sales and revenue).
   * Places and bookings are counted by the day the ride runs; money by the day the receipt was issued.
   */
  async rides(query: unknown, user: AuthUser) {
    const q = parse(RangeQuery, query);
    const { from, to } = this.range(q);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const holding = [BOOKING_STATUS.PENDING_OFFICE_PAYMENT, BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.COMPLETED];
      const occupancy = (
        await c.query(
          `SELECT rt.id AS "rideTypeId", rt.name, count(*)::int AS rides, sum(o.capacity)::int AS places,
                  sum((SELECT count(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status = ANY($5::booking_status[])))::int AS booked,
                  sum((SELECT count(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status = $6))::int AS "noShows"
             FROM occurrences o JOIN ride_types rt ON rt.id = o.ride_type_id
            WHERE o.branch_id = $1 AND o.format = $7 AND o.status = ANY($4::occurrence_status[]) AND lower(o.during) >= $2::timestamptz AND lower(o.during) < $3::timestamptz
            GROUP BY rt.id, rt.name`,
          [branchId, from, to, [OCCURRENCE_STATUS.PUBLISHED, OCCURRENCE_STATUS.IN_PROGRESS, OCCURRENCE_STATUS.COMPLETED], holding, BOOKING_STATUS.NO_SHOW, RIDE_FORMAT],
        )
      ).rows;
      const cancelled = (
        await c.query(`SELECT count(*)::int AS n FROM occurrences WHERE branch_id = $1 AND format = $4 AND status = $5 AND lower(during) >= $2::timestamptz AND lower(during) < $3::timestamptz`, [branchId, from, to, RIDE_FORMAT, OCCURRENCE_STATUS.CANCELLED])
      ).rows[0].n as number;
      const sales = (
        await c.query(
          `SELECT rt.id AS "rideTypeId", rt.name, count(rc.id)::int AS receipts, sum(rc.amount_minor)::bigint AS gross, sum(rc.vat_minor)::bigint AS vat
             FROM receipts rc JOIN bookings b ON b.id = rc.for_booking_id JOIN occurrences o ON o.id = b.occurrence_id JOIN ride_types rt ON rt.id = o.ride_type_id
            WHERE rc.branch_id = $1 AND rc.issued_at >= $2::timestamptz AND rc.issued_at < $3::timestamptz
            GROUP BY rt.id, rt.name`,
          [branchId, from, to],
        )
      ).rows;
      const refunds = (
        await c.query(
          `SELECT rt.id AS "rideTypeId", sum(fa.amount_minor)::bigint AS refunds
             FROM financial_adjustments fa JOIN receipts rc ON rc.id = fa.receipt_id JOIN bookings b ON b.id = rc.for_booking_id
             JOIN occurrences o ON o.id = b.occurrence_id JOIN ride_types rt ON rt.id = o.ride_type_id
            WHERE fa.branch_id = $1 AND fa.kind = $4 AND fa.created_at >= $2::timestamptz AND fa.created_at < $3::timestamptz
            GROUP BY rt.id`,
          [branchId, from, to, ADJUSTMENT_KIND.REFUND],
        )
      ).rows;

      const byType = new Map<string, any>();
      const row = (id: string, name: string) => {
        if (!byType.has(id)) byType.set(id, { rideTypeId: id, name, rides: 0, places: 0, booked: 0, noShows: 0, receipts: 0, grossMinor: 0, vatMinor: 0, refundsMinor: 0 });
        return byType.get(id);
      };
      for (const o of occupancy) Object.assign(row(o.rideTypeId, o.name), { rides: o.rides, places: o.places, booked: o.booked, noShows: o.noShows });
      for (const s of sales) Object.assign(row(s.rideTypeId, s.name), { receipts: s.receipts, grossMinor: Number(s.gross), vatMinor: Number(s.vat) });
      for (const r of refunds) if (byType.has(r.rideTypeId)) byType.get(r.rideTypeId).refundsMinor = Number(r.refunds);
      const list = [...byType.values()]
        .map((t) => ({ ...t, utilisation: t.places === 0 ? null : Math.round((t.booked / t.places) * 1000) / 1000, netMinor: t.grossMinor - t.refundsMinor }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const sum = (k: string) => list.reduce((n, t) => n + (t as any)[k], 0);
      const places = sum('places');
      return {
        from, to,
        rides: sum('rides'), cancelledRides: cancelled, places, booked: sum('booked'), noShows: sum('noShows'),
        utilisation: places === 0 ? null : Math.round((sum('booked') / places) * 1000) / 1000,
        receipts: sum('receipts'), grossMinor: sum('grossMinor'), vatMinor: sum('vatMinor'), refundsMinor: sum('refundsMinor'), netMinor: sum('netMinor'),
        byType: list,
      };
    });
  }

  /** Riders who were let in without paying (a manager confirmed them), and have still not paid. */
  async unpaid(query: unknown, user: AuthUser) {
    const q = parse(UnpaidQuery, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const rows = (
        await c.query(
          `SELECT b.id AS "bookingId", b.status, r.id AS "riderId", r.full_name AS "riderName", o.id AS "occurrenceId", o.title, o.price_minor AS "priceMinor", ${epochMs('lower(o.during)')} AS "startsAt",
                  (SELECT al.detail->>'reason' FROM audit_log al WHERE al.entity_id = b.id::text AND al.action = $2 ORDER BY al.id DESC LIMIT 1) AS reason
             FROM bookings b JOIN riders r ON r.id = b.rider_id JOIN occurrences o ON o.id = b.occurrence_id
            WHERE b.branch_id = $1 AND b.pay_with = 'office' AND b.status = ANY($3::booking_status[])
              AND NOT EXISTS (SELECT 1 FROM receipts rc WHERE rc.for_booking_id = b.id)
            ORDER BY lower(o.during) LIMIT $4`,
          [branchId, AUDIT.BOOKING_CONFIRM_UNPAID, [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.COMPLETED], q.limit],
        )
      ).rows.map((r: any) => ({ ...r, startsAt: Number(r.startsAt) }));
      return { unpaid: rows, owedMinor: rows.reduce((s: number, r: any) => s + r.priceMinor, 0) };
    });
  }

  /** The audit trail. Only rows that belong to one of your branches; newest first; page with `before`. */
  async audit(query: unknown, user: AuthUser) {
    const q = parse(AuditQuery, query);
    if (q.branchId && !user.branchIds.includes(q.branchId)) throw new ForbiddenException('You do not work in that branch.');
    const branches = q.branchId ? [q.branchId] : user.branchIds;
    const rows = (
      await this.db.query(
        `SELECT l.id::text AS id, ${epochMs('l.at')} AS at, l.actor_account_id AS "actorId", a.full_name AS "actorName", l.branch_id AS "branchId", l.action, l.entity, l.entity_id AS "entityId", l.detail
           FROM audit_log l LEFT JOIN accounts a ON a.id = l.actor_account_id
          WHERE l.branch_id = ANY($1::uuid[]) AND ($2::text IS NULL OR l.action = $2) AND ($3::text IS NULL OR l.entity = $3) AND ($4::text IS NULL OR l.entity_id = $4)
            AND ($5::uuid IS NULL OR l.actor_account_id = $5) AND ($6::timestamptz IS NULL OR l.at >= $6) AND ($7::timestamptz IS NULL OR l.at < $7) AND ($8::bigint IS NULL OR l.id < $8)
          ORDER BY l.id DESC LIMIT $9`,
        [branches, q.action ?? null, q.entity ?? null, q.entityId ?? null, q.actorId ?? null, q.from ?? null, q.to ?? null, q.before ?? null, q.limit + 1],
      )
    ).rows;
    const page = rows.slice(0, q.limit).map((r: any) => ({ ...r, at: Number(r.at) }));
    return { entries: page, nextBefore: rows.length > q.limit ? Number(page[page.length - 1].id) : null };
  }
}
