import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException, StreamableFile, UnsupportedMediaTypeException } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { epochMs } from '../common/sql.ts';
import type { Row } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, INCIDENT_PROBLEM, INCIDENT_SEVERITY, INCIDENT_STATUS, INCIDENT_TRANSITIONS, LIMITS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { branchManagers, queueForAccounts } from '../notifications/outbox.ts';
import { ActionParams, AddAction, CompleteAction, CreateIncident, FileParams, IdParam, ListIncidents, SetIncidentStatus, UpdateIncident } from './incidents.schemas.ts';
import { randomUUID } from 'node:crypto';
import type { Tx } from '../common/sql.ts';
import { detectFileType, FILE_STORAGE, safeFileName, sha256 } from '../riders/file-storage.ts';
import type { FileStorage } from '../riders/file-storage.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
/** Who sees every incident of the branch: managers, and the front desk (BRD 9: "create / view branch"). */
const seesBranch = (u: AuthUser) => u.role === ROLE.MANAGER || u.role === ROLE.OWNER || u.role === ROLE.RECEPTION;
const COLS = `i.id, i.number, i.arena_id AS "arenaId", (SELECT a.name FROM arenas a WHERE a.id = i.arena_id) AS "arenaName", i.occurrence_id AS "occurrenceId",
  (SELECT o.title FROM occurrences o WHERE o.id = i.occurrence_id) AS "occurrenceTitle", i.people, i.witnesses, i.immediate_action AS "immediateAction", i.branch_id AS "branchId", i.severity, i.status, i.kind, i.rider_id AS "riderId", r.full_name AS "riderName", i.horse_id AS "horseId", h.name AS "horseName",
  i.description, i.reported_by AS "reportedBy", rep.full_name AS "reportedByName", ${epochMs('i.occurred_at')} AS "occurredAt", ${epochMs('i.created_at')} AS "createdAt"`;
const FROM = `FROM incidents i LEFT JOIN riders r ON r.id = i.rider_id LEFT JOIN horses h ON h.id = i.horse_id LEFT JOIN accounts rep ON rep.id = i.reported_by`;
const view = <T extends Row>(x: T) => ({ ...x, occurredAt: Number(x.occurredAt), createdAt: Number(x.createdAt) });

/**
 * Incident reports hold what happened, so they may mention a rider's injury. Staff see only what they reported themselves;
 * managers see the whole branch. What was written is kept out of the audit trail, which records who did what, not the story.
 */
@Injectable()
export class IncidentsService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(FILE_STORAGE) private readonly files: FileStorage,
  ) {}

  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateIncident, body);
    const branchId = branchFor(b.branchId, user);
    const occurredAt = Date.parse(b.occurredAt);
    if (occurredAt > Date.now() + LIMITS.futureSkewMinutes * 60_000) throw new BadRequestException(problem('An incident cannot be in the future.', INCIDENT_PROBLEM.IN_THE_FUTURE));
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      if (b.riderId && !(await c.query(`SELECT 1 FROM riders WHERE id = $1`, [b.riderId])).rowCount) throw new UnprocessableEntityException(problem('That rider is not in this branch.', INCIDENT_PROBLEM.RIDER_NOT_IN_BRANCH));
      if (b.horseId && !(await c.query(`SELECT 1 FROM horses WHERE id = $1`, [b.horseId])).rowCount) throw new UnprocessableEntityException(problem('That horse is not in this branch.', INCIDENT_PROBLEM.HORSE_NOT_IN_BRANCH));
      if (b.arenaId && !(await c.query(`SELECT 1 FROM arenas WHERE id = $1 AND branch_id = $2`, [b.arenaId, branchId])).rowCount) throw new UnprocessableEntityException(problem('That arena is not in this branch.', 'ARENA_NOT_IN_BRANCH'));
      if (b.occurrenceId && !(await c.query(`SELECT 1 FROM occurrences WHERE id = $1 AND branch_id = $2`, [b.occurrenceId, branchId])).rowCount) throw new UnprocessableEntityException(problem('That class is not in this branch.', 'CLASS_NOT_IN_BRANCH'));
      const id: string = (
        await c.query(`INSERT INTO incidents (branch_id, severity, kind, rider_id, horse_id, description, reported_by, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz) RETURNING id`, [
          branchId, b.severity, b.kind, b.riderId ?? null, b.horseId ?? null, b.description, user.id, new Date(occurredAt).toISOString(),
        ])
      ).rows[0].id;
      await c.query(`UPDATE incidents SET arena_id = $2, occurrence_id = $3, people = $4, witnesses = $5, immediate_action = $6 WHERE id = $1`, [id, b.arenaId ?? null, b.occurrenceId ?? null, b.people ?? null, b.witnesses ?? null, b.immediateAction ?? null]);
      if (b.severity === 'high' || b.severity === 'critical') {
        // Management is told at once (BRD 10.2). Only the severity and a reference are sent, never the description.
        await queueForAccounts(c, (await branchManagers(c, branchId)).filter((m) => m !== user.id), { event: 'incident.escalated', branchId, dedupeKey: `incident:${id}:created`, data: { severity: b.severity, reference: id.slice(0, 8) } });
      }
      await writeAudit(c, user, branchId, AUDIT.INCIDENT_CREATE, ENTITY.INCIDENT, id, { severity: b.severity, kind: b.kind, riderId: b.riderId ?? null, horseId: b.horseId ?? null });
      const number = (await c.query(`SELECT number FROM incidents WHERE id = $1`, [id])).rows[0].number as string;
      return { id, number, status: INCIDENT_STATUS.OPEN };
    });
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListIncidents, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const where = `i.branch_id = $1 AND ($2::boolean OR i.reported_by = $3) AND ($4::text IS NULL OR i.status = $4) AND ($5::text IS NULL OR i.severity = $5)
        AND ($6::timestamptz IS NULL OR i.occurred_at >= $6) AND ($7::timestamptz IS NULL OR i.occurred_at < $7)`;
      const args = [branchId, seesBranch(user), user.id, q.status ?? null, q.severity ?? null, q.from ?? null, q.to ?? null];
      const total = Number((await c.query(`SELECT count(*) AS n FROM incidents i WHERE ${where}`, args)).rows[0].n);
      const rows = (await c.query(`SELECT ${COLS} ${FROM} WHERE ${where} ORDER BY i.occurred_at DESC, i.id LIMIT $8 OFFSET $9`, [...args, q.limit, q.offset])).rows;
      return { total, incidents: rows.map(view) };
    });
  }

  async get(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const row = (await c.query(`SELECT ${COLS} ${FROM} WHERE i.id = $1 AND ($2::boolean OR i.reported_by = $3)`, [id, seesBranch(user), user.id])).rows[0];
      if (!row) throw new NotFoundException(problem('Incident not found.', INCIDENT_PROBLEM.INCIDENT_NOT_FOUND));
      return view(row);
    });
  }

  /** The record with its corrective actions and evidence files. */
  async detail(rawId: string, user: AuthUser) {
    const incident = await this.get(rawId, user);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => ({
      ...incident,
      actions: (await c.query(`SELECT x.id, x.action, x.owner_id AS "ownerId", a.full_name AS "ownerName", to_char(x.due_on, 'YYYY-MM-DD') AS "dueOn", x.done_at AS "doneAt", x.done_note AS "doneNote" FROM incident_actions x LEFT JOIN accounts a ON a.id = x.owner_id WHERE x.incident_id = $1 ORDER BY x.created_at`, [incident.id])).rows,
      files: (await c.query(`SELECT id, file_name AS "fileName", file_type AS "fileType", file_size AS "fileSize", uploaded_at AS "uploadedAt" FROM incident_files WHERE incident_id = $1 ORDER BY uploaded_at`, [incident.id])).rows,
    }));
  }

  /** The incident, locked, for someone allowed to see it. Closed incidents are read-only until reopened. */
  private async open(c: Tx, id: string, user: AuthUser) {
    const i = (await c.query(`SELECT id, branch_id AS "branchId", status FROM incidents WHERE id = $1 AND ($2::boolean OR reported_by = $3) FOR UPDATE`, [id, seesBranch(user), user.id])).rows[0];
    if (!i) throw new NotFoundException(problem('Incident not found.', INCIDENT_PROBLEM.INCIDENT_NOT_FOUND));
    if (i.status === INCIDENT_STATUS.CLOSED) throw new ConflictException(problem('This incident is closed. Reopen it to change it.', 'INCIDENT_CLOSED'));
    return i;
  }

  async update(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(UpdateIncident, body) as Record<string, unknown>;
    const columns: Record<string, string> = { people: 'people', witnesses: 'witnesses', immediateAction: 'immediate_action', riderId: 'rider_id', horseId: 'horse_id', arenaId: 'arena_id' };
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const i = await this.open(c, id, user);
      const keys = Object.keys(b).filter((k) => k in columns && b[k] !== undefined);
      await c.query(`UPDATE incidents SET ${keys.map((k, n) => `${columns[k]} = $${n + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => b[k])]);
      await writeAudit(c, user, i.branchId, 'incident.update', ENTITY.INCIDENT, id, { fields: keys });
      return { id };
    });
  }

  async addAction(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(AddAction, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const i = await this.open(c, id, user);
      const made: string = (await c.query(`INSERT INTO incident_actions (incident_id, action, owner_id, due_on, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [id, b.action, b.ownerId ?? null, b.dueOn ?? null, user.id])).rows[0].id;
      await writeAudit(c, user, i.branchId, 'incident.action_add', ENTITY.INCIDENT, id, { actionId: made, ownerId: b.ownerId ?? null, dueOn: b.dueOn ?? null });
      return { id: made };
    });
  }

  async completeAction(rawId: string, rawActionId: string, body: unknown, user: AuthUser) {
    const { id, actionId } = parse(ActionParams, { id: rawId, actionId: rawActionId });
    const { note } = parse(CompleteAction, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const i = await this.open(c, id, user);
      const done = await c.query(`UPDATE incident_actions SET done_at = now(), done_note = $3 WHERE id = $1 AND incident_id = $2 AND done_at IS NULL`, [actionId, id, note]);
      if (!done.rowCount) throw new NotFoundException('That action is not open.');
      await writeAudit(c, user, i.branchId, 'incident.action_done', ENTITY.INCIDENT, id, { actionId });
      return { id: actionId };
    });
  }

  /** A photo or PDF as evidence. The type is judged from the file's own bytes. */
  async attach(rawId: string, data: unknown, fileName: string | undefined, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    if (!Buffer.isBuffer(data) || data.length === 0) throw new UnsupportedMediaTypeException('Send the file itself, as application/pdf, image/jpeg or image/png.');
    const type = detectFileType(data);
    if (!type) throw new UnsupportedMediaTypeException('Only PDF, JPEG and PNG files are accepted.');
    const key = randomUUID();
    let saved = false;
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const i = await this.open(c, id, user);
        await this.files.save(key, data);
        saved = true;
        const name = safeFileName(fileName, 'evidence', type, LIMITS.uploadFileNameMax);
        const made: string = (await c.query(`INSERT INTO incident_files (incident_id, file_key, file_name, file_type, file_size, file_sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [id, key, name, type, data.length, sha256(data), user.id])).rows[0].id;
        await writeAudit(c, user, i.branchId, 'incident.file_attach', ENTITY.INCIDENT, id, { fileId: made, type, bytes: data.length });
        return { id: made, fileName: name };
      });
    } catch (e: unknown) {
      if (saved) await this.files.remove(key).catch(() => undefined);
      throw e;
    }
  }

  async file(rawId: string, rawFileId: string, user: AuthUser): Promise<StreamableFile> {
    const { id, fileId } = parse(FileParams, { id: rawId, fileId: rawFileId });
    await this.get(id, user); // only someone who may see the incident
    const scope = { branchIds: user.branchIds, role: user.role };
    // As for rider documents: no database connection is held while the file is fetched.
    const row = await this.db.scoped(scope, async (c) => (await c.query(`SELECT f.file_key AS key, f.file_name AS name, f.file_type AS type, f.file_sha256 AS sha, i.branch_id AS "branchId" FROM incident_files f JOIN incidents i ON i.id = f.incident_id WHERE f.id = $1 AND f.incident_id = $2`, [fileId, id])).rows[0]);
    const bytes = row ? await this.files.read(row.key) : null;
    if (!row || !bytes) throw new NotFoundException('File not found.');
    if (sha256(bytes) !== row.sha) throw new ConflictException('The stored file does not match its fingerprint, so it was not sent.');
    await this.db.scoped(scope, (c) => writeAudit(c, user, row.branchId, 'incident.file_view', ENTITY.INCIDENT, id, { fileId }));
    const ascii = String(row.name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    return new StreamableFile(bytes, { type: row.type, disposition: `attachment; filename="${ascii}"`, length: bytes.length });
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
    return { history: rows.map((r) => ({ ...r, at: Number(r.at) })) };
  }

  async setStatus(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(SetIncidentStatus, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const i = (await c.query(`SELECT id, branch_id AS "branchId", status, severity, immediate_action AS "immediateAction" FROM incidents WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!i) throw new NotFoundException(problem('Incident not found.', INCIDENT_PROBLEM.INCIDENT_NOT_FOUND));
      if (!(INCIDENT_TRANSITIONS[i.status] ?? []).includes(b.status)) {
        throw new ConflictException({ ...problem(`An incident that is ${i.status} cannot become ${b.status}.`, INCIDENT_PROBLEM.BAD_TRANSITION), allowed: INCIDENT_TRANSITIONS[i.status] ?? [] });
      }
      if (b.status === INCIDENT_STATUS.CLOSED) {
        if (!b.note) throw new BadRequestException({ message: 'A note is required to close an incident.', problems: [{ field: 'note', message: 'is required when closing' }] });
        if (i.severity === INCIDENT_SEVERITY.CRITICAL && user.role !== ROLE.OWNER) throw new ForbiddenException(problem('Only an owner can close a critical incident.', INCIDENT_PROBLEM.OWNER_MUST_CLOSE));
      }
      if (b.status === INCIDENT_STATUS.CLOSED) {
        // Nothing is closed with work outstanding, and a serious incident must say what was done at once (BR-024).
        const left = (await c.query(`SELECT count(*)::int AS n FROM incident_actions WHERE incident_id = $1 AND done_at IS NULL`, [id])).rows[0].n as number;
        if (left > 0) throw new ConflictException(problem(`${left} corrective action(s) are not finished yet.`, 'ACTIONS_OPEN'));
        const serious = i.severity === INCIDENT_SEVERITY.HIGH || i.severity === INCIDENT_SEVERITY.CRITICAL;
        if (serious && !i.immediateAction) throw new ConflictException(problem('Record the immediate action taken before closing a high or critical incident.', 'IMMEDIATE_ACTION_REQUIRED'));
      }
      if (b.status === INCIDENT_STATUS.REOPENED && !b.note) throw new BadRequestException({ message: 'A note is required to reopen an incident.', problems: [{ field: 'note', message: 'is required when reopening' }] });
      await c.query(`UPDATE incidents SET status = $2 WHERE id = $1`, [id, b.status]);
      await writeAudit(c, user, i.branchId, AUDIT.INCIDENT_STATUS, ENTITY.INCIDENT, id, { from: i.status, to: b.status, note: b.note ?? null });
      return { id, status: b.status };
    });
  }
}
