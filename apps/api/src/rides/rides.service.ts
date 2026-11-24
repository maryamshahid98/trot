import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { MS } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, LIMITS, PG_ERROR, RIDE_FORMAT, RIDE_PROBLEM, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { ScheduleService } from '../schedule/schedule.service.ts';
import type { PrepareRide } from '../schedule/schedule.service.ts';
import { CreateRide, CreateRideType, IdParam, ListRideTypes, UpdateRideType } from './rides.schemas.ts';
import { pgErrorCode } from '../common/errors.ts';

const problem = (message: string, code: string, field?: string) => ({ message, problems: [{ code, ...(field ? { field } : {}), message }] });
const COLUMNS = `id, branch_id AS "branchId", name, description, price_minor AS "priceMinor", duration_minutes AS "durationMinutes", capacity,
  min_level AS "minLevel", min_age_years AS "minAgeYears", active, to_char(active_from, 'YYYY-MM-DD') AS "activeFrom", to_char(active_to, 'YYYY-MM-DD') AS "activeTo"`;

/** Request field -> column. Only these names are ever put into the UPDATE, never anything the caller typed. */
const COLUMN_OF: Record<string, string> = {
  name: 'name', description: 'description', priceMinor: 'price_minor', durationMinutes: 'duration_minutes', capacity: 'capacity',
  minLevel: 'min_level', minAgeYears: 'min_age_years', active: 'active', activeFrom: 'active_from', activeTo: 'active_to',
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
                  to_char(active_from, 'YYYY-MM-DD') AS "activeFrom", to_char(active_to, 'YYYY-MM-DD') AS "activeTo"
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
      return {
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
