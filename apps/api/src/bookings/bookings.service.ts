import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { decideCancellation, place, spotsLeft } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { OWNS_RIDER, writeAudit } from '../common/audit.ts';
import { epochMs } from '../common/sql.ts';
import { loadPolicy } from '../common/policy.ts';
import { parse } from '../common/validate.ts';
import {
  AUDIT, BOOKING_SOURCE, BOOKING_STATUS, CANCEL_CAUSE, ENTITY, LIMITS, OCCURRENCE_STATUS, PG_ERROR, PROBLEM, ROLE, WAITLIST_STATUS,
} from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { queueForRider } from '../notifications/outbox.ts';
import { CancelBooking, CreateBooking, IdParam, RosterQuery } from './bookings.schemas.ts';
import {
  evaluate, expireStaleHolds, insertBooking, LIVE, lockOccurrence, policyFor, promoteWaitlist, returnPackageClass, toBooking, toOccurrence,
} from './core.ts';
import { pgErrorCode } from '../common/errors.ts';

const isStaff = (u: AuthUser) => u.role === ROLE.RECEPTION || u.role === ROLE.MANAGER || u.role === ROLE.OWNER;
export const cannotBook = (reasons: unknown[]) => new UnprocessableEntityException({ message: 'This booking cannot be made.', problems: reasons });

@Injectable()
export class BookingsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateBooking, body);
    const now = Date.now();
    const customer = user.role === ROLE.CUSTOMER;

    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const occRow = await lockOccurrence(c, b.occurrenceId);
        // A customer must not learn that an unpublished class exists.
        if (!occRow || (customer && occRow.status !== OCCURRENCE_STATUS.PUBLISHED)) throw new NotFoundException('Class not found.');
        const occ = toOccurrence(occRow) as typeof occRow;
        occ.branchId = occRow.branchId;
        await expireStaleHolds(c, occ.id, occ.branchId, now);
        const policy = await loadPolicy(c, occ.branchId);

        const ev = await evaluate(c, { occ, riderId: b.riderId, payWith: b.payWith, packageId: b.packageId, now, policy, ownedBy: customer ? user.id : undefined });
        if (ev.kind === 'no_rider') throw new NotFoundException('Rider not found.');
        if (ev.kind === 'wrong_branch') throw cannotBook([{ code: PROBLEM.RIDER_WRONG_BRANCH, message: 'This rider belongs to a different branch.' }]);
        if (ev.reasons.length > 0) throw cannotBook(ev.reasons);

        const walkIn = !customer && (await c.query(`SELECT 1 FROM riders WHERE id = $1 AND is_walk_in`, [b.riderId])).rowCount;
        const source = customer ? BOOKING_SOURCE.CUSTOMER_APP : walkIn ? BOOKING_SOURCE.WALK_IN : BOOKING_SOURCE.STAFF_PORTAL;
        let placement: string = place(occ, ev.inClass, b.payWith, now, policy);
        // Places promised to people with an open waitlist offer are not free for newcomers.
        if (placement !== 'waitlisted' && ev.offered >= spotsLeft(occ, ev.inClass, now, policy)) placement = 'waitlisted';

        if (placement === 'waitlisted') {
          // clock_timestamp(), not the default now(): now() is when this transaction began, which can be earlier than
          // another request that queued on the class lock first. The place in line is the order the lock was won.
          const w = (await c.query(`INSERT INTO waitlist_entries (occurrence_id, rider_id, joined_at) VALUES ($1,$2,clock_timestamp()) RETURNING id`, [b.occurrenceId, b.riderId])).rows[0];
          const position = (
            await c.query(
              `SELECT count(*)::int AS n FROM waitlist_entries WHERE occurrence_id = $1 AND status = $2 AND (joined_at, id) <= (SELECT joined_at, id FROM waitlist_entries WHERE id = $3)`,
              [b.occurrenceId, WAITLIST_STATUS.ACTIVE, w.id],
            )
          ).rows[0].n;
          await writeAudit(c, user, occ.branchId, AUDIT.BOOKING_WAITLIST, ENTITY.WAITLIST_ENTRY, w.id, { occurrenceId: b.occurrenceId, riderId: b.riderId });
          return { status: 'waitlisted' as const, waitlistEntryId: w.id as string, position: position as number };
        }

        const ins = await insertBooking(c, { branchId: occ.branchId, occurrenceId: occ.id, riderId: b.riderId, status: placement, payWith: b.payWith, packageId: b.packageId, source, userId: user.id, now, policy });
        await writeAudit(c, user, occ.branchId, AUDIT.BOOKING_CREATE, ENTITY.BOOKING, ins.id, { occurrenceId: b.occurrenceId, riderId: b.riderId, payWith: b.payWith, status: placement });
        await queueForRider(c, b.riderId, {
          event: placement === BOOKING_STATUS.PENDING_OFFICE_PAYMENT ? 'booking.pending_payment' : 'booking.confirmed', branchId: occ.branchId, occurrenceId: occ.id,
          dedupeKey: `booking:${ins.id}:created`, data: { amountMinor: occ.priceMinor, holdMinutes: policy.officeHoldMinutes },
        });
        const number = (await c.query(`SELECT number FROM bookings WHERE id = $1`, [ins.id])).rows[0].number as string;
        return { id: ins.id, number, status: placement, holdExpiresAt: ins.holdExpiresAt };
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.CHECK_VIOLATION) throw cannotBook([{ code: PROBLEM.NO_PACKAGE_BALANCE, message: 'No classes left in the package.' }]);
      if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException('This rider already has a booking or a waitlist place for this class.');
      if (pgErrorCode(e) === PG_ERROR.INSUFFICIENT_PRIVILEGE) throw new ForbiddenException('That is outside the branches you may work in.');
      throw e;
    }
  }

  async cancel(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { cause = CANCEL_CAUSE.CUSTOMER } = parse(CancelBooking, body);
    const customer = user.role === ROLE.CUSTOMER;
    // Only staff can say the club or the weather caused it. A customer cannot waive their own late fee that way.
    if (customer && cause !== CANCEL_CAUSE.CUSTOMER) throw new ForbiddenException('Only staff can cancel because of the club or the weather.');
    const now = Date.now();

    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      // Lock the class first, then the booking, in the same order everywhere, so two actions never wait on each other.
      const pre = (
        await c.query(`SELECT b.occurrence_id AS "occurrenceId" FROM bookings b JOIN riders r ON r.id = b.rider_id WHERE b.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')})`, [id, customer, user.id])
      ).rows[0];
      if (!pre) throw new NotFoundException('Booking not found.');
      const occRow = (await lockOccurrence(c, pre.occurrenceId))!;
      const row = (
        await c.query(
          `SELECT b.id, b.branch_id AS "branchId", b.occurrence_id AS "occurrenceId", b.rider_id AS "riderId", b.status, b.pay_with AS "payWith",
                  b.rider_package_id AS "packageId", ${epochMs('b.created_at')} AS "createdAt"
             FROM bookings b WHERE b.id = $1 FOR UPDATE`,
          [id],
        )
      ).rows[0];

      const policy = await loadPolicy(c, occRow.branchId);
      const decision = decideCancellation(toBooking(row), toOccurrence(occRow), now, cause, policyFor(policy, occRow));
      if (!decision.allowed) throw new ConflictException({ message: decision.reason, problems: [{ code: PROBLEM.CANNOT_CANCEL, message: decision.reason }] });
      await c.query(`UPDATE bookings SET status = $2, cancelled_at = now(), cancel_cause = $3, consumed_class = $4 WHERE id = $1`, [id, BOOKING_STATUS.CANCELLED, cause, decision.consumesClass]);
      if (decision.returnsPackageClass && row.packageId) await returnPackageClass(c, row.packageId, id, user.id);
      await queueForRider(c, row.riderId, { event: 'booking.cancelled', branchId: row.branchId, occurrenceId: row.occurrenceId, dedupeKey: `booking:${id}:cancelled`, data: { byClub: cause === CANCEL_CAUSE.CLUB } });
      await writeAudit(c, user, row.branchId, AUDIT.BOOKING_CANCEL, ENTITY.BOOKING, id, { cause, consumedClass: decision.consumesClass, returnedToPackage: decision.returnsPackageClass });

      // The freed place goes to the next person waiting.
      const offers = await promoteWaitlist(c, { ...toOccurrence(occRow), branchId: occRow.branchId }, now, policy, user);
      return { id, status: BOOKING_STATUS.CANCELLED, consumedClass: decision.consumesClass, returnedToPackage: decision.returnsPackageClass, reason: decision.reason, waitlistOffers: offers.length };
    });
  }

  /** What cancelling would do, shown to staff before they confirm (BRD 5.7). Changes nothing. */
  async cancelPreview(rawId: string, query: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { cause = CANCEL_CAUSE.CUSTOMER } = parse(CancelBooking, query);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const row = (
        await c.query(
          `SELECT b.id, b.occurrence_id AS "occurrenceId", b.rider_id AS "riderId", b.status, b.pay_with AS "payWith", b.rider_package_id AS "packageId", ${epochMs('b.created_at')} AS "createdAt" FROM bookings b WHERE b.id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Booking not found.');
      const occRow = (await lockOccurrence(c, row.occurrenceId))!;
      const decision = decideCancellation(toBooking(row), toOccurrence(occRow), Date.now(), cause, policyFor(await loadPolicy(c, occRow.branchId), occRow));
      const paid = (
        await c.query(
          `SELECT r.id AS "receiptId", r.number, r.amount_minor AS "paidMinor",
                  coalesce((SELECT sum(f.amount_minor) FROM financial_adjustments f WHERE f.receipt_id = r.id AND f.kind IN ('refund','credit')), 0)::int AS "returnedMinor"
             FROM receipts r WHERE r.for_booking_id = $1 ORDER BY r.issued_at DESC LIMIT 1`,
          [id],
        )
      ).rows[0];
      return { cause, ...decision, payment: paid ?? null };
    });
  }

  async mine(user: AuthUser) {
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const bookings = (
        await c.query(
          `SELECT b.id, b.status, b.pay_with AS "payWith", b.hold_expires_at AS "holdExpiresAt", b.rider_id AS "riderId", r.full_name AS "riderName",
                  o.id AS "occurrenceId", o.title, o.format, lower(o.during) AS "startsAt", upper(o.during) AS "endsAt"
             FROM bookings b JOIN riders r ON r.id = b.rider_id JOIN occurrences o ON o.id = b.occurrence_id
            WHERE ${OWNS_RIDER('r', '$1')}
            ORDER BY lower(o.during) DESC LIMIT $2`,
          [user.id, LIMITS.bookingsListLimit],
        )
      ).rows;
      const waitlist = (
        await c.query(
          `SELECT w.id, w.status, w.joined_at AS "joinedAt", w.offer_expires_at AS "offerExpiresAt", w.rider_id AS "riderId", r.full_name AS "riderName",
                  o.id AS "occurrenceId", o.title, lower(o.during) AS "startsAt"
             FROM waitlist_entries w JOIN riders r ON r.id = w.rider_id JOIN occurrences o ON o.id = w.occurrence_id
            WHERE w.status = ANY($2) AND (w.status <> $4 OR w.offer_expires_at > now()) AND ${OWNS_RIDER('r', '$1')}
            ORDER BY lower(o.during) LIMIT $3`,
          [user.id, [WAITLIST_STATUS.ACTIVE, WAITLIST_STATUS.OFFERED], LIMITS.bookingsListLimit, WAITLIST_STATUS.OFFERED],
        )
      ).rows;
      return { bookings, waitlist };
    });
  }

  async roster(query: unknown, user: AuthUser) {
    const { occurrenceId } = parse(RosterQuery, query);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const occ = (await c.query(`SELECT id, coach_id AS "coachId", title, capacity FROM occurrences WHERE id = $1`, [occurrenceId])).rows[0];
      // A coach sees only their own classes. Staff see every class in their branches.
      if (!occ || (!isStaff(user) && occ.coachId !== user.id)) throw new NotFoundException('Class not found.');
      // No medical notes or contact details here: a roster is for running the class. A lapsed office hold is not on it.
      const bookings = (
        await c.query(
          `SELECT b.id, b.status, b.pay_with AS "payWith", b.created_at AS "createdAt", r.id AS "riderId", r.full_name AS "riderName", r.level,
                  b.source, b.number, b.attendance, b.actual_horse_id AS "horseId", b.lesson_outcome AS "outcome", b.skills_practised AS "skillIds", b.instructor_notes AS "notes", b.hold_expires_at AS "holdExpiresAt", (SELECT i.gross_minor FROM invoices i WHERE i.booking_id = b.id AND i.status = 'issued') AS "owedMinor"
             FROM bookings b JOIN riders r ON r.id = b.rider_id
            WHERE b.occurrence_id = $1 AND b.status = ANY($2::booking_status[]) AND (b.status <> $4 OR b.hold_expires_at > now())
            ORDER BY b.created_at LIMIT $3`,
          [occurrenceId, [...LIVE, BOOKING_STATUS.NO_SHOW], LIMITS.bookingsListLimit, BOOKING_STATUS.PENDING_OFFICE_PAYMENT],
        )
      ).rows;
      const waitlist = (
        await c.query(
          `SELECT w.id, w.status, w.joined_at AS "joinedAt", w.offer_expires_at AS "offerExpiresAt", r.id AS "riderId", r.full_name AS "riderName"
             FROM waitlist_entries w JOIN riders r ON r.id = w.rider_id
            WHERE w.occurrence_id = $1 AND w.status = ANY($2) AND (w.status <> $4 OR w.offer_expires_at > now()) ORDER BY w.joined_at, w.id LIMIT $3`,
          [occurrenceId, [WAITLIST_STATUS.ACTIVE, WAITLIST_STATUS.OFFERED], LIMITS.bookingsListLimit, WAITLIST_STATUS.OFFERED],
        )
      ).rows;
      return { occurrence: occ, bookings, waitlist };
    });
  }
}
