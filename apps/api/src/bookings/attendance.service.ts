import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { decideNoShow, documentReasons, MS } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { loadPolicy } from '../common/policy.ts';
import { writeAudit } from '../common/audit.ts';
import { errorMessage } from '../common/errors.ts';
import { epochMs } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import {
  AUDIT, BOOKING_STATUS, ENTITY, FLOW_PROBLEM, LIMITS, OCCURRENCE_STATUS, PAY_WITH, RIDER_STATUS, ROLE, WAITLIST_STATUS,
} from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { queueForRider } from '../notifications/outbox.ts';
import { CancelClass, CompleteClass, IdParam, LessonRecord, SetAttendance } from './bookings.schemas.ts';
import { loadRiderFacts, lockOccurrence, returnPackageClass, toBooking, toOccurrence } from './core.ts';
import type { Tx } from '../common/sql.ts';

const problem = (message: string, code: string, extra: object = {}) => ({ message, problems: [{ code, message }], ...extra });

@Injectable()
export class AttendanceService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Loads a booking and its class, class first. A coach only ever finds bookings in their own classes. */
  private async load(c: Tx, rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const pre = (await c.query(`SELECT b.occurrence_id AS "occurrenceId" FROM bookings b WHERE b.id = $1`, [id])).rows[0];
    if (!pre) throw new NotFoundException('Booking not found.');
    const occRow = (await lockOccurrence(c, pre.occurrenceId))!;
    if (user.role === ROLE.COACH && occRow.coachId !== user.id) throw new NotFoundException('Booking not found.');
    const row = (
      await c.query(
        `SELECT b.id, b.branch_id AS "branchId", b.occurrence_id AS "occurrenceId", b.rider_id AS "riderId", b.status, b.pay_with AS "payWith",
                b.rider_package_id AS "packageId", ${epochMs('b.created_at')} AS "createdAt", r.status AS "riderStatus"
           FROM bookings b JOIN riders r ON r.id = b.rider_id WHERE b.id = $1 FOR UPDATE OF b`,
        [id],
      )
    ).rows[0];
    return { id, row, occ: toOccurrence(occRow), occRow };
  }

  async checkIn(rawId: string, user: AuthUser) {
    const now = Date.now();
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { id, row, occ } = await this.load(c, rawId, user);
      if (row.status === BOOKING_STATUS.CHECKED_IN) throw new ConflictException(problem('Already checked in.', FLOW_PROBLEM.ALREADY_CHECKED_IN));
      if (row.status === BOOKING_STATUS.PENDING_OFFICE_PAYMENT) throw new ConflictException(problem('Payment at the office is not recorded yet.', FLOW_PROBLEM.PAYMENT_PENDING));
      if (row.status !== BOOKING_STATUS.CONFIRMED) throw new ConflictException(problem('Only a confirmed booking can be checked in.', FLOW_PROBLEM.NOT_CHECKABLE));
      if (occ.status !== OCCURRENCE_STATUS.PUBLISHED && occ.status !== OCCURRENCE_STATUS.IN_PROGRESS) throw new ConflictException(problem('This class is not running.', FLOW_PROBLEM.CLASS_NOT_RUNNING));
      if (row.riderStatus !== RIDER_STATUS.ACTIVE) throw new ConflictException(problem('This rider is not approved to ride.', FLOW_PROBLEM.RIDER_NOT_ACTIVE));
      if (now < occ.startsAt - LIMITS.checkInOpensMinutes * MS.minute) throw new ConflictException(problem(`Check-in opens ${LIMITS.checkInOpensMinutes} minutes before the class.`, FLOW_PROBLEM.CHECKIN_TOO_EARLY));
      if (now >= occ.endsAt) throw new ConflictException(problem('The class has ended.', FLOW_PROBLEM.CHECKIN_CLOSED));
      // The documents were good when the place was booked; they must still be good now (BR-023, AC-017).
      const rider = (await loadRiderFacts(c, row.riderId, now))!;
      const documents = documentReasons(rider, occ, await loadPolicy(c, row.branchId));
      if (documents.length) throw new ConflictException({ message: 'This rider cannot be checked in.', problems: documents });
      await c.query(`UPDATE bookings SET status = $2 WHERE id = $1`, [id, BOOKING_STATUS.CHECKED_IN]);
      await writeAudit(c, user, row.branchId, AUDIT.BOOKING_CHECK_IN, ENTITY.BOOKING, id, { occurrenceId: row.occurrenceId });
      return { id, status: BOOKING_STATUS.CHECKED_IN };
    });
  }

  async noShow(rawId: string, user: AuthUser) {
    const now = Date.now();
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { id, row, occ } = await this.load(c, rawId, user);
      if (row.status !== BOOKING_STATUS.CONFIRMED && row.status !== BOOKING_STATUS.PENDING_OFFICE_PAYMENT) throw new ConflictException(problem('Only a booking that was not attended can be a no-show.', FLOW_PROBLEM.NOT_NO_SHOWABLE));
      if (now < occ.startsAt) throw new ConflictException(problem('The class has not started yet.', FLOW_PROBLEM.NO_SHOW_TOO_EARLY));
      // A package class was already spent when the booking was made; an unpaid office booking spent nothing.
      const consumed = decideNoShow(toBooking(row), await loadPolicy(c, row.branchId)).consumesClass && row.payWith === PAY_WITH.PACKAGE;
      await c.query(`UPDATE bookings SET status = $2, consumed_class = $3 WHERE id = $1`, [id, BOOKING_STATUS.NO_SHOW, consumed]);
      await writeAudit(c, user, row.branchId, AUDIT.BOOKING_NO_SHOW, ENTITY.BOOKING, id, { occurrenceId: row.occurrenceId, consumedClass: consumed });
      return { id, status: BOOKING_STATUS.NO_SHOW, consumedClass: consumed };
    });
  }

  /** What happened in the lesson: the horse really ridden, the outcome, the skills practised and notes (ATT-002). */
  async record(rawId: string, body: unknown, user: AuthUser) {
    const b = parse(LessonRecord, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { id, row, occ } = await this.load(c, rawId, user);
      if (Date.now() < occ.startsAt) throw new ConflictException(problem('The class has not started yet.', FLOW_PROBLEM.CLASS_NOT_STARTED));
      if (row.status === BOOKING_STATUS.CANCELLED) throw new ConflictException(problem('This booking was cancelled.', FLOW_PROBLEM.NOT_CHECKABLE));
      if (b.horseId && !(await c.query(`SELECT 1 FROM horses WHERE id = $1 AND branch_id = $2`, [b.horseId, row.branchId])).rowCount) throw new ConflictException(problem('That horse is not in this branch.', 'HORSE_NOT_IN_BRANCH'));
      const columns: Record<string, string> = { horseId: 'actual_horse_id', outcome: 'lesson_outcome', skillIds: 'skills_practised', notes: 'instructor_notes' };
      const keys = Object.keys(b).filter((k) => k in columns && (b as Record<string, unknown>)[k] !== undefined);
      if (keys.length) await c.query(`UPDATE bookings SET ${keys.map((k, i) => `${columns[k]} = $${i + 2}${k === 'skillIds' ? '::uuid[]' : ''}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => (b as Record<string, unknown>)[k])]);
      await writeAudit(c, user, row.branchId, 'booking.lesson_record', ENTITY.BOOKING, id, { fields: keys });
      return { id };
    });
  }

  /**
   * Marks how a rider attended. While the class is open its runner marks present or late. Once attendance is final
   * (completed or no-show) only a manager may change it, with a reason, and the package class follows (ATT-006, BR-021).
   */
  async attendance(rawId: string, body: unknown, user: AuthUser) {
    const b = parse(SetAttendance, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { id, row, occ } = await this.load(c, rawId, user);
      const before = (await c.query(`SELECT attendance, consumed_class AS consumed FROM bookings WHERE id = $1`, [id])).rows[0];
      const final = row.status === BOOKING_STATUS.COMPLETED || row.status === BOOKING_STATUS.NO_SHOW;
      const here = b.attendance === 'present' || b.attendance === 'late';
      if (!final) {
        if (row.status !== BOOKING_STATUS.CHECKED_IN || !here) throw new ConflictException(problem('Check the rider in first. Mark an absent rider as a no-show.', FLOW_PROBLEM.NOT_CHECKABLE));
        await c.query(`UPDATE bookings SET attendance = $2 WHERE id = $1`, [id, b.attendance]);
        await writeAudit(c, user, row.branchId, 'booking.attendance', ENTITY.BOOKING, id, { attendance: b.attendance });
        return { id, status: row.status, attendance: b.attendance };
      }
      if (user.role !== ROLE.MANAGER && user.role !== ROLE.OWNER) throw new ForbiddenException(problem('Only a manager can change attendance after it is final.', 'ATTENDANCE_FINAL'));
      if (!b.reason) throw new BadRequestException({ message: 'A reason is required.', problems: [{ field: 'reason', message: 'is required to change final attendance' }] });
      const status = here ? BOOKING_STATUS.COMPLETED : BOOKING_STATUS.NO_SHOW;
      const used = row.status === BOOKING_STATUS.COMPLETED || before.consumed === true;
      const policy = await loadPolicy(c, row.branchId);
      const uses = here || (b.attendance === 'absent' && policy.noShowConsumesClass);
      if (row.payWith === PAY_WITH.PACKAGE && row.packageId && used !== uses) {
        await c.query(`INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key, booking_id, note, by_account) VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`, [
          row.packageId, uses ? -1 : 1, `attendance:${id}:${randomUUID()}`, id, `Attendance changed to ${b.attendance}: ${b.reason}`, user.id,
        ]);
      }
      await c.query(`UPDATE bookings SET status = $2, attendance = $3, consumed_class = $4 WHERE id = $1`, [id, status, b.attendance, row.payWith === PAY_WITH.PACKAGE ? uses : false]);
      await writeAudit(c, user, row.branchId, 'booking.attendance_change', ENTITY.BOOKING, id, { from: before.attendance ?? row.status, to: b.attendance, reason: b.reason, occurrenceId: occ.id });
      return { id, status, attendance: b.attendance };
    });
  }

  async completeClass(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { markRemainingNoShow } = parse(CompleteClass, body);
    const now = Date.now();
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const occRow = await lockOccurrence(c, id);
      if (!occRow || (user.role === ROLE.COACH && occRow.coachId !== user.id)) throw new NotFoundException('Class not found.');
      if (occRow.status !== OCCURRENCE_STATUS.PUBLISHED && occRow.status !== OCCURRENCE_STATUS.IN_PROGRESS) throw new ConflictException(problem('Only a running class can be completed.', FLOW_PROBLEM.CLASS_NOT_COMPLETABLE));
      if (now < Number(occRow.startsAt)) throw new ConflictException(problem('The class has not started yet.', FLOW_PROBLEM.CLASS_NOT_STARTED));

      const open = (
        await c.query(`SELECT id, status, pay_with AS "payWith" FROM bookings WHERE occurrence_id = $1 AND status = ANY($2::booking_status[]) FOR UPDATE`, [id, [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.PENDING_OFFICE_PAYMENT]])
      ).rows;
      if (open.length > 0 && !markRemainingNoShow) {
        throw new ConflictException(problem(`${open.length} booking(s) were not checked in. Check them in or mark them as no-shows.`, FLOW_PROBLEM.UNRESOLVED_BOOKINGS, { unresolved: open.length }));
      }
      const noShowConsumes = (await loadPolicy(c, occRow.branchId)).noShowConsumesClass;
      for (const b of open) {
        const consumed = b.payWith === PAY_WITH.PACKAGE && b.status === BOOKING_STATUS.CONFIRMED && noShowConsumes;
        await c.query(`UPDATE bookings SET status = $2, consumed_class = $3 WHERE id = $1`, [b.id, BOOKING_STATUS.NO_SHOW, consumed]);
      }
      const done = await c.query(`UPDATE bookings SET status = $3 WHERE occurrence_id = $1 AND status = $2`, [id, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.COMPLETED]);
      await c.query(`UPDATE waitlist_entries SET status = $2 WHERE occurrence_id = $1 AND status = ANY($3)`, [id, WAITLIST_STATUS.EXPIRED, [WAITLIST_STATUS.ACTIVE, WAITLIST_STATUS.OFFERED]]);
      await c.query(`UPDATE occurrences SET status = $2 WHERE id = $1`, [id, OCCURRENCE_STATUS.COMPLETED]);
      await writeAudit(c, user, occRow.branchId, AUDIT.CLASS_COMPLETE, ENTITY.OCCURRENCE, id, { completed: done.rowCount, noShows: open.length });
      return { id, status: OCCURRENCE_STATUS.COMPLETED, completed: done.rowCount ?? 0, noShows: open.length };
    });
  }

  /**
   * Cancels every date of a repeating class that has not started yet, each one exactly as a single class is cancelled
   * (riders told it was the club's doing, package classes returned). A date that cannot be cancelled is reported, and the rest still are.
   */
  async cancelSeries(rawSeriesId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawSeriesId });
    parse(CancelClass, body); // check the reason before touching anything
    const found = await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const series = await c.query(`SELECT branch_id AS "branchId" FROM schedule_series WHERE id = $1`, [id]);
      if (series.rowCount === 0) throw new NotFoundException('Series not found.');
      const rows = (
        await c.query(
          `SELECT id FROM occurrences WHERE series_id = $1 AND status = ANY($2::occurrence_status[]) AND lower(during) > now() ORDER BY lower(during)`,
          [id, [OCCURRENCE_STATUS.DRAFT, OCCURRENCE_STATUS.PUBLISHED]],
        )
      ).rows;
      return { branchId: series.rows[0].branchId as string, rows };
    });
    const upcoming = found.rows;
    const cancelled: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const o of upcoming) {
      try {
        await this.cancelClass(o.id, body, user);
        cancelled.push(o.id);
      } catch (e: unknown) {
        failed.push({ id: o.id, message: errorMessage(e) });
      }
    }
    await this.db.scoped({ branchIds: user.branchIds, role: user.role }, (c) =>
      writeAudit(c, user, found.branchId, AUDIT.SERIES_CANCEL, ENTITY.OCCURRENCE, id, { cancelled: cancelled.length, failed: failed.length }),
    );
    return { seriesId: id, cancelled: cancelled.length, failed };
  }

  /** Cancels a whole class. Every rider is told it was the club's doing, so nobody pays, and every package class comes back. */
  async cancelClass(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { reason, cause } = parse(CancelClass, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const occRow = await lockOccurrence(c, id);
      if (!occRow) throw new NotFoundException('Class not found.');
      if (occRow.status === OCCURRENCE_STATUS.CANCELLED || occRow.status === OCCURRENCE_STATUS.COMPLETED) {
        throw new ConflictException(problem(`A ${occRow.status} class cannot be cancelled.`, FLOW_PROBLEM.CLASS_NOT_CANCELLABLE));
      }
      const bookings = (
        await c.query(`SELECT id, rider_id AS "riderId", status, pay_with AS "payWith", rider_package_id AS "packageId" FROM bookings WHERE occurrence_id = $1 AND status = ANY($2::booking_status[]) FOR UPDATE`, [
          id, [BOOKING_STATUS.PENDING_OFFICE_PAYMENT, BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.CHECKED_IN],
        ])
      ).rows;
      let returned = 0;
      for (const b of bookings) {
        await c.query(`UPDATE bookings SET status = $2, cancelled_at = now(), cancel_cause = $3, consumed_class = false WHERE id = $1`, [b.id, BOOKING_STATUS.CANCELLED, cause]);
        await queueForRider(c, b.riderId, { event: 'class.cancelled', branchId: occRow.branchId, occurrenceId: id, dedupeKey: `booking:${b.id}:class_cancelled`, data: { reason } });
        // An unpaid office booking never spent a class, so there is nothing to give back.
        if (b.payWith === PAY_WITH.PACKAGE && b.packageId && b.status !== BOOKING_STATUS.PENDING_OFFICE_PAYMENT) {
          await returnPackageClass(c, b.packageId, b.id, user.id);
          returned++;
        }
      }
      const waiting = await c.query(`UPDATE waitlist_entries SET status = $2 WHERE occurrence_id = $1 AND status = ANY($3)`, [id, WAITLIST_STATUS.REMOVED, [WAITLIST_STATUS.ACTIVE, WAITLIST_STATUS.OFFERED]]);
      // A cancelled class must free its horses, or they would stay blocked for that time slot.
      const horsesFreed = await c.query(`DELETE FROM horse_assignments WHERE occurrence_id = $1`, [id]);
      await c.query(`UPDATE occurrences SET status = $2 WHERE id = $1`, [id, OCCURRENCE_STATUS.CANCELLED]);
      await writeAudit(c, user, occRow.branchId, AUDIT.CLASS_CANCEL, ENTITY.OCCURRENCE, id, { reason, cause, bookings: bookings.length, packageClassesReturned: returned, waitlistClosed: waiting.rowCount, horsesFreed: horsesFreed.rowCount });
      return { id, status: OCCURRENCE_STATUS.CANCELLED, bookingsCancelled: bookings.length, packageClassesReturned: returned, waitlistClosed: waiting.rowCount ?? 0 };
    });
  }
}
