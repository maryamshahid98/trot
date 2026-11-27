import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { MS } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, LIMITS, OCCURRENCE_STATUS, PG_ERROR, RIDE_FORMAT, RIDE_PROBLEM, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { ScheduleService } from '../schedule/schedule.service.ts';
import type { PrepareRide } from '../schedule/schedule.service.ts';
import { AddRate, CreateRide, CreateRideType, IdParam, ListRideTypes, UpdateRideType } from './rides.schemas.ts';
import { pgErrorCode } from '../common/errors.ts';

const problem = (message: string, code: string, field?: string) => ({ message, problems: [{ code, ...(field ? { field } : {}), message }] });
const COLUMNS = `id, branch_id AS "branchId", name, description, price_minor AS "priceMinor", duration_minutes AS "durationMinutes", capacity,
  min_level AS "minLevel", min_age_years AS "minAgeYears", active, to_char(active_from, 'YYYY-MM-DD') AS "activeFrom", to_char(active_to, 'YYYY-MM-DD') AS "activeTo",
  arena_id AS "arenaId", max_rider_weight_kg AS "maxRiderWeightKg", book_until_hours AS "bookUntilHours", cancel_hours AS "cancelHours", horse_required AS "horseRequired",
  (SELECT coalesce(json_agg(json_build_object('id', r.id, 'fromDate', to_char(r.from_date, 'YYYY-MM-DD'), 'priceMinor', r.price_minor, 'durationMinutes', r.duration_minutes) ORDER BY r.from_date), '[]') FROM ride_rates r WHERE r.ride_type_id = ride_types.id) AS rates`;
const EXTRA: Record<string, string> = { arenaId: 'arena_id', maxRiderWeightKg: 'max_rider_weight_kg', bookUntilHours: 'book_until_hours', cancelHours: 'cancel_hours', horseRequired: 'horse_required' };

/** Request field -> column. Only these names are ever put into the UPDATE, never anything the caller typed. */
const COLUMN_OF: Record<string, string> = {
  name: 'name', description: 'description', priceMinor: 'price_minor', durationMinutes: 'duration_minutes', capacity: 'capacity',
  minLevel: 'min_level', minAgeYears: 'min_age_years', active: 'active', activeFrom: 'active_from', activeTo: 'active_to', ...EXTRA,
};
/** Changing any of these never touches a ride that is already scheduled: the ride holds its own copy. */
const NOTE = 'Rides already scheduled keep the price, length and rules they were scheduled with.';

function checkDates(from: string | null | undefined, to: string | null | undefined) {
  if (from && to && to < from) throw new BadRequestException(problem('The last day must not be before the first day.', RIDE_PROBLEM.BAD_DATES, 'activeTo'));
}

@Injectable()
export class RidesService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ScheduleService) private readonly schedules: ScheduleService,
  ) {}

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListRideTypes, query);
    const branchId = branchFor(q.branchId, user);
    // A customer only ever sees what is on sale, whatever they ask for.
    const all = user.role !== ROLE.CUSTOMER && q.includeInactive === 'true';
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const rows = (await c.query(`SELECT ${COLUMNS} FROM ride_types WHERE branch_id = $1 AND ($2::boolean OR active) ORDER BY lower(name) LIMIT $3`, [branchId, all, LIMITS.rideTypesListMax])).rows;
      return { rideTypes: rows };
    });
  }

  async get(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const row = (await c.query(`SELECT ${COLUMNS} FROM ride_types WHERE id = $1 AND ($2::boolean OR active)`, [id, user.role !== ROLE.CUSTOMER])).rows[0];
      if (!row) throw new NotFoundException('Ride type not found.');
      return row;
    });
  }

  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateRideType, body);
    const branchId = branchFor(b.branchId, user);
    checkDates(b.activeFrom, b.activeTo);
    try {
      return await this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
        const id: string = (
          await c.query(
            `INSERT INTO ride_types (branch_id, name, description, price_minor, duration_minutes, capacity, min_level, min_age_years, active_from, active_to)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [branchId, b.name, b.description ?? null, b.priceMinor, b.durationMinutes, b.capacity, b.minLevel, b.minAgeYears ?? null, b.activeFrom ?? null, b.activeTo ?? null],
          )
        ).rows[0].id;
        const given = b as Record<string, unknown>;
        const keys = Object.keys(EXTRA).filter((k) => given[k] !== undefined);
        if (keys.length) await c.query(`UPDATE ride_types SET ${keys.map((k, i) => `${EXTRA[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => given[k])]);
        await writeAudit(c, user, branchId, AUDIT.RIDE_TYPE_CREATE, ENTITY.RIDE_TYPE, id, { name: b.name, priceMinor: b.priceMinor, durationMinutes: b.durationMinutes, capacity: b.capacity });
        return { id };
      });
    } catch (e: unknown) {
      throw this.dbError(e);
    }
  }

  async update(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(UpdateRideType, body);
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const row = (await c.query(`SELECT ${COLUMNS} FROM ride_types WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!row) throw new NotFoundException('Ride type not found.');
        const next = { ...row, ...b };
        checkDates(next.activeFrom, next.activeTo);

        const keys = Object.keys(b).filter((k) => k in COLUMN_OF);
        const sets = keys.map((k, i) => `${COLUMN_OF[k]} = $${i + 2}`);
        await c.query(`UPDATE ride_types SET ${sets.join(', ')} WHERE id = $1`, [id, ...keys.map((k) => (b as Record<string, unknown>)[k])]);
        const changed = keys.filter((k) => (b as Record<string, unknown>)[k] !== row[k]);
        // Money and safety settings are recorded with their old and new value. Free text is not copied into the log.
        const detail: Record<string, unknown> = { changed };
        for (const k of ['priceMinor', 'durationMinutes', 'capacity', 'minLevel', 'minAgeYears', 'active', 'activeFrom', 'activeTo']) {
          if (changed.includes(k)) detail[k] = { from: row[k], to: (b as Record<string, unknown>)[k] };
        }
        await writeAudit(c, user, row.branchId, AUDIT.RIDE_TYPE_UPDATE, ENTITY.RIDE_TYPE, id, detail);
        return { id, changed, note: NOTE };
      });
    } catch (e: unknown) {
      throw this.dbError(e);
    }
  }

  async addRate(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(AddRate, body);
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const t = (await c.query(`SELECT branch_id AS "branchId" FROM ride_types WHERE id = $1`, [id])).rows[0];
        if (!t) throw new NotFoundException('Ride type not found.');
        const made: string = (await c.query(`INSERT INTO ride_rates (ride_type_id, from_date, price_minor, duration_minutes) VALUES ($1,$2,$3,$4) RETURNING id`, [id, b.fromDate, b.priceMinor, b.durationMinutes])).rows[0].id;
        await writeAudit(c, user, t.branchId, 'ride_type.rate_add', ENTITY.RIDE_TYPE, id, { fromDate: b.fromDate, priceMinor: b.priceMinor, durationMinutes: b.durationMinutes });
        return { id: made };
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException(problem('There is already a rate from that day.', 'RATE_EXISTS', 'fromDate'));
      throw e;
    }
  }

  async removeRate(rawId: string, rawRateId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { id: rateId } = parse(IdParam, { id: rawRateId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const t = (await c.query(`SELECT branch_id AS "branchId" FROM ride_types WHERE id = $1`, [id])).rows[0];
      if (!t || !(await c.query(`DELETE FROM ride_rates WHERE id = $1 AND ride_type_id = $2`, [rateId, id])).rowCount) throw new NotFoundException('Rate not found.');
      await writeAudit(c, user, t.branchId, 'ride_type.rate_remove', ENTITY.RIDE_TYPE, id, { rateId });
      return { id: rateId, removed: true };
    });
  }

  /**
   * Schedules one ride from a ride type. The ride copies the type's price, length, level and minimum age,
   * then goes through the same checks as a class: location and guide must be free, open and in this branch.
   */
  async schedule(body: unknown, user: AuthUser) {
    const b = parse(CreateRide, body);
    const startsAtMs = Date.parse(b.startsAt);

    const prepare: PrepareRide = async (c, branchId) => {
      const t = (
        await c.query(
          `SELECT id, name, price_minor AS "priceMinor", duration_minutes AS "durationMinutes", capacity, min_level AS "minLevel", min_age_years AS "minAgeYears", active,
                  to_char(active_from, 'YYYY-MM-DD') AS "activeFrom", to_char(active_to, 'YYYY-MM-DD') AS "activeTo",
                  max_rider_weight_kg AS "maxRiderWeightKg", book_until_hours AS "bookUntilHours", cancel_hours AS "cancelHours", horse_required AS "horseRequired"
             FROM ride_types WHERE id = $1 AND branch_id = $2 FOR SHARE`,
          [b.rideTypeId, branchId],
        )
      ).rows[0];
      if (!t) throw new NotFoundException(problem('That ride type does not exist in this branch.', RIDE_PROBLEM.RIDE_TYPE_NOT_FOUND, 'rideTypeId'));
      if (!t.active) throw new UnprocessableEntityException(problem('This ride type is switched off.', RIDE_PROBLEM.RIDE_TYPE_INACTIVE, 'rideTypeId'));

      // "Open from / until" are calendar days on the branch's own clock.
      const day: string = (
        await c.query(`SELECT to_char(($1::timestamptz AT TIME ZONE time_zone), 'YYYY-MM-DD') AS d FROM branches WHERE id = $2`, [new Date(startsAtMs).toISOString(), branchId])
      ).rows[0].d;
      if ((t.activeFrom && day < t.activeFrom) || (t.activeTo && day > t.activeTo)) {
        throw new UnprocessableEntityException(problem(`This ride type is only offered from ${t.activeFrom ?? 'the start'} to ${t.activeTo ?? 'no end date'}.`, RIDE_PROBLEM.OUTSIDE_ACTIVE_DATES, 'startsAt'));
      }
      if (b.capacity !== undefined && b.capacity > t.capacity) {
        throw new UnprocessableEntityException(problem(`This ride type takes at most ${t.capacity} riders.`, RIDE_PROBLEM.CAPACITY_OVER_TYPE, 'capacity'));
      }
      // Horses are assigned to a ride that exists, so a ride that needs them starts as a draft (RIDE-003).
      if (t.horseRequired && b.status === OCCURRENCE_STATUS.PUBLISHED) {
        throw new UnprocessableEntityException(problem('Save this ride as a draft, assign its horses, then publish it.', 'HORSE_REQUIRED', 'status'));
      }
      const rate = (await c.query(`SELECT price_minor AS "priceMinor", duration_minutes AS "durationMinutes" FROM ride_rates WHERE ride_type_id = $1 AND from_date <= $2 ORDER BY from_date DESC LIMIT 1`, [t.id, day])).rows[0];
      if (rate) Object.assign(t, rate);
      return {
        extra: { max_rider_weight_kg: t.maxRiderWeightKg, book_until_hours: t.bookUntilHours, cancel_hours: t.cancelHours, horse_required: t.horseRequired },
        rideTypeId: t.id,
        minAgeYears: t.minAgeYears,
        spec: {
          title: t.name,
          minLevel: t.minLevel,
          capacity: b.capacity ?? t.capacity,
          priceMinor: t.priceMinor,
          endsAt: new Date(startsAtMs + t.durationMinutes * MS.minute).toISOString(),
        },
      };
    };

    return this.schedules.createOccurrence(
      {
        branchId: b.branchId, title: '', arenaId: b.arenaId, coachId: b.coachId, format: RIDE_FORMAT, minLevel: 'beginner', status: b.status,
        startsAt: b.startsAt, endsAt: b.startsAt, capacity: 1, priceMinor: 0, override: b.override,
      },
      user,
      prepare,
    );
  }

  private dbError(e: unknown) {
    if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) return new ConflictException(problem('This branch already has a ride type with that name.', RIDE_PROBLEM.NAME_TAKEN, 'name'));
    if (pgErrorCode(e) === PG_ERROR.INSUFFICIENT_PRIVILEGE) return new ForbiddenException('That is outside the branches you may work in.');
    return e;
  }
}
