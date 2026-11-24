import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { epochMs } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, INCIDENT_PROBLEM, INCIDENT_SEVERITY, INCIDENT_STATUS, INCIDENT_TRANSITIONS, LIMITS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { CreateIncident, IdParam, ListIncidents, SetIncidentStatus } from './incidents.schemas.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const isBoss = (u: AuthUser) => u.role === ROLE.MANAGER || u.role === ROLE.OWNER;
const COLS = `i.id, i.branch_id AS "branchId", i.severity, i.status, i.kind, i.rider_id AS "riderId", r.full_name AS "riderName", i.horse_id AS "horseId", h.name AS "horseName",
  i.description, i.reported_by AS "reportedBy", rep.full_name AS "reportedByName", ${epochMs('i.occurred_at')} AS "occurredAt", ${epochMs('i.created_at')} AS "createdAt"`;
const FROM = `FROM incidents i LEFT JOIN riders r ON r.id = i.rider_id LEFT JOIN horses h ON h.id = i.horse_id LEFT JOIN accounts rep ON rep.id = i.reported_by`;
const view = (x: any) => ({ ...x, occurredAt: Number(x.occurredAt), createdAt: Number(x.createdAt) });

/**
 * Incident reports hold what happened, so they may mention a rider's injury. Staff see only what they reported themselves;
 * managers see the whole branch. What was written is kept out of the audit trail, which records who did what, not the story.
 */
@Injectable()
export class IncidentsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateIncident, body);
    const branchId = branchFor(b.branchId, user);
    const occurredAt = Date.parse(b.occurredAt);
    if (occurredAt > Date.now() + LIMITS.futureSkewMinutes * 60_000) throw new BadRequestException(problem('An incident cannot be in the future.', INCIDENT_PROBLEM.IN_THE_FUTURE));
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      if (b.riderId && !(await c.query(`SELECT 1 FROM riders WHERE id = $1`, [b.riderId])).rowCount) throw new UnprocessableEntityException(problem('That rider is not in this branch.', INCIDENT_PROBLEM.RIDER_NOT_IN_BRANCH));
      if (b.horseId && !(await c.query(`SELECT 1 FROM horses WHERE id = $1`, [b.horseId])).rowCount) throw new UnprocessableEntityException(problem('That horse is not in this branch.', INCIDENT_PROBLEM.HORSE_NOT_IN_BRANCH));
      const id: string = (
        await c.query(`INSERT INTO incidents (branch_id, severity, kind, rider_id, horse_id, description, reported_by, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz) RETURNING id`, [
          branchId, b.severity, b.kind, b.riderId ?? null, b.horseId ?? null, b.description, user.id, new Date(occurredAt).toISOString(),
        ])
      ).rows[0].id;
      await writeAudit(c, user, branchId, AUDIT.INCIDENT_CREATE, ENTITY.INCIDENT, id, { severity: b.severity, kind: b.kind, riderId: b.riderId ?? null, horseId: b.horseId ?? null });
      return { id, status: INCIDENT_STATUS.OPEN };
    });
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListIncidents, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const where = `i.branch_id = $1 AND ($2::boolean OR i.reported_by = $3) AND ($4::text IS NULL OR i.status = $4) AND ($5::text IS NULL OR i.severity = $5)
        AND ($6::timestamptz IS NULL OR i.occurred_at >= $6) AND ($7::timestamptz IS NULL OR i.occurred_at < $7)`;
      const args = [branchId, isBoss(user), user.id, q.status ?? null, q.severity ?? null, q.from ?? null, q.to ?? null];
      const total = Number((await c.query(`SELECT count(*) AS n FROM incidents i WHERE ${where}`, args)).rows[0].n);
      const rows = (await c.query(`SELECT ${COLS} ${FROM} WHERE ${where} ORDER BY i.occurred_at DESC, i.id LIMIT $8 OFFSET $9`, [...args, q.limit, q.offset])).rows;
      return { total, incidents: rows.map(view) };
    });
  }

  async get(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const row = (await c.query(`SELECT ${COLS} ${FROM} WHERE i.id = $1 AND ($2::boolean OR i.reported_by = $3)`, [id, isBoss(user), user.id])).rows[0];
      if (!row) throw new NotFoundException(problem('Incident not found.', INCIDENT_PROBLEM.INCIDENT_NOT_FOUND));
      return view(row);
    });
  }

  /** What happened to this incident and who did it. The story itself is not repeated here. */
  async history(rawId: string, user: AuthUser) {
    const incident = await this.get(rawId, user);
    const rows = (
      await this.db.query(
        `SELECT l.id::text AS id, ${epochMs('l.at')} AS at, a.full_name AS "actorName", l.action, l.detail FROM audit_log l LEFT JOIN accounts a ON a.id = l.actor_account_id
          WHERE l.entity = $1 AND l.entity_id = $2 ORDER BY l.id`,
        [ENTITY.INCIDENT, incident.id],
      )
    ).rows;
    return { history: rows.map((r: any) => ({ ...r, at: Number(r.at) })) };
  }

  async setStatus(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(SetIncidentStatus, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const i = (await c.query(`SELECT id, branch_id AS "branchId", status, severity FROM incidents WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!i) throw new NotFoundException(problem('Incident not found.', INCIDENT_PROBLEM.INCIDENT_NOT_FOUND));
      if (!(INCIDENT_TRANSITIONS[i.status] ?? []).includes(b.status)) {
        throw new ConflictException({ ...problem(`An incident that is ${i.status} cannot become ${b.status}.`, INCIDENT_PROBLEM.BAD_TRANSITION), allowed: INCIDENT_TRANSITIONS[i.status] ?? [] });
      }
      if (b.status === INCIDENT_STATUS.CLOSED) {
        if (!b.note) throw new BadRequestException({ message: 'A note is required to close an incident.', problems: [{ field: 'note', message: 'is required when closing' }] });
        if (i.severity === INCIDENT_SEVERITY.CRITICAL && user.role !== ROLE.OWNER) throw new ForbiddenException(problem('Only an owner can close a critical incident.', INCIDENT_PROBLEM.OWNER_MUST_CLOSE));
      }
      if (b.status === INCIDENT_STATUS.REOPENED && !b.note) throw new BadRequestException({ message: 'A note is required to reopen an incident.', problems: [{ field: 'note', message: 'is required when reopening' }] });
      await c.query(`UPDATE incidents SET status = $2 WHERE id = $1`, [id, b.status]);
      await writeAudit(c, user, i.branchId, AUDIT.INCIDENT_STATUS, ENTITY.INCIDENT, id, { from: i.status, to: b.status, note: b.note ?? null });
      return { id, status: b.status };
    });
  }
}
