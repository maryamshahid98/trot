import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { canOverride, MS, RecurrenceError, validateOccurrence, weeklySlots } from '@trot/domain';
import type { Blackout, Occurrence, Reason } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { parse } from '../common/validate.ts';
import { ACCOUNT_STATUS, AUDIT, ENTITY, LEAVE_STATUS, LIMITS, OCCURRENCE_STATUS, PG_ERROR, RIDE_FORMAT, ROLE, SCHEDULE_KIND } from '../config/constants.ts';
import { sessionHorses } from '../common/sql.ts';
import { DbService } from '../db/db.service.ts';
import { CreateClass, CreateSeries, ListQuery, OccurrenceId, PublishOccurrence, UpdateOccurrence } from './schedule.schemas.ts';
import { writeAudit } from '../common/audit.ts';
import { queueForRider } from '../notifications/outbox.ts';
import type { Tx } from '../bookings/core.ts';
import { pgErrorCode } from '../common/errors.ts';

const EPOCH_MS = (col: string) => `(extract(epoch from ${col}) * 1000)::bigint`;
const iso = (ms: number) => new Date(ms).toISOString();

/** The branch a request acts on: the one asked for if the user works there, or their only branch. */
function branchFor(requested: string | undefined, user: AuthUser): string {
  if (requested) {
    if (!user.branchIds.includes(requested)) throw new ForbiddenException('You do not work in that branch.');
    return requested;
  }
  if (user.branchIds.length === 1) return user.branchIds[0];
  if (user.branchIds.length === 0) throw new ForbiddenException('Your account is not linked to a branch.');
  throw new BadRequestException({ message: 'branchId is required.', problems: [{ field: 'branchId', message: 'is required for people who work in more than one branch' }] });
}

/** Everything needed to put a session on the schedule. A class and a ride both end up as one of these. */
export interface OccurrenceSpec {
  branchId?: string;
  title: string;
  arenaId: string;
  coachId: string;
  format: string;
  minLevel: string;
  status: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  priceMinor: number;
  override?: { reason: string };
  classTypeId?: string;
}
/** What a ride adds: it is run inside the same transaction, so the ride type it reads cannot change before the ride is saved. */
export interface RideFill {
  rideTypeId: string;
  minAgeYears: number | null;
  /** Column values copied onto the ride. */
  extra?: Record<string, unknown>;
  spec: Pick<OccurrenceSpec, 'title' | 'minLevel' | 'capacity' | 'priceMinor' | 'endsAt'>;
}
export type PrepareRide = (c: Tx, branchId: string, spec: OccurrenceSpec) => Promise<RideFill>;

@Injectable()
export class ScheduleService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListQuery, query);
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (to <= from) throw new BadRequestException({ message: 'The end must be after the start.', problems: [{ field: 'to', message: 'must be after from' }] });
    if (to - from > LIMITS.scheduleMaxRangeDays * MS.day) throw new BadRequestException({ message: `The date range may be at most ${LIMITS.scheduleMaxRangeDays} days.`, problems: [{ field: 'to', message: 'range too long' }] });
    const branchId = branchFor(q.branchId, user);

    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const r = await c.query(
        `SELECT o.id, o.title, o.format, o.min_level AS "minLevel", o.status, o.capacity,
                o.price_minor AS "priceMinor", o.arena_id AS "arenaId", a.name AS "arenaName",
                o.coach_id AS "coachId", ac.full_name AS "coachName",
                o.ride_type_id AS "rideTypeId", o.min_age_years AS "minAgeYears", o.series_id AS "seriesId",
                ${sessionHorses('o.id')} AS horses,
                (SELECT count(*)::int FROM bookings k WHERE k.occurrence_id = o.id
                    AND (k.status IN ('confirmed','checked_in','completed') OR (k.status = 'pending_office_payment' AND k.hold_expires_at > now()))) AS booked,
                lower(o.during) AS "startsAt", upper(o.during) AS "endsAt"
           FROM occurrences o
           JOIN arenas a ON a.id = o.arena_id
           JOIN accounts ac ON ac.id = o.coach_id
          WHERE o.branch_id = $1 AND o.during && tstzrange($2::timestamptz, $3::timestamptz)
            AND ($4::boolean = false OR o.status = $5)
            AND ($7::text IS NULL OR (CASE WHEN o.format = $8 THEN $9 ELSE $10 END) = $7)
            AND ($11::uuid IS NULL OR o.coach_id = $11)
          ORDER BY lower(o.during)
          LIMIT $6`,
        [branchId, iso(from), iso(to), user.role === ROLE.CUSTOMER, OCCURRENCE_STATUS.PUBLISHED, LIMITS.scheduleListLimit,
         q.kind ?? null, RIDE_FORMAT, SCHEDULE_KIND.RIDE, SCHEDULE_KIND.CLASS, user.role === ROLE.COACH ? user.id : null],
      );
      return r.rows;
    });
  }

  async create(body: unknown, user: AuthUser) {
    return this.createOccurrence(parse(CreateClass, body), user);
  }

  /** What the instructor's profile says against this session (INS-001, INS-002, BR-010). */
  private async instructorReasons(c: Tx, b: OccurrenceSpec, local: { from: string; to: string; day: string; dow: number; tz: string }, replacing?: string): Promise<Reason[]> {
    const p = (
      await c.query(
        `SELECT levels::text[] AS levels, formats::text[] AS formats, to_char(certification_expires, 'YYYY-MM-DD') AS "certExpires", work_days AS "workDays",
                to_char(work_from, 'HH24:MI') AS "workFrom", to_char(work_to, 'HH24:MI') AS "workTo", max_sessions_per_day AS "perDay"
           FROM staff_profiles WHERE account_id = $1`,
        [b.coachId],
      )
    ).rows[0];
    if (!p) return [];
    const out: Reason[] = [];
    const say = (code: string, message: string) => out.push({ code, message });
    if (!p.levels.includes(b.minLevel)) say('COACH_NOT_QUALIFIED', `The instructor is not qualified for ${b.minLevel} riders.`);
    if (p.formats.length && !p.formats.includes(b.format)) say('COACH_NOT_QUALIFIED_FORMAT', 'The instructor is not qualified for this kind of class or ride.');
    if (p.certExpires && p.certExpires < local.day) say('COACH_CERT_EXPIRED', `The instructor's certificate expires on ${p.certExpires}.`);
    if ((p.workDays.length && !p.workDays.includes(local.dow)) || (p.workFrom && (local.from < p.workFrom || local.to > p.workTo))) say('COACH_NOT_WORKING', 'This is outside the instructor\'s working pattern.');
    if (p.perDay) {
      const n = (
        await c.query(
          `SELECT count(*)::int AS n FROM occurrences WHERE coach_id = $1 AND status <> 'cancelled' AND ($4::uuid IS NULL OR id <> $4) AND to_char(lower(during) AT TIME ZONE $3, 'YYYY-MM-DD') = $2`,
          [b.coachId, local.day, local.tz, replacing ?? null],
        )
      ).rows[0].n as number;
      if (n + 1 > p.perDay) say('COACH_DAILY_LIMIT', `The instructor already has ${n} of ${p.perDay} sessions that day.`);
    }
    return out;
  }

  /**
   * Publishes a draft, or changes a session that has not started. The same clash, closure, leave, arena and opening-hours
   * checks as a new session run again. Moving the time or the arena frees the horses, so they are chosen again for the new slot.
   */
  async change(rawId: string, body: unknown, user: AuthUser, publish = false) {
    const { id } = parse(OccurrenceId, { id: rawId });
    const b: Partial<OccurrenceSpec> & { override?: { reason: string } } = publish ? parse(PublishOccurrence, body ?? {}) : parse(UpdateOccurrence, body);
    const override = b.override ? { reason: b.override.reason, byRole: user.role as 'reception' | 'manager' | 'owner', byUserId: user.id } : undefined;
    const refuse = (message: string, code: string) => new ConflictException({ message, problems: [{ code, message }] });

    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const o = (
          await c.query(
            `SELECT branch_id AS "branchId", title, format, min_level AS "minLevel", arena_id AS "arenaId", coach_id AS "coachId", capacity,
                    price_minor AS "priceMinor", status, ride_type_id AS "rideTypeId", ${EPOCH_MS('lower(during)')} AS "startsAt", ${EPOCH_MS('upper(during)')} AS "endsAt"
               FROM occurrences WHERE id = $1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!o) throw new NotFoundException('Class not found.');
        const was = { startsAt: Number(o.startsAt), endsAt: Number(o.endsAt) };
        if (o.status !== OCCURRENCE_STATUS.DRAFT && o.status !== OCCURRENCE_STATUS.PUBLISHED) throw refuse(`A ${o.status} session cannot be changed.`, 'NOT_EDITABLE');
        if (publish && o.status !== OCCURRENCE_STATUS.DRAFT) throw refuse('This is already published.', 'ALREADY_PUBLISHED');
        if (was.startsAt <= Date.now()) throw refuse('This session has already started.', 'ALREADY_STARTED');
        if (o.rideTypeId && (b.minLevel !== undefined || b.priceMinor !== undefined || b.endsAt !== undefined || b.title !== undefined)) {
          throw refuse('A ride takes its name, level, price and length from the ride type.', 'FIXED_BY_RIDE_TYPE');
        }
        const startsAt = b.startsAt ? Date.parse(b.startsAt) : was.startsAt;
        // Moving only the start keeps the length.
        const endsAt = b.endsAt ? Date.parse(b.endsAt) : startsAt + (was.endsAt - was.startsAt);
        const next: OccurrenceSpec = {
          title: b.title ?? o.title, format: o.format, minLevel: b.minLevel ?? o.minLevel, arenaId: b.arenaId ?? o.arenaId, coachId: b.coachId ?? o.coachId,
          capacity: b.capacity ?? o.capacity, priceMinor: b.priceMinor ?? o.priceMinor, status: publish ? OCCURRENCE_STATUS.PUBLISHED : o.status,
          startsAt: iso(startsAt), endsAt: iso(endsAt),
        };
        const booked = (
          await c.query(
            `SELECT rider_id AS "riderId" FROM bookings WHERE occurrence_id = $1 AND (status IN ('confirmed','checked_in') OR (status = 'pending_office_payment' AND hold_expires_at > now()))`,
            [id],
          )
        ).rows.map((r) => r.riderId as string);
        if (booked.length && (next.priceMinor !== o.priceMinor || next.minLevel !== o.minLevel)) throw refuse('Riders are already booked, so the price and level cannot change.', 'HAS_BOOKINGS');
        if (next.capacity < booked.length) throw refuse(`${booked.length} riders are booked. Places cannot be fewer than that.`, 'BELOW_BOOKED');
        const moved = startsAt !== was.startsAt || endsAt !== was.endsAt;
        if (moved && booked.length) {
          const clash = await c.query(
            `SELECT r.full_name AS name FROM bookings k JOIN occurrences x ON x.id = k.occurrence_id JOIN riders r ON r.id = k.rider_id
              WHERE k.rider_id = ANY($1::uuid[]) AND k.occurrence_id <> $2 AND k.status IN ('pending_office_payment','confirmed','checked_in') AND x.status <> 'cancelled'
                AND x.during && tstzrange($3::timestamptz, $4::timestamptz)`,
            [booked, id, next.startsAt, next.endsAt],
          );
          if (clash.rowCount) throw refuse(`These riders have another booking then: ${clash.rows.map((r) => r.name).join(', ')}.`, 'RIDER_OVERLAP');
        }
        // Free the horses first: their time slot belongs to the old plan.
        if (publish && (await c.query(`SELECT 1 FROM occurrences o WHERE o.id = $1 AND o.horse_required AND NOT EXISTS (SELECT 1 FROM horse_assignments h WHERE h.occurrence_id = o.id)`, [id])).rowCount) {
          throw refuse('Assign this ride’s horses before publishing it.', 'HORSE_REQUIRED');
        }
        const relocated = moved || next.arenaId !== o.arenaId;
        const horsesFreed = relocated ? ((await c.query(`DELETE FROM horse_assignments WHERE occurrence_id = $1`, [id])).rowCount ?? 0) : 0;
        const r = await this.place(c, o.branchId, next, user, override, undefined, { replacing: id });

        const old: Record<string, unknown> = { ...o, startsAt: iso(was.startsAt), endsAt: iso(was.endsAt) };
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const k of ['title', 'minLevel', 'arenaId', 'coachId', 'capacity', 'priceMinor', 'status', 'startsAt', 'endsAt'] as const) {
          if (old[k] !== next[k]) changes[k] = { from: old[k], to: next[k] };
        }
        await writeAudit(c, user, o.branchId, publish ? 'occurrence.publish' : 'occurrence.update', ENTITY.OCCURRENCE, id, { changes, overridden: r.overridden, reason: override?.reason ?? null });
        const material = relocated || next.coachId !== o.coachId;
        if (material) {
          for (const riderId of booked) await queueForRider(c, riderId, { event: 'class.changed', branchId: o.branchId, occurrenceId: id, dedupeKey: `occurrence:${id}:changed:${Date.now()}:${riderId}`, data: {} });
        }
        return { id, status: next.status, changed: Object.keys(changes), horsesFreed, ridersTold: material ? booked.length : 0 };
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.EXCLUSION_VIOLATION) throw new ConflictException('Someone else just booked that arena or coach at this time. Please check the schedule and try again.');
      throw e;
    }
  }

  /**
   * A class that repeats every 1 to 4 weeks, at the same clock time in the branch's time zone. Every date goes through the
   * same checks as a single class (clashes, closures, leave, override rules), all inside ONE transaction:
   *  - by default, if any date cannot be scheduled nothing is saved and the answer lists the dates that failed;
   *  - with skipConflicts, the dates that work are saved and the others are reported;
   *  - with dryRun, nothing is saved and the answer says what would happen.
   */
  async createSeries(body: unknown, user: AuthUser) {
    const b = parse(CreateSeries, body);
    const branchId = branchFor(b.branchId, user);
    const override = b.override ? { reason: b.override.reason, byRole: user.role as 'reception' | 'manager' | 'owner', byUserId: user.id } : undefined;

    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const tz = (await c.query(`SELECT time_zone FROM branches WHERE id = $1`, [branchId])).rows[0]?.time_zone as string | undefined;
      if (!tz) throw new BadRequestException('Unknown branch.');
      // A one-off visit is one dated session, by definition (BKG-013).
      if (b.classTypeId && (await c.query(`SELECT 1 FROM class_types WHERE id = $1 AND single_visit`, [b.classTypeId])).rowCount) {
        const message = 'A one-off Trial or Single Class cannot repeat.';
        throw new UnprocessableEntityException({ message, problems: [{ code: 'SINGLE_VISIT_NO_SERIES', message }] });
      }

      let slots;
      try {
        slots = weeklySlots({ startsAt: Date.parse(b.startsAt), endsAt: Date.parse(b.endsAt) }, { everyWeeks: b.repeat.everyWeeks, count: b.repeat.count, untilDate: b.repeat.until }, tz);
      } catch (e: unknown) {
        if (e instanceof RecurrenceError) throw new BadRequestException({ message: e.message, problems: [{ field: 'repeat', message: e.message }] });
        throw e;
      }

      let seriesId: string | undefined;
      if (!b.dryRun) {
        seriesId = (
          await c.query(
            `INSERT INTO schedule_series (branch_id, title, every_weeks, first_starts_at, session_count, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [branchId, b.title, b.repeat.everyWeeks, iso(slots[0].startsAt), slots.length, user.id],
          )
        ).rows[0].id as string;
      }

      const created: { id: string | null; startsAt: string; endsAt: string; overridden: boolean }[] = [];
      const skipped: { startsAt: string; endsAt: string; problems: unknown[] }[] = [];
      const { repeat: _repeat, skipConflicts: _skip, dryRun: _dry, ...single } = b;
      for (const slot of slots) {
        const spec: OccurrenceSpec = { ...single, startsAt: iso(slot.startsAt), endsAt: iso(slot.endsAt) };
        // A savepoint per date: a date the database itself refuses (two people scheduling at the same moment) must not spoil the others.
        await c.query('SAVEPOINT series_slot');
        try {
          const r = await this.place(c, branchId, spec, user, override, undefined, { seriesId, dryRun: b.dryRun });
          await c.query('RELEASE SAVEPOINT series_slot');
          created.push({ id: r.id, startsAt: spec.startsAt, endsAt: spec.endsAt, overridden: r.overridden });
        } catch (e: unknown) {
          await c.query('ROLLBACK TO SAVEPOINT series_slot');
          let problems: unknown[];
          if (e instanceof UnprocessableEntityException) problems = ((e.getResponse() as { problems?: unknown[] }).problems ?? []);
          else if (pgErrorCode(e) === PG_ERROR.EXCLUSION_VIOLATION) problems = [{ code: 'CLASH', message: 'Someone else just booked that arena or coach at this time.' }];
          else throw e;
          skipped.push({ startsAt: spec.startsAt, endsAt: spec.endsAt, problems });
        }
      }

      if (!b.dryRun && skipped.length > 0 && !b.skipConflicts) {
        throw new UnprocessableEntityException({
          message: `${skipped.length} of ${slots.length} dates cannot be scheduled, so nothing was saved. Fix them, or choose to skip the dates that clash.`,
          problems: skipped.map((s) => ({ date: s.startsAt, reasons: s.problems })),
        });
      }
      if (!b.dryRun && created.length === 0) throw new UnprocessableEntityException({ message: 'None of the dates can be scheduled.', problems: skipped.map((s) => ({ date: s.startsAt, reasons: s.problems })) });

      if (!b.dryRun) {
        await c.query(`UPDATE schedule_series SET session_count = $2 WHERE id = $1`, [seriesId, created.length]);
        await writeAudit(c, user, branchId, AUDIT.SERIES_CREATE, ENTITY.OCCURRENCE, seriesId as string, { title: b.title, everyWeeks: b.repeat.everyWeeks, created: created.length, skipped: skipped.length });
      }
      return { seriesId: seriesId ?? null, dryRun: b.dryRun, created, skipped };
    });
  }

  /**
   * The one place a class or a ride is put on the schedule, so both get the same clash, closure, leave and override checks.
   * For a ride, `prepareRide` fills in the price, length, level and minimum age from the ride type, inside the transaction.
   */
  async createOccurrence(input: OccurrenceSpec, user: AuthUser, prepareRide?: PrepareRide) {
    const branchId = branchFor(input.branchId, user);
    const override = input.override
      ? { reason: input.override.reason, byRole: user.role as 'reception' | 'manager' | 'owner', byUserId: user.id }
      : undefined;

    try {
      return await this.db.scoped({ branchIds: [branchId], role: user.role }, (c) => this.place(c, branchId, input, user, override, prepareRide));
    } catch (e: unknown) {
      // The database is the last line of defence if two people schedule at the same moment.
      if (pgErrorCode(e) === PG_ERROR.EXCLUSION_VIOLATION) throw new ConflictException('Someone else just booked that arena or coach at this time. Please check the schedule and try again.');
      if (pgErrorCode(e) === PG_ERROR.FOREIGN_KEY_VIOLATION) throw new BadRequestException('Unknown branch, arena or coach.');
      if (pgErrorCode(e) === PG_ERROR.INSUFFICIENT_PRIVILEGE) throw new ForbiddenException('That is outside the branches you may work in.');
      throw e;
    }
  }

  /**
   * Validates one session and, unless it is only a check, saves it. Runs inside the caller's transaction, so a whole series
   * can be placed in one go. Throws UnprocessableEntityException (with the reasons) when the session cannot be scheduled.
   */
  private async place(
    c: Tx, branchId: string, input: OccurrenceSpec, user: AuthUser,
    override: { reason: string; byRole: 'reception' | 'manager' | 'owner'; byUserId: string } | undefined,
    prepareRide?: PrepareRide, extra: { seriesId?: string; dryRun?: boolean; replacing?: string } = {},
  ): Promise<{ id: string | null; overridden: boolean; problems: Reason[] }> {
    let b: OccurrenceSpec = input;
    let rideTypeId: string | null = null;
    let minAgeYears: number | null = null;
    let copied: Record<string, unknown> = {};
    if (prepareRide) {
      const fill = await prepareRide(c, branchId, input);
      b = { ...input, ...fill.spec };
      rideTypeId = fill.rideTypeId;
      minAgeYears = fill.minAgeYears;
      copied = fill.extra ?? {};
    }
    const startsAt = Date.parse(b.startsAt);
    const endsAt = Date.parse(b.endsAt);
    const from = iso(Math.min(startsAt, endsAt));
    const to = iso(Math.max(startsAt, endsAt));

    // The arena and the coach must belong to this branch (row-level security hides other branches' arenas).
    const arena = (
      await c.query(`SELECT max_capacity AS "maxCapacity", supported_levels::text[] AS levels, shared_use AS shared, to_char(opens_at, 'HH24:MI') AS "opensAt", to_char(closes_at, 'HH24:MI') AS "closesAt" FROM arenas WHERE id = $1 AND branch_id = $2`, [b.arenaId, branchId])
    ).rows[0];
    if (!arena) throw new BadRequestException('Unknown arena for this branch.');
    const coach = await c.query(
      `SELECT 1 FROM accounts a JOIN account_branches ab ON ab.account_id = a.id
        WHERE a.id = $1 AND ab.branch_id = $2 AND a.role = $3 AND a.status = $4`,
      [b.coachId, branchId, ROLE.COACH, ACCOUNT_STATUS.ACTIVE],
    );
    if (coach.rowCount === 0) throw new BadRequestException('Unknown coach for this branch.');

    const existingRows = await c.query(
      `SELECT id, ${EPOCH_MS('lower(during)')} AS "startsAt", ${EPOCH_MS('upper(during)')} AS "endsAt",
              capacity, arena_id AS "arenaId", coach_id AS "coachId", min_level AS "minLevel",
              status, format, price_minor AS "priceMinor"
         FROM occurrences
        WHERE branch_id = $1 AND status <> $4
          AND during && tstzrange($2::timestamptz, $3::timestamptz)`,
      [branchId, from, to, OCCURRENCE_STATUS.CANCELLED],
    );
    const existing: Occurrence[] = existingRows.rows.map((o) => ({ ...(o as Omit<Occurrence, 'startsAt' | 'endsAt'>), startsAt: Number(o.startsAt), endsAt: Number(o.endsAt) }));

    const closures = await c.query(
      `SELECT id, arena_id AS "targetId", ${EPOCH_MS('lower(during)')} AS "from", ${EPOCH_MS('upper(during)')} AS "to"
         FROM arena_closures WHERE arena_id = $1 AND during && tstzrange($2::timestamptz, $3::timestamptz)`,
      [b.arenaId, from, to],
    );
    const leave = await c.query(
      `SELECT id, staff_account_id AS "targetId", ${EPOCH_MS('lower(during)')} AS "from", ${EPOCH_MS('upper(during)')} AS "to"
         FROM staff_unavailability
        WHERE staff_account_id = $1 AND status = $4 AND during && tstzrange($2::timestamptz, $3::timestamptz)`,
      [b.coachId, from, to, LEAVE_STATUS.APPROVED],
    );
    const blackouts: Blackout[] = [
      ...closures.rows.map((r) => ({ id: r.id, kind: 'arena_closure' as const, targetId: r.targetId, from: Number(r.from), to: Number(r.to) })),
      ...leave.rows.map((r) => ({ id: r.id, kind: 'coach_unavailable' as const, targetId: r.targetId, from: Number(r.from), to: Number(r.to) })),
    ];

    // Opening hours and holidays are read on the branch's own clock.
    const open = (
      await c.query(
        `SELECT (opens_at IS NOT NULL AND (($1::timestamptz AT TIME ZONE time_zone)::time < opens_at
                  OR ($2::timestamptz AT TIME ZONE time_zone)::time > closes_at
                  OR ($2::timestamptz AT TIME ZONE time_zone)::date <> ($1::timestamptz AT TIME ZONE time_zone)::date)) AS outside,
                (($1::timestamptz AT TIME ZONE time_zone)::date = ANY(holidays)) AS holiday
           FROM branches WHERE id = $3`,
        [from, to, branchId],
      )
    ).rows[0];

    // The session's day and clock times as the branch sees them.
    const local = (
      await c.query(
        `SELECT to_char($1::timestamptz AT TIME ZONE time_zone, 'HH24:MI') AS "from", to_char($2::timestamptz AT TIME ZONE time_zone, 'HH24:MI') AS "to",
                to_char($1::timestamptz AT TIME ZONE time_zone, 'YYYY-MM-DD') AS day, extract(dow FROM $1::timestamptz AT TIME ZONE time_zone)::int AS dow, time_zone AS tz
           FROM branches WHERE id = $3`,
        [from, to, branchId],
      )
    ).rows[0];
    let typeCapacity: number | undefined;
    if (b.classTypeId && !extra.replacing) {
      const t = (await c.query(`SELECT format::text AS format, capacity, min_age_years AS "minAge", max_age_years AS "maxAge", cancel_hours AS "cancelHours", single_visit AS "singleVisit", active FROM class_types WHERE id = $1 AND branch_id = $2`, [b.classTypeId, branchId])).rows[0];
      if (!t || !t.active) throw new BadRequestException('That class type is not available in this branch.');
      b = { ...b, format: t.format };
      minAgeYears = t.minAge;
      typeCapacity = t.capacity;
      copied = { class_type_id: b.classTypeId, max_age_years: t.maxAge, cancel_hours: t.cancelHours, single_visit: t.singleVisit };
    }
    const formatReasons: Reason[] = [];
    if (b.format === 'private' && b.capacity > 1) formatReasons.push({ code: 'FORMAT_CAPACITY', message: 'A private class takes one rider.' });
    if (b.format === 'semi_private' && b.capacity > 3) formatReasons.push({ code: 'FORMAT_CAPACITY', message: 'A semi-private class takes at most three riders.' });
    if (typeCapacity !== undefined && b.capacity > typeCapacity) formatReasons.push({ code: 'CLASS_TYPE_CAPACITY', message: `This class type takes at most ${typeCapacity} riders.` });
    const extraReasons = await this.instructorReasons(c, b, local as { from: string; to: string; day: string; dow: number; tz: string }, extra.replacing);

    const reasons = validateOccurrence(
      { id: extra.replacing ?? 'new', startsAt, endsAt, capacity: b.capacity, arenaId: b.arenaId, coachId: b.coachId }, existing, blackouts,
      { arenaCapacity: arena.maxCapacity, arenaLevels: arena.levels, minLevel: b.minLevel, outsideOpeningHours: open?.outside === true, onHoliday: open?.holiday === true, now: Date.now(),
        arenaShared: arena.shared === true, outsideArenaHours: arena.opensAt !== null && (local.from < arena.opensAt || local.to > arena.closesAt), extra: [...formatReasons, ...extraReasons] },
    );
    const decision = canOverride(reasons, override);
    if (!decision.ok) {
      throw new UnprocessableEntityException({ message: decision.message ?? 'This class cannot be scheduled.', problems: reasons });
    }
    const overridden = reasons.length > 0;
    if (extra.dryRun) return { id: null as string | null, overridden, problems: reasons }; // a check only: nothing is saved

    if (extra.replacing) {
      // Changing or publishing a session that exists: the same checks, then the row is updated and its override record replaced.
      await c.query(
        `UPDATE occurrences SET title = $2, min_level = $3, arena_id = $4, coach_id = $5, during = tstzrange($6::timestamptz,$7::timestamptz), capacity = $8, price_minor = $9, status = $10, allow_overlap = $11, shared_arena = $12 WHERE id = $1`,
        [extra.replacing, b.title, b.minLevel, b.arenaId, b.coachId, iso(startsAt), iso(endsAt), b.capacity, b.priceMinor, b.status, overridden, arena.shared === true],
      );
      await c.query(`DELETE FROM occurrence_overrides WHERE occurrence_id = $1`, [extra.replacing]);
      if (overridden && override) {
        await c.query(`INSERT INTO occurrence_overrides (occurrence_id, codes, reason, approved_by) VALUES ($1,$2,$3,$4)`, [extra.replacing, reasons.map((r) => r.code), override.reason, override.byUserId]);
      }
      return { id: extra.replacing, overridden, problems: reasons };
    }

    // A shared arena is checked by places, not by time, so the database must not refuse the second session.
    const ins = await c.query(
      `INSERT INTO occurrences (branch_id, title, format, min_level, arena_id, coach_id, during, capacity, price_minor, status, allow_overlap, ride_type_id, min_age_years, series_id)
       VALUES ($1,$2,$3,$4,$5,$6,tstzrange($7::timestamptz,$8::timestamptz),$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [branchId, b.title, b.format, b.minLevel, b.arenaId, b.coachId, iso(startsAt), iso(endsAt), b.capacity, b.priceMinor, b.status, overridden || arena.shared === true, rideTypeId, minAgeYears, extra.seriesId ?? null],
    );
    const id: string = ins.rows[0].id;
    if (arena.shared === true) await c.query(`UPDATE occurrences SET shared_arena = true, allow_overlap = $2 WHERE id = $1`, [id, overridden]);
    const cols = Object.keys(copied); // names come from this file and the ride service, never from the caller
    if (cols.length) await c.query(`UPDATE occurrences SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map((k) => copied[k])]);
    if (overridden && override) {
      await c.query(`INSERT INTO occurrence_overrides (occurrence_id, codes, reason, approved_by) VALUES ($1,$2,$3,$4)`, [
        id, reasons.map((r) => r.code), override.reason, override.byUserId,
      ]);
    }
    await writeAudit(c, user, branchId, overridden ? AUDIT.OCCURRENCE_CREATE_OVERRIDE : AUDIT.OCCURRENCE_CREATE, ENTITY.OCCURRENCE, id, { title: b.title, format: b.format, rideTypeId, overridden, problems: reasons.map((r) => r.code) });
    return { id, overridden, problems: reasons };
  }

}
