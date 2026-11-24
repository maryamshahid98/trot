import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { MS } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { epochMs } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, HORSE_PROBLEM, HORSE_STATUS, LIMITS, OCCURRENCE_STATUS, PG_ERROR, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import type { Tx } from '../bookings/core.ts';
import { CreateHorse, IdParam, ListHorses, SetHorseStatus, UpdateHorse, WorkloadQuery } from './horses.schemas.ts';
import { pgErrorCode } from '../common/errors.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const HORSE_COLS = `h.id, h.name, h.status, h.suitable_levels::text[] AS "suitableLevels", h.notes,
  coalesce(array(SELECT ha.arena_id FROM horse_arenas ha WHERE ha.horse_id = h.id ORDER BY ha.arena_id), '{}') AS "arenaIds"`;
const iso = (ms: number) => new Date(ms).toISOString();

@Injectable()
export class HorsesService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private async arenasInBranch(c: Tx, branchId: string, arenaIds: string[]) {
    if (arenaIds.length === 0) return;
    const n = (await c.query(`SELECT count(*)::int AS n FROM arenas WHERE branch_id = $1 AND id = ANY($2::uuid[])`, [branchId, arenaIds])).rows[0].n;
    if (n !== arenaIds.length) throw new UnprocessableEntityException(problem('One of those arenas does not belong to this branch.', HORSE_PROBLEM.ARENA_NOT_IN_BRANCH));
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListHorses, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => ({
      horses: (
        await c.query(
          `SELECT ${HORSE_COLS} FROM horses h WHERE h.branch_id = $1 AND ($2::horse_status IS NULL OR h.status = $2)
              AND ($3::text IS NULL OR h.name ILIKE $3 ESCAPE '\\') ORDER BY h.name LIMIT $4`,
          [branchId, q.status ?? null, q.q ? likePattern(q.q) : null, LIMITS.horseListMax],
        )
      ).rows,
    }));
  }

  async get(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const h = (await c.query(`SELECT ${HORSE_COLS} FROM horses h WHERE h.id = $1`, [id])).rows[0];
      if (!h) throw new NotFoundException(problem('Horse not found.', HORSE_PROBLEM.HORSE_NOT_FOUND));
      return h;
    });
  }

  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateHorse, body);
    const branchId = branchFor(b.branchId, user);
    try {
      return await this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
        await this.arenasInBranch(c, branchId, b.arenaIds);
        const id: string = (await c.query(`INSERT INTO horses (branch_id, name, suitable_levels, notes) VALUES ($1,$2,$3::level[],$4) RETURNING id`, [branchId, b.name, b.suitableLevels, b.notes ?? null])).rows[0].id;
        for (const a of b.arenaIds) await c.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [id, a]);
        await writeAudit(c, user, branchId, AUDIT.HORSE_CREATE, ENTITY.HORSE, id, { name: b.name });
        return { id };
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException('A horse with that name already exists in this branch.');
      throw e;
    }
  }

  async update(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(UpdateHorse, body);
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const h = (await c.query(`SELECT id, branch_id AS "branchId", status FROM horses WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!h) throw new NotFoundException(problem('Horse not found.', HORSE_PROBLEM.HORSE_NOT_FOUND));
        if (h.status === HORSE_STATUS.RETIRED) throw new ConflictException(problem('A retired horse cannot be edited.', HORSE_PROBLEM.HORSE_RETIRED));
        const sets: string[] = [];
        const params: unknown[] = [id];
        const col = { name: 'name = $', suitableLevels: 'suitable_levels = $', notes: 'notes = $' } as const;
        for (const key of ['name', 'suitableLevels', 'notes'] as const) {
          if (!(key in b)) continue;
          params.push(b[key]);
          sets.push(`${col[key]}${params.length}${key === 'suitableLevels' ? '::level[]' : ''}`);
        }
        if (sets.length) await c.query(`UPDATE horses SET ${sets.join(', ')} WHERE id = $1`, params);
        const arenaIds = b.arenaIds;
        if (arenaIds !== undefined) {
          await this.arenasInBranch(c, h.branchId, arenaIds);
          await c.query(`DELETE FROM horse_arenas WHERE horse_id = $1`, [id]);
          for (const a of arenaIds) await c.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [id, a]);
        }
        await writeAudit(c, user, h.branchId, AUDIT.HORSE_UPDATE, ENTITY.HORSE, id, { fields: Object.keys(b) });
        return (await c.query(`SELECT ${HORSE_COLS} FROM horses h WHERE h.id = $1`, [id])).rows[0];
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException('A horse with that name already exists in this branch.');
      throw e;
    }
  }

  /**
   * Changing a horse's status never silently cancels its work. If it still has classes ahead, they are listed so staff can pick another horse.
   * Retiring is for managers; the stable team can mark rest, training, medical hold or injury.
   */
  async setStatus(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(SetHorseStatus, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const h = (await c.query(`SELECT id, branch_id AS "branchId", status FROM horses WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!h) throw new NotFoundException(problem('Horse not found.', HORSE_PROBLEM.HORSE_NOT_FOUND));
      if (h.status === HORSE_STATUS.RETIRED) throw new ConflictException(problem('A retired horse cannot be changed.', HORSE_PROBLEM.HORSE_RETIRED));
      if (b.status === HORSE_STATUS.RETIRED && user.role !== ROLE.MANAGER && user.role !== ROLE.OWNER) throw new ForbiddenException('Only a manager can retire a horse.');
      if (h.status === b.status) throw new ConflictException(problem(`The horse is already ${b.status}.`, HORSE_PROBLEM.SAME_STATUS));
      if (b.status !== HORSE_STATUS.AVAILABLE && !b.reason) {
        throw new BadRequestException({ message: 'A reason is required.', problems: [{ field: 'reason', message: 'is required unless making the horse available' }] });
      }
      await c.query(`UPDATE horses SET status = $2 WHERE id = $1`, [id, b.status]);
      await writeAudit(c, user, h.branchId, AUDIT.HORSE_STATUS, ENTITY.HORSE, id, { from: h.status, to: b.status, reason: b.reason ?? null });
      const affected =
        b.status === HORSE_STATUS.AVAILABLE
          ? []
          : (
              await c.query(
                `SELECT ha.id AS "assignmentId", o.id AS "occurrenceId", o.title, lower(o.during) AS "startsAt"
                   FROM horse_assignments ha JOIN occurrences o ON o.id = ha.occurrence_id
                  WHERE ha.horse_id = $1 AND upper(o.during) > now() AND o.status = ANY($2::occurrence_status[]) ORDER BY lower(o.during)`,
                [id, [OCCURRENCE_STATUS.PUBLISHED, OCCURRENCE_STATUS.IN_PROGRESS]],
              )
            ).rows;
      return { id, status: b.status, affectedClasses: affected };
    });
  }

  /** A horse's sessions in a date range, with a count per day, so the stable can see whether it is being overworked. */
  async workload(rawId: string, query: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const q = parse(WorkloadQuery, query);
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (to <= from) throw new BadRequestException({ message: 'The end must be after the start.', problems: [{ field: 'to', message: 'must be after from' }] });
    if (to - from > LIMITS.workloadMaxRangeDays * MS.day) throw new BadRequestException({ message: `The range may be at most ${LIMITS.workloadMaxRangeDays} days.`, problems: [{ field: 'to', message: 'range too long' }] });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const h = (await c.query(`SELECT h.id, h.name, b.time_zone AS tz FROM horses h JOIN branches b ON b.id = h.branch_id WHERE h.id = $1`, [id])).rows[0];
      if (!h) throw new NotFoundException(problem('Horse not found.', HORSE_PROBLEM.HORSE_NOT_FOUND));
      const sessions = (
        await c.query(
          `SELECT ha.id AS "assignmentId", o.id AS "occurrenceId", o.title, ${epochMs('lower(o.during)')} AS "startsAt", ${epochMs('upper(o.during)')} AS "endsAt",
                  to_char(lower(o.during) AT TIME ZONE $4, 'YYYY-MM-DD') AS day, r.full_name AS "riderName"
             FROM horse_assignments ha JOIN occurrences o ON o.id = ha.occurrence_id LEFT JOIN riders r ON r.id = ha.rider_id
            WHERE ha.horse_id = $1 AND ha.during && tstzrange($2::timestamptz, $3::timestamptz) AND o.status <> $5 ORDER BY lower(o.during)`,
          [id, iso(from), iso(to), h.tz, OCCURRENCE_STATUS.CANCELLED],
        )
      ).rows.map((s) => ({ ...s, startsAt: Number(s.startsAt), endsAt: Number(s.endsAt) }));
      const perDay: Record<string, number> = {};
      for (const s of sessions) perDay[s.day] = (perDay[s.day] ?? 0) + 1;
      return { horse: { id: h.id, name: h.name }, total: sessions.length, perDay, sessions };
    });
  }
}
