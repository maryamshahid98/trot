import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { MS } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import type { Tx } from '../bookings/core.ts';
import { writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { epochMs } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import { ADMIN_PROBLEM, AUDIT, ENTITY, LIMITS, OCCURRENCE_STATUS } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { ClosureParams, CreateArena, CreateClosure, IdParam, ListArenas, UpdateArena } from './branches.schemas.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const iso = (ms: number) => new Date(ms).toISOString();
const COLS = `a.id, a.name, a.max_capacity AS "maxCapacity"`;

@Injectable()
export class ArenasService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private async nameTaken(c: Tx, branchId: string, name: string, exceptId?: string) {
    return ((await c.query(`SELECT 1 FROM arenas WHERE branch_id = $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)`, [branchId, name, exceptId ?? null])).rowCount ?? 0) > 0;
  }
  /** Live classes in this arena that overlap a time range. */
  private async classesIn(c: Tx, arenaId: string, from: string, to: string) {
    return (
      await c.query(
        `SELECT id, title, ${epochMs('lower(during)')} AS "startsAt" FROM occurrences
          WHERE arena_id = $1 AND status <> $2 AND during && tstzrange($3::timestamptz, $4::timestamptz) ORDER BY lower(during) LIMIT $5`,
        [arenaId, OCCURRENCE_STATUS.CANCELLED, from, to, LIMITS.affectedClassesShown],
      )
    ).rows.map((r) => ({ id: r.id, title: r.title, startsAt: Number(r.startsAt) }));
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListArenas, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => ({
      arenas: (await c.query(`SELECT ${COLS} FROM arenas a WHERE a.branch_id = $1 ORDER BY a.name`, [branchId])).rows,
    }));
  }

  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateArena, body);
    const branchId = branchFor(b.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      if (await this.nameTaken(c, branchId, b.name)) throw new ConflictException(problem('An arena with that name already exists in this branch.', ADMIN_PROBLEM.NAME_TAKEN));
      const id: string = (await c.query(`INSERT INTO arenas (branch_id, name, max_capacity) VALUES ($1,$2,$3) RETURNING id`, [branchId, b.name, b.maxCapacity])).rows[0].id;
      await writeAudit(c, user, branchId, AUDIT.ARENA_CREATE, ENTITY.ARENA, id, { name: b.name, maxCapacity: b.maxCapacity });
      return { id };
    });
  }

  async update(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(UpdateArena, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const a = (await c.query(`SELECT id, branch_id AS "branchId", name, max_capacity AS "maxCapacity" FROM arenas WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!a) throw new NotFoundException(problem('Arena not found.', ADMIN_PROBLEM.ARENA_NOT_FOUND));
      if (b.name !== undefined && (await this.nameTaken(c, a.branchId, b.name, id))) throw new ConflictException(problem('An arena with that name already exists in this branch.', ADMIN_PROBLEM.NAME_TAKEN));
      if (b.maxCapacity !== undefined && b.maxCapacity < a.maxCapacity) {
        const over = await c.query(`SELECT id, title FROM occurrences WHERE arena_id = $1 AND status <> $2 AND upper(during) > now() AND capacity > $3 LIMIT $4`, [id, OCCURRENCE_STATUS.CANCELLED, b.maxCapacity, LIMITS.affectedClassesShown]);
        if (over.rowCount) throw new ConflictException({ ...problem('Classes ahead have more places than that. Change those classes first.', ADMIN_PROBLEM.ARENA_HAS_CLASSES), classes: over.rows });
      }
      await c.query(`UPDATE arenas SET name = coalesce($2, name), max_capacity = coalesce($3, max_capacity) WHERE id = $1`, [id, b.name ?? null, b.maxCapacity ?? null]);
      await writeAudit(c, user, a.branchId, AUDIT.ARENA_UPDATE, ENTITY.ARENA, id, { from: { name: a.name, maxCapacity: a.maxCapacity }, to: { name: b.name ?? a.name, maxCapacity: b.maxCapacity ?? a.maxCapacity } });
      return (await c.query(`SELECT ${COLS} FROM arenas a WHERE a.id = $1`, [id])).rows[0];
    });
  }

  async listClosures(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      if (!(await c.query(`SELECT 1 FROM arenas WHERE id = $1`, [id])).rowCount) throw new NotFoundException(problem('Arena not found.', ADMIN_PROBLEM.ARENA_NOT_FOUND));
      const rows = (await c.query(`SELECT id, ${epochMs('lower(during)')} AS "from", ${epochMs('upper(during)')} AS "to", reason FROM arena_closures WHERE arena_id = $1 AND upper(during) > now() ORDER BY lower(during)`, [id])).rows;
      return { closures: rows.map((r) => ({ ...r, from: Number(r.from), to: Number(r.to) })) };
    });
  }

  /** Closing an arena over a time that already has classes is refused, so nobody turns up to a closed arena. */
  async createClosure(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(CreateClosure, body);
    const from = Date.parse(b.from);
    const to = Date.parse(b.to);
    if (to <= from) throw new BadRequestException({ message: 'The end must be after the start.', problems: [{ field: 'to', message: 'must be after from' }] });
    if (to - from > LIMITS.closureMaxDays * MS.day) throw new BadRequestException({ message: `A closure may be at most ${LIMITS.closureMaxDays} days.`, problems: [{ field: 'to', message: 'range too long' }] });
    if (to <= Date.now()) throw new UnprocessableEntityException(problem('That closure is already over.', ADMIN_PROBLEM.CLOSURE_IN_PAST));
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const a = (await c.query(`SELECT id, branch_id AS "branchId" FROM arenas WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!a) throw new NotFoundException(problem('Arena not found.', ADMIN_PROBLEM.ARENA_NOT_FOUND));
      const classes = await this.classesIn(c, id, iso(from), iso(to));
      if (classes.length) throw new ConflictException({ ...problem('There are classes in that arena during this time. Move or cancel them first.', ADMIN_PROBLEM.ARENA_HAS_CLASSES), classes });
      const closureId: string = (await c.query(`INSERT INTO arena_closures (arena_id, during, reason) VALUES ($1, tstzrange($2::timestamptz,$3::timestamptz), $4) RETURNING id`, [id, iso(from), iso(to), b.reason])).rows[0].id;
      await writeAudit(c, user, a.branchId, AUDIT.CLOSURE_CREATE, ENTITY.ARENA_CLOSURE, closureId, { arenaId: id, from: iso(from), to: iso(to), reason: b.reason });
      return { id: closureId };
    });
  }

  async deleteClosure(rawId: string, rawClosureId: string, user: AuthUser) {
    const { id, closureId } = parse(ClosureParams, { id: rawId, closureId: rawClosureId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const a = (await c.query(`SELECT branch_id AS "branchId" FROM arenas WHERE id = $1`, [id])).rows[0];
      const gone = a ? await c.query(`DELETE FROM arena_closures WHERE id = $1 AND arena_id = $2 RETURNING id`, [closureId, id]) : undefined;
      if (!a || !gone?.rowCount) throw new NotFoundException(problem('Closure not found.', ADMIN_PROBLEM.CLOSURE_NOT_FOUND));
      await writeAudit(c, user, a.branchId, AUDIT.CLOSURE_DELETE, ENTITY.ARENA_CLOSURE, closureId, { arenaId: id });
      return { id: closureId, removed: true };
    });
  }
}
