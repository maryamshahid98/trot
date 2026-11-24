import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { canAccept } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { OWNS_RIDER, writeAudit } from '../common/audit.ts';
import { loadPolicy } from '../common/policy.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, BOOKING_SOURCE, BOOKING_STATUS, ENTITY, FLOW_PROBLEM, PAY_WITH, PG_ERROR, PROBLEM, ROLE, WAITLIST_STATUS } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { AcceptOffer, IdParam } from './bookings.schemas.ts';
import { cannotBook } from './bookings.service.ts';
import { evaluate, expireStaleHolds, insertBooking, loadClassState, lockOccurrence, promoteWaitlist, toOccurrence } from './core.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });

@Injectable()
export class WaitlistService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Finds the entry the caller may act on, then locks its class before the entry itself (same lock order as everywhere else). */
  private async lockEntry(c: any, id: string, user: AuthUser) {
    const customer = user.role === ROLE.CUSTOMER;
    const pre = (
      await c.query(
        `SELECT w.occurrence_id AS "occurrenceId" FROM waitlist_entries w JOIN riders r ON r.id = w.rider_id WHERE w.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')})`,
        [id, customer, user.id],
      )
    ).rows[0];
    if (!pre) throw new NotFoundException('Waitlist entry not found.');
    const occRow = (await lockOccurrence(c, pre.occurrenceId))!;
    const entry = (
      await c.query(
        `SELECT id, rider_id AS "riderId", occurrence_id AS "occurrenceId", status, offered_at AS "offeredAt", offer_expires_at AS "offerExpiresAt", joined_at AS "joinedAt"
           FROM waitlist_entries WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    return { occRow, entry };
  }

  async accept(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(AcceptOffer, body);
    const now = Date.now();

    try {
      const out = await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const { occRow, entry } = await this.lockEntry(c, id, user);
        const policy = await loadPolicy(c, occRow.branchId);
        const occ = toOccurrence(occRow) as typeof occRow;
        if (entry.status !== WAITLIST_STATUS.OFFERED) return { fail: problem('There is no open offer for this entry.', FLOW_PROBLEM.NOT_OFFERED) };
        const offer = { ...entry, joinedAt: Date.parse(entry.joinedAt), offerExpiresAt: Date.parse(entry.offerExpiresAt) };
        if (!canAccept(offer as any, now)) {
          // The offer timed out: close it and pass the place on. This must be saved, so report the failure after the transaction commits.
          await c.query(`UPDATE waitlist_entries SET status = $2 WHERE id = $1`, [id, WAITLIST_STATUS.EXPIRED]);
          await promoteWaitlist(c, occ, now, policy, null);
          return { fail: problem('This offer has expired.', FLOW_PROBLEM.OFFER_EXPIRED) };
        }

        await expireStaleHolds(c, occ.id, occ.branchId, now);
        const ev = await evaluate(c, { occ, riderId: entry.riderId, payWith: b.payWith, packageId: b.packageId, now, policy, ignoreWaitlist: true });
        if (ev.kind !== 'checked') throw new NotFoundException('Rider not found.');
        if (ev.reasons.length > 0) throw cannotBook(ev.reasons); // the offer stays open until it expires so they can fix it (for example pay for a package)
        // Their own offer is being used up, so only other people's offers still hold places.
        const state = await loadClassState(c, occ.id, now);
        if (state.inClass.length + (state.offered - 1) >= occ.capacity) throw new ConflictException(problem('The place is no longer available.', FLOW_PROBLEM.PLACE_TAKEN));

        const status = b.payWith === PAY_WITH.OFFICE ? BOOKING_STATUS.PENDING_OFFICE_PAYMENT : BOOKING_STATUS.CONFIRMED;
        const source = user.role === ROLE.CUSTOMER ? BOOKING_SOURCE.CUSTOMER_APP : BOOKING_SOURCE.STAFF_PORTAL;
        const ins = await insertBooking(c, { branchId: occ.branchId, occurrenceId: occ.id, riderId: entry.riderId, status, payWith: b.payWith, packageId: b.packageId, source, userId: user.id, now, policy });
        await c.query(`UPDATE waitlist_entries SET status = $2 WHERE id = $1`, [id, WAITLIST_STATUS.CONVERTED]);
        await writeAudit(c, user, occ.branchId, AUDIT.WAITLIST_ACCEPT, ENTITY.WAITLIST_ENTRY, id, { bookingId: ins.id, payWith: b.payWith });
        return { ok: { id: ins.id, status, holdExpiresAt: ins.holdExpiresAt } };
      });
      if ('fail' in out && out.fail) throw new ConflictException(out.fail);
      return out.ok;
    } catch (e: any) {
      if (e?.code === PG_ERROR.CHECK_VIOLATION) throw cannotBook([{ code: PROBLEM.NO_PACKAGE_BALANCE, message: 'No classes left in the package.' }]);
      if (e?.code === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException('This rider already has a booking for this class.');
      throw e;
    }
  }

  /** Leaving the line, or turning down an offer. Either way the next person in line is offered the place. */
  async leave(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const now = Date.now();
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const { occRow, entry } = await this.lockEntry(c, id, user);
      if (entry.status !== WAITLIST_STATUS.ACTIVE && entry.status !== WAITLIST_STATUS.OFFERED) {
        throw new ConflictException(problem('This waitlist entry is already closed.', FLOW_PROBLEM.NOT_OFFERED));
      }
      const status = entry.status === WAITLIST_STATUS.OFFERED ? WAITLIST_STATUS.DECLINED : WAITLIST_STATUS.REMOVED;
      await c.query(`UPDATE waitlist_entries SET status = $2 WHERE id = $1`, [id, status]);
      await writeAudit(c, user, occRow.branchId, AUDIT.WAITLIST_LEAVE, ENTITY.WAITLIST_ENTRY, id, { status });
      const offers = await promoteWaitlist(c, { ...toOccurrence(occRow), branchId: occRow.branchId } as any, now, await loadPolicy(c, occRow.branchId), user);
      return { id, status, waitlistOffers: offers.length };
    });
  }

  /** Staff: re-run the offers for a class (for example after offers timed out). */
  async refresh(classId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: classId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const occRow = await lockOccurrence(c, id);
      if (!occRow) throw new NotFoundException('Class not found.');
      const offers = await promoteWaitlist(c, { ...toOccurrence(occRow), branchId: occRow.branchId } as any, Date.now(), await loadPolicy(c, occRow.branchId), user);
      return { offers };
    });
  }
}
