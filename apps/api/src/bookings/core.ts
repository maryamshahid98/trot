// The database steps that bookings, the waitlist and attendance all share.
// They are plain functions that take the caller's transaction, so each caller decides what happens as one unit.
// Rule: the caller must already hold a lock on the class row (see lockOccurrence) before using the counting helpers.
import { checkEligibility, MS, spotsLeft } from '@trot/domain';
import type { Booking, Occurrence, Policy, Reason, Rider } from '@trot/domain';
import { dayKeyFor, epochMs } from '../common/sql.ts';
import type { Row, Tx } from '../common/sql.ts';
import { writeAudit } from '../common/audit.ts';
import { queueForRider } from '../notifications/outbox.ts';
import {
  AUDIT, BOOKING_STATUS, DOC_KIND, DOC_STATUS, ENTITY, LEDGER_REASON, OCCURRENCE_STATUS, PACKAGE_STATUS, PAY_WITH, PROBLEM, RIDE_FORMAT, WAITLIST_STATUS,
} from '../config/constants.ts';

export type { Tx } from '../common/sql.ts';

/** Bookings that still hold a place (or are about to be used). */
export const LIVE = [BOOKING_STATUS.PENDING_OFFICE_PAYMENT, BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.COMPLETED];

export const OCC_COLS = `o.id, o.branch_id AS "branchId", o.title, o.format, o.min_level AS "minLevel", o.status, o.capacity,
  o.min_age_years AS "minAgeYears", o.price_minor AS "priceMinor", o.arena_id AS "arenaId", o.coach_id AS "coachId",
  ${epochMs('lower(o.during)')} AS "startsAt", ${epochMs('upper(o.during)')} AS "endsAt"`;

export const toOccurrence = (o: Row): Occurrence => ({ ...(o as Omit<Occurrence, 'startsAt' | 'endsAt'>), startsAt: Number(o.startsAt), endsAt: Number(o.endsAt) });
export const toBooking = (r: Row): Booking => ({
  id: r.id, riderId: r.riderId, occurrenceId: r.occurrenceId, status: r.status, payWith: r.payWith, packageId: r.packageId ?? undefined, createdAt: Number(r.createdAt),
});

/** Locks the class row so two people asking for the last place are decided one after the other. */
export async function lockOccurrence(c: Tx, id: string) {
  return (await c.query(`SELECT ${OCC_COLS} FROM occurrences o WHERE o.id = $1 FOR UPDATE`, [id])).rows[0] as (Occurrence & { branchId: string }) | undefined;
}

/**
 * Releases pay-at-office places whose hold ran out. Without this the unique "one live booking per rider and class"
 * rule would stop that rider from ever booking the class again. No class was ever deducted for these, so nothing to return.
 */
export async function expireStaleHolds(c: Tx, occurrenceId: string, branchId: string, now: number): Promise<number> {
  const r = await c.query(
    `UPDATE bookings SET status = $3, cancelled_at = now(), cancel_cause = 'club', consumed_class = false
      WHERE occurrence_id = $1 AND status = $2 AND hold_expires_at <= $4::timestamptz RETURNING id`,
    [occurrenceId, BOOKING_STATUS.PENDING_OFFICE_PAYMENT, BOOKING_STATUS.CANCELLED, new Date(now).toISOString()],
  );
  for (const row of r.rows) await writeAudit(c, null, branchId, AUDIT.BOOKING_HOLD_EXPIRED, ENTITY.BOOKING, row.id, { occurrenceId });
  return r.rowCount ?? 0;
}

/** The rider as the rules see them: documents only count once a staff member has verified them. */
export async function loadRiderFacts(c: Tx, riderId: string, now: number, ownedBy?: string): Promise<(Rider & { branchId: string }) | undefined> {
  const row = (
    await c.query(
      `SELECT r.id, r.branch_id AS "branchId", r.status, r.level, ${epochMs('r.date_of_birth::timestamp')} AS dob,
              (SELECT g.guardian_account_id FROM guardian_riders g WHERE g.rider_id = r.id LIMIT 1) AS "guardianId"
         FROM riders r
        WHERE r.id = $1 AND ($2::uuid IS NULL OR r.account_id = $2 OR EXISTS (SELECT 1 FROM guardian_riders g WHERE g.rider_id = r.id AND g.guardian_account_id = $2))`,
      [riderId, ownedBy ?? null],
    )
  ).rows[0];
  if (!row) return undefined;
  const docs = (
    await c.query(
      `SELECT kind, ${epochMs('signed_at')} AS "signedAt", ${epochMs('expires_at')} AS "expiresAt"
         FROM rider_documents WHERE rider_id = $1 AND status = $2 AND kind = ANY($3::document_kind[])`,
      [riderId, DOC_STATUS.VERIFIED, [DOC_KIND.MEDICAL_FORM, DOC_KIND.WAIVER]],
    )
  ).rows;
  let medicalFormExpiresAt: number | undefined;
  let waiverSignedAt: number | undefined;
  for (const d of docs) {
    const expires = d.expiresAt === null ? Number.MAX_SAFE_INTEGER : Number(d.expiresAt);
    if (d.kind === DOC_KIND.MEDICAL_FORM) medicalFormExpiresAt = Math.max(medicalFormExpiresAt ?? 0, expires);
    if (d.kind === DOC_KIND.WAIVER && expires > now) waiverSignedAt = Number(d.signedAt ?? now);
  }
  return { id: row.id, branchId: row.branchId, status: row.status, level: row.level, dateOfBirth: Number(row.dob), guardianId: row.guardianId ?? undefined, medicalFormExpiresAt, waiverSignedAt };
}

export async function loadRiderBookings(c: Tx, riderId: string) {
  // OCC_COLS also selects "id" and "status" (the class's). The booking's own are aliased so the two cannot overwrite each other.
  const rows = (
    await c.query(
      `SELECT b.id AS "bookingId", b.occurrence_id AS "occurrenceId", b.rider_id AS "riderId", b.status AS "bookingStatus", b.pay_with AS "payWith",
              b.rider_package_id AS "packageId", ${epochMs('b.created_at')} AS "createdAt", ${OCC_COLS}
         FROM bookings b JOIN occurrences o ON o.id = b.occurrence_id
        WHERE b.rider_id = $1 AND b.status = ANY($2::booking_status[])`,
      [riderId, LIVE],
    )
  ).rows;
  return rows.map((r) => ({ booking: toBooking({ ...r, id: r.bookingId, status: r.bookingStatus }), occurrence: toOccurrence(r) }));
}

/** Who holds a place in this class right now, and how many places are promised to people with an open waitlist offer. */
export async function loadClassState(c: Tx, occurrenceId: string, now: number) {
  const inClass = (
    await c.query(
      `SELECT id, occurrence_id AS "occurrenceId", rider_id AS "riderId", status, pay_with AS "payWith", ${epochMs('created_at')} AS "createdAt"
         FROM bookings WHERE occurrence_id = $1 AND status = ANY($2::booking_status[])`,
      [occurrenceId, LIVE],
    )
  ).rows.map(toBooking);
  const offered = (
    await c.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE occurrence_id = $1 AND status = $2 AND offer_expires_at > $3::timestamptz`, [
      occurrenceId, WAITLIST_STATUS.OFFERED, new Date(now).toISOString(),
    ])
  ).rows[0].n as number;
  return { inClass, offered };
}

export async function checkPackage(c: Tx, packageId: string, riderId: string, occ: Occurrence) {
  const problems: Reason[] = [];
  const p = (
    await c.query(
      `SELECT rp.id, rp.status, ${epochMs('rp.valid_until')} AS "validUntil", pt.class_formats::text[] AS formats,
              coalesce((SELECT sum(l.delta) FROM package_ledger l WHERE l.rider_package_id = rp.id), 0)::int AS balance
         FROM rider_packages rp JOIN package_types pt ON pt.id = rp.package_type_id
        WHERE rp.id = $1 AND rp.rider_id = $2`,
      [packageId, riderId],
    )
  ).rows[0];
  if (!p) return { problems: [{ code: PROBLEM.PACKAGE_NOT_FOUND, message: 'That package does not belong to this rider.' }], balance: 0, found: false };
  if (p.status !== PACKAGE_STATUS.ACTIVE) problems.push({ code: PROBLEM.PACKAGE_NOT_ACTIVE, message: 'This package is not active.' });
  if (Number(p.validUntil) < occ.startsAt) problems.push({ code: PROBLEM.PACKAGE_EXPIRED, message: 'This package will have expired by this class.' });
  if (occ.format !== RIDE_FORMAT && !p.formats.includes(occ.format)) problems.push({ code: PROBLEM.PACKAGE_FORMAT_MISMATCH, message: 'This package cannot be used for this kind of class.' });
  return { problems, balance: p.balance as number, found: true };
}

export type Evaluation =
  | { kind: 'no_rider' }
  | { kind: 'wrong_branch' }
  | { kind: 'checked'; reasons: Reason[]; inClass: Booking[]; offered: number };

/** Every rule that decides whether this rider may take a place, returned together. Does not write anything. */
export async function evaluate(
  c: Tx,
  p: { occ: Occurrence & { branchId: string }; riderId: string; payWith: 'package' | 'office'; packageId?: string; now: number; policy: Policy; ownedBy?: string; ignoreWaitlist?: boolean },
): Promise<Evaluation> {
  const rider = await loadRiderFacts(c, p.riderId, p.now, p.ownedBy);
  if (!rider) return { kind: 'no_rider' };
  if (rider.branchId !== p.occ.branchId) return { kind: 'wrong_branch' };

  const riderBookings = await loadRiderBookings(c, p.riderId);
  const { inClass, offered } = await loadClassState(c, p.occ.id, p.now);
  const tz = (await c.query(`SELECT time_zone FROM branches WHERE id = $1`, [p.occ.branchId])).rows[0]?.time_zone as string;

  const problems: Reason[] = [];
  let packageBalance = 0;
  let packageMissing = false;
  if (p.payWith === PAY_WITH.PACKAGE) {
    const pk = await checkPackage(c, p.packageId as string, p.riderId, p.occ);
    problems.push(...pk.problems);
    packageBalance = pk.balance;
    packageMissing = !pk.found;
  }
  if (!p.ignoreWaitlist) {
    const waiting = await c.query(`SELECT 1 FROM waitlist_entries WHERE occurrence_id = $1 AND rider_id = $2 AND status = ANY($3)`, [
      p.occ.id, p.riderId, [WAITLIST_STATUS.ACTIVE, WAITLIST_STATUS.OFFERED],
    ]);
    if (waiting.rowCount) problems.push({ code: PROBLEM.ALREADY_WAITLISTED, message: 'This rider is already on the waitlist for this class. If you were offered a place, accept the offer instead.' });
  }
  const e = checkEligibility({ rider, occurrence: p.occ, now: p.now, policy: p.policy, payWith: p.payWith, packageBalance, riderBookings, dayKeyOf: dayKeyFor(tz) });
  // A missing package already has its own, clearer reason.
  const reasons = [...problems, ...e.reasons.filter((r) => !(r.code === 'NO_PACKAGE_BALANCE' && packageMissing))];
  return { kind: 'checked', reasons, inClass, offered };
}

/** Inserts the booking and, for a package, spends one class in the same transaction. The ledger guard refuses to go below zero. */
export async function insertBooking(
  c: Tx,
  p: { branchId: string; occurrenceId: string; riderId: string; status: string; payWith: 'package' | 'office'; packageId?: string; source: string; userId: string; now: number; policy: Policy },
): Promise<{ id: string; holdExpiresAt: string | null }> {
  const holdExpiresAt = p.status === BOOKING_STATUS.PENDING_OFFICE_PAYMENT ? new Date(p.now + p.policy.officeHoldMinutes * MS.minute).toISOString() : null;
  // Lock the package first. Inserting the booking takes a shared lock on it (the foreign key), and the ledger guard then asks for an
  // exclusive one: two bookings on the same package would each hold the shared lock and wait for the other, and the database
  // would end one of them with a deadlock error. Taking the exclusive lock up front makes them queue instead.
  if (p.payWith === PAY_WITH.PACKAGE) await c.query(`SELECT 1 FROM rider_packages WHERE id = $1 FOR UPDATE`, [p.packageId]);
  const ins = (
    await c.query(
      `INSERT INTO bookings (branch_id, occurrence_id, rider_id, status, pay_with, rider_package_id, source, created_by, hold_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.branchId, p.occurrenceId, p.riderId, p.status, p.payWith, p.payWith === PAY_WITH.PACKAGE ? p.packageId : null, p.source, p.userId, holdExpiresAt],
    )
  ).rows[0];
  if (p.payWith === PAY_WITH.PACKAGE) {
    await c.query(`INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key, booking_id, by_account) VALUES ($1,-1,$2,$3,$4,$5)`, [
      p.packageId, LEDGER_REASON.USE, `use:${ins.id}`, ins.id, p.userId,
    ]);
  }
  return { id: ins.id, holdExpiresAt };
}

/** Gives one class back to the package, once, however many times it is asked. */
export async function returnPackageClass(c: Tx, packageId: string, bookingId: string, byAccount: string | null) {
  await c.query(
    `INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key, booking_id, by_account) VALUES ($1,1,$2,$3,$4,$5)
     ON CONFLICT (rider_package_id, ref_key) DO NOTHING`,
    [packageId, LEDGER_REASON.RETURN, `return:${bookingId}`, bookingId, byAccount],
  );
}

/**
 * Offers freed places to the people waiting, in the order they joined. An offer holds the place for a limited time.
 * People who are no longer eligible (documents expired while they waited) are skipped but keep their place in line.
 * The caller must hold the class lock.
 */
export async function promoteWaitlist(c: Tx, occ: Occurrence & { branchId: string }, now: number, policy: Policy, actor: { id: string } | null) {
  const iso = new Date(now).toISOString();
  // Offers nobody answered go back to "expired" so the place can be offered on.
  await c.query(`UPDATE waitlist_entries SET status = $3 WHERE occurrence_id = $1 AND status = $2 AND offer_expires_at <= $4::timestamptz`, [
    occ.id, WAITLIST_STATUS.OFFERED, WAITLIST_STATUS.EXPIRED, iso,
  ]);
  if (occ.status !== OCCURRENCE_STATUS.PUBLISHED || occ.startsAt <= now) return [] as { entryId: string; riderId: string }[];
  await expireStaleHolds(c, occ.id, occ.branchId, now);

  const { inClass, offered } = await loadClassState(c, occ.id, now);
  let free = spotsLeft(occ, inClass, now, policy) - offered;
  const made: { entryId: string; riderId: string }[] = [];
  if (free <= 0) return made;

  const waiting = (await c.query(`SELECT id, rider_id AS "riderId" FROM waitlist_entries WHERE occurrence_id = $1 AND status = $2 ORDER BY joined_at, id`, [occ.id, WAITLIST_STATUS.ACTIVE])).rows;
  for (const w of waiting) {
    if (free <= 0) break;
    // Payment is chosen when the offer is accepted, so check everything except the package here.
    const ev = await evaluate(c, { occ, riderId: w.riderId, payWith: PAY_WITH.OFFICE, now, policy, ignoreWaitlist: true });
    if (ev.kind !== 'checked' || ev.reasons.length > 0) continue;
    const expires = new Date(now + policy.waitlistOfferMinutes * MS.minute).toISOString();
    await c.query(`UPDATE waitlist_entries SET status = $2, offered_at = $4::timestamptz, offer_expires_at = $3::timestamptz WHERE id = $1`, [w.id, WAITLIST_STATUS.OFFERED, expires, iso]);
    await queueForRider(c, w.riderId, { event: 'waitlist.offered', branchId: occ.branchId, occurrenceId: occ.id, dedupeKey: `waitlist:${w.id}:offered:${expires}`, data: { offerExpiresAt: expires } });
    await writeAudit(c, actor, occ.branchId, AUDIT.WAITLIST_OFFER, ENTITY.WAITLIST_ENTRY, w.id, { occurrenceId: occ.id, riderId: w.riderId, expiresAt: expires });
    made.push({ entryId: w.id, riderId: w.riderId });
    free--;
  }
  return made;
}
