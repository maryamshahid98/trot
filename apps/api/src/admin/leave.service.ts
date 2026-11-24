import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { MS } from '@trot/domain';
import type pg from 'pg';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { epochMs } from '../common/sql.ts';
import type { Row } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import { ADMIN_PROBLEM, AUDIT, DECISIONS, ENTITY, LEAVE_STATUS, LIMITS, OCCURRENCE_STATUS, ROLE, ROLE_RANK } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { CreateLeave, DecideLeave, IdParam, ListLeave } from './branches.schemas.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const rank = (role: string): number => (ROLE_RANK as Record<string, number>)[role] ?? 0;
const iso = (ms: number) => new Date(ms).toISOString();
const isBoss = (u: AuthUser) => u.role === ROLE.MANAGER || u.role === ROLE.OWNER;
const VISIBLE = `EXISTS (SELECT 1 FROM account_branches ab WHERE ab.account_id = s.id AND ab.branch_id = ANY($1::uuid[]))`;
const COLS = `l.id, l.staff_account_id AS "staffId", s.full_name AS "staffName", ${epochMs('lower(l.during)')} AS "from", ${epochMs('upper(l.during)')} AS "to", l.reason, l.status`;
const view = <T extends Row>(r: T) => ({ ...r, from: Number(r.from), to: Number(r.to) });

@Injectable()
export class LeaveService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** A coach cannot be away while classes are still planned with them, so approval is refused until those move. */
  private async classesDuring(c: pg.PoolClient, staffId: string, from: string, to: string) {
    // Classes are branch data. This transaction has no scope, so look through the branches this person works in.
    const rows = await this.db.withAccountBranches(c, staffId, async () =>
      (
        await c.query(
          `SELECT id, title, ${epochMs('lower(during)')} AS "startsAt" FROM occurrences
            WHERE coach_id = $1 AND status <> $2 AND during && tstzrange($3::timestamptz, $4::timestamptz) ORDER BY lower(during) LIMIT $5`,
          [staffId, OCCURRENCE_STATUS.CANCELLED, from, to, LIMITS.affectedClassesShown],
        )
      ).rows,
    );
    return rows.map((r) => ({ id: r.id, title: r.title, startsAt: Number(r.startsAt) }));
  }

  /** Staff ask for time off for themselves; managers can record it for staff below them (approved at once). */
  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateLeave, body);
    const from = Date.parse(b.from);
    const to = Date.parse(b.to);
    if (to <= from) throw new BadRequestException({ message: 'The end must be after the start.', problems: [{ field: 'to', message: 'must be after from' }] });
    if (to - from > LIMITS.closureMaxDays * MS.day) throw new BadRequestException({ message: `Leave may be at most ${LIMITS.closureMaxDays} days.`, problems: [{ field: 'to', message: 'range too long' }] });
    if (to <= Date.now()) throw new UnprocessableEntityException(problem('That time is already over.', ADMIN_PROBLEM.LEAVE_IN_PAST));
    const staffId = b.staffId ?? user.id;
    const forSomeoneElse = staffId !== user.id;
    if (forSomeoneElse && !isBoss(user)) throw new ForbiddenException('Only a manager can record leave for someone else.');
    return this.db.tx(async (c) => {
      const s = (
        await c.query(`SELECT s.id, s.role, (SELECT ab.branch_id::text FROM account_branches ab WHERE ab.account_id = s.id AND ab.branch_id = ANY($1::uuid[]) ORDER BY 1 LIMIT 1) AS "branchId" FROM accounts s WHERE s.id = $2 AND ${VISIBLE}`, [user.branchIds, staffId])
      ).rows[0];
      if (!s) throw new NotFoundException(problem('Staff member not found.', ADMIN_PROBLEM.ACCOUNT_NOT_FOUND));
      if (rank(s.role) < 1) throw new UnprocessableEntityException(problem('Customers do not have staff leave.', ADMIN_PROBLEM.NOT_STAFF));
      if (forSomeoneElse && rank(s.role) >= rank(user.role)) throw new ForbiddenException(problem('You can only manage people ranked below you.', ADMIN_PROBLEM.ROLE_TOO_HIGH));
      // Leave you record for someone, or an owner's own, needs nobody else to approve it.
      const approved = forSomeoneElse || user.role === ROLE.OWNER;
      if (approved) {
        const classes = await this.classesDuring(c, staffId, iso(from), iso(to));
        if (classes.length) throw new ConflictException({ ...problem('They have classes during that time. Move or cancel them first.', ADMIN_PROBLEM.LEAVE_HAS_CLASSES), classes });
      }
      const status = approved ? LEAVE_STATUS.APPROVED : LEAVE_STATUS.REQUESTED;
      const id: string = (
        await c.query(`INSERT INTO staff_unavailability (staff_account_id, during, reason, status) VALUES ($1, tstzrange($2::timestamptz,$3::timestamptz), $4, $5) RETURNING id`, [staffId, iso(from), iso(to), b.reason ?? null, status])
      ).rows[0].id;
      await writeAudit(c, user, s.branchId, AUDIT.LEAVE_CREATE, ENTITY.STAFF_LEAVE, id, { staffId, from: iso(from), to: iso(to), status });
      return { id, status };
    });
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListLeave, query);
    const own = !isBoss(user);
    if (own && q.staffId && q.staffId !== user.id) throw new ForbiddenException('You can only see your own leave.');
    const staffId = own ? user.id : q.staffId ?? null;
    const rows = (
      await this.db.query(
        `SELECT ${COLS} FROM staff_unavailability l JOIN accounts s ON s.id = l.staff_account_id
          WHERE ${VISIBLE} AND ($2::uuid IS NULL OR l.staff_account_id = $2) AND ($3::text IS NULL OR l.status = $3)
            AND ($4::timestamptz IS NULL OR upper(l.during) > $4) AND ($5::timestamptz IS NULL OR lower(l.during) < $5)
          ORDER BY lower(l.during) LIMIT $6`,
        [user.branchIds, staffId, q.status ?? null, q.from ?? null, q.to ?? null, LIMITS.scheduleListLimit],
      )
    ).rows;
    return { leave: rows.map(view) };
  }

  private async load(c: pg.PoolClient, rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const l = (
      await c.query(
        `SELECT l.id, l.staff_account_id AS "staffId", l.status, s.role AS "staffRole", ${epochMs('lower(l.during)')} AS "from", ${epochMs('upper(l.during)')} AS "to",
                (SELECT ab.branch_id::text FROM account_branches ab WHERE ab.account_id = s.id AND ab.branch_id = ANY($1::uuid[]) ORDER BY 1 LIMIT 1) AS "branchId"
           FROM staff_unavailability l JOIN accounts s ON s.id = l.staff_account_id WHERE l.id = $2 AND ${VISIBLE} FOR UPDATE OF l`,
        [user.branchIds, id],
      )
    ).rows[0];
    if (!l) throw new NotFoundException(problem('Leave not found.', ADMIN_PROBLEM.LEAVE_NOT_FOUND));
    return { ...l, from: Number(l.from), to: Number(l.to) } as { id: string; staffId: string; status: string; staffRole: string; from: number; to: number; branchId: string };
  }

  async decide(rawId: string, body: unknown, user: AuthUser) {
    const b = parse(DecideLeave, body);
    return this.db.tx(async (c) => {
      const l = await this.load(c, rawId, user);
      if (l.staffId === user.id || rank(l.staffRole) >= rank(user.role)) throw new ForbiddenException(problem('You cannot decide this request.', ADMIN_PROBLEM.ROLE_TOO_HIGH));
      if (l.status !== LEAVE_STATUS.REQUESTED) throw new ConflictException(problem(`This request was already ${l.status}.`, ADMIN_PROBLEM.LEAVE_ALREADY_DECIDED));
      if (b.decision === DECISIONS.REJECT && !b.reason) throw new BadRequestException({ message: 'A reason is required.', problems: [{ field: 'reason', message: 'is required when rejecting' }] });
      if (b.decision === DECISIONS.APPROVE) {
        const classes = await this.classesDuring(c, l.staffId, iso(l.from), iso(l.to));
        if (classes.length) throw new ConflictException({ ...problem('They have classes during that time. Move or cancel them first.', ADMIN_PROBLEM.LEAVE_HAS_CLASSES), classes });
      }
      const status = b.decision === DECISIONS.APPROVE ? LEAVE_STATUS.APPROVED : LEAVE_STATUS.REJECTED;
      await c.query(`UPDATE staff_unavailability SET status = $2 WHERE id = $1`, [l.id, status]);
      await writeAudit(c, user, l.branchId, AUDIT.LEAVE_DECIDE, ENTITY.STAFF_LEAVE, l.id, { decision: b.decision, reason: b.reason ?? null, staffId: l.staffId });
      return { id: l.id, status };
    });
  }

  /** Withdraw a request, or cancel leave that has not finished. Your own, or a lower-ranked person's if you are a manager. */
  async cancel(rawId: string, user: AuthUser) {
    return this.db.tx(async (c) => {
      const l = await this.load(c, rawId, user);
      const mine = l.staffId === user.id;
      if (!mine && !(isBoss(user) && rank(l.staffRole) < rank(user.role))) throw new ForbiddenException(problem('You cannot cancel this leave.', ADMIN_PROBLEM.ROLE_TOO_HIGH));
      if (l.to <= Date.now()) throw new ConflictException(problem('That leave is already over.', ADMIN_PROBLEM.LEAVE_IN_PAST));
      await c.query(`DELETE FROM staff_unavailability WHERE id = $1`, [l.id]);
      await writeAudit(c, user, l.branchId, AUDIT.LEAVE_CANCEL, ENTITY.STAFF_LEAVE, l.id, { staffId: l.staffId, status: l.status });
      return { id: l.id, removed: true };
    });
  }
}
