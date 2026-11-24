import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { canOverride, MS, validateOccurrence } from '@trot/domain';
import type { Blackout, Occurrence } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { parse } from '../common/validate.ts';
import { ACCOUNT_STATUS, AUDIT, ENTITY, LEAVE_STATUS, LIMITS, OCCURRENCE_STATUS, PG_ERROR, RIDE_FORMAT, ROLE, SCHEDULE_KIND } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { CreateClass, ListQuery } from './schedule.schemas.ts';
import type { Tx } from '../bookings/core.ts';

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
}
/** What a ride adds: it is run inside the same transaction, so the ride type it reads cannot change before the ride is saved. */
export interface RideFill {
  rideTypeId: string;
  minAgeYears: number | null;
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
                o.ride_type_id AS "rideTypeId", o.min_age_years AS "minAgeYears",
                lower(o.during) AS "startsAt", upper(o.during) AS "endsAt"
           FROM occurrences o
           JOIN arenas a ON a.id = o.arena_id
           JOIN accounts ac ON ac.id = o.coach_id
          WHERE o.branch_id = $1 AND o.during && tstzrange($2::timestamptz, $3::timestamptz)
            AND ($4::boolean = false OR o.status = $5)
            AND ($7::text IS NULL OR (CASE WHEN o.format = $8 THEN $9 ELSE $10 END) = $7)
          ORDER BY lower(o.during)
          LIMIT $6`,
        [branchId, iso(from), iso(to), user.role === ROLE.CUSTOMER, OCCURRENCE_STATUS.PUBLISHED, LIMITS.scheduleListLimit,
         q.kind ?? null, RIDE_FORMAT, SCHEDULE_KIND.RIDE, SCHEDULE_KIND.CLASS],
      );
      return r.rows;
    });
  }

  async create(body: unknown, user: AuthUser) {
    return this.createOccurrence(parse(CreateClass, body), user);
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
      return await this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
        let b: OccurrenceSpec = input;
        let rideTypeId: string | null = null;
        let minAgeYears: number | null = null;
        if (prepareRide) {
          const fill = await prepareRide(c, branchId, input);
          b = { ...input, ...fill.spec };
          rideTypeId = fill.rideTypeId;
          minAgeYears = fill.minAgeYears;
        }
        const startsAt = Date.parse(b.startsAt);
        const endsAt = Date.parse(b.endsAt);
        const from = iso(Math.min(startsAt, endsAt));
        const to = iso(Math.max(startsAt, endsAt));

        // The arena and the coach must belong to this branch (row-level security hides other branches' arenas).
        const arena = await c.query(`SELECT 1 FROM arenas WHERE id = $1`, [b.arenaId]);
        if (arena.rowCount === 0) throw new BadRequestException('Unknown arena for this branch.');
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
        const existing: Occurrence[] = existingRows.rows.map((o: any) => ({ ...o, startsAt: Number(o.startsAt), endsAt: Number(o.endsAt) }));

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
          ...closures.rows.map((r: any) => ({ id: r.id, kind: 'arena_closure' as const, targetId: r.targetId, from: Number(r.from), to: Number(r.to) })),
          ...leave.rows.map((r: any) => ({ id: r.id, kind: 'coach_unavailable' as const, targetId: r.targetId, from: Number(r.from), to: Number(r.to) })),
        ];

        const reasons = validateOccurrence({ id: 'new', startsAt, endsAt, capacity: b.capacity, arenaId: b.arenaId, coachId: b.coachId }, existing, blackouts);
        const decision = canOverride(reasons, override);
        if (!decision.ok) {
          throw new UnprocessableEntityException({ message: decision.message ?? 'This class cannot be scheduled.', problems: reasons });
        }
        const overridden = reasons.length > 0;

        const ins = await c.query(
          `INSERT INTO occurrences (branch_id, title, format, min_level, arena_id, coach_id, during, capacity, price_minor, status, allow_overlap, ride_type_id, min_age_years)
           VALUES ($1,$2,$3,$4,$5,$6,tstzrange($7::timestamptz,$8::timestamptz),$9,$10,$11,$12,$13,$14) RETURNING id`,
          [branchId, b.title, b.format, b.minLevel, b.arenaId, b.coachId, iso(startsAt), iso(endsAt), b.capacity, b.priceMinor, b.status, overridden, rideTypeId, minAgeYears],
        );
        const id: string = ins.rows[0].id;
        if (overridden && override) {
          await c.query(`INSERT INTO occurrence_overrides (occurrence_id, codes, reason, approved_by) VALUES ($1,$2,$3,$4)`, [
            id, reasons.map((r) => r.code), override.reason, override.byUserId,
          ]);
        }
        await c.query(
          `INSERT INTO audit_log (actor_account_id, branch_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
          [user.id, branchId, overridden ? AUDIT.OCCURRENCE_CREATE_OVERRIDE : AUDIT.OCCURRENCE_CREATE, ENTITY.OCCURRENCE, id,
           JSON.stringify({ title: b.title, format: b.format, rideTypeId, overridden, problems: reasons.map((r) => r.code) })],
        );
        return { id, overridden, problems: reasons };
      });
    } catch (e: any) {
      // The database is the last line of defence if two people schedule at the same moment.
      if (e?.code === PG_ERROR.EXCLUSION_VIOLATION) throw new ConflictException('Someone else just booked that arena or coach at this time. Please check the schedule and try again.');
      if (e?.code === PG_ERROR.FOREIGN_KEY_VIOLATION) throw new BadRequestException('Unknown branch, arena or coach.');
      if (e?.code === PG_ERROR.INSUFFICIENT_PRIVILEGE) throw new ForbiddenException('That is outside the branches you may work in.');
      throw e;
    }
  }
}
