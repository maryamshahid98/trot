import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { checkAssessment, levelAfterApproval, nextLevel } from '@trot/domain';
import type { Level, Recommendation } from '@trot/domain';
import type { AuthUser } from '../auth/decorators.ts';
import { OWNS_RIDER, writeAudit } from '../common/audit.ts';
import { pgErrorCode } from '../common/errors.ts';
import type { Tx } from '../common/sql.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, LIMITS, PG_ERROR, RIDER_STATUS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { queueForRider } from '../notifications/outbox.ts';
import { CreateAssessment, CreateSkill, Decide, IdParam, ListAssessments, ListSkills, UpdateAssessment, UpdateSkill } from './assessments.schemas.ts';

export const PASS_RATING = 3;
const OPEN = ['draft', 'needs_more'];
const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const CODE = { NOT_ASSESSOR: 'NOT_ASSESSOR', NOT_EDITABLE: 'ASSESSMENT_NOT_EDITABLE', NOT_READY: 'ASSESSMENT_NOT_READY', NOT_SUBMITTED: 'ASSESSMENT_NOT_SUBMITTED', OWN_ASSESSMENT: 'CANNOT_DECIDE_OWN', LEVEL_CHANGED: 'LEVEL_CHANGED', OPEN_EXISTS: 'ASSESSMENT_ALREADY_OPEN', NEEDS_NOTE: 'NOTE_REQUIRED', SKILL_EXISTS: 'SKILL_EXISTS' } as const;

function branchFor(requested: string | undefined, user: AuthUser): string {
  if (requested) {
    if (!user.branchIds.includes(requested)) throw new NotFoundException('Branch not found.');
    return requested;
  }
  if (user.branchIds.length === 1) return user.branchIds[0];
  throw new BadRequestException({ message: 'branchId is required.', problems: [{ field: 'branchId', message: 'is required for people who work in more than one branch' }] });
}

const SKILL_COLS = `s.id, s.branch_id AS "branchId", s.name, s.description, s.for_level AS "forLevel", s.sort_order AS "sortOrder", s.active`;
const ASSESSMENT_COLS = `a.id, a.branch_id AS "branchId", a.rider_id AS "riderId", r.full_name AS "riderName", a.assessor_id AS "assessorId", ac.full_name AS "assessorName",
  a.from_level AS "fromLevel", a.target_level AS "targetLevel", a.recommendation, a.status, a.notes, a.created_at AS "createdAt", a.submitted_at AS "submittedAt",
  a.decided_by AS "decidedBy", a.decided_at AS "decidedAt", a.decision_note AS "decisionNote"`;
const ASSESSMENT_FROM = `FROM assessments a JOIN riders r ON r.id = a.rider_id JOIN accounts ac ON ac.id = a.assessor_id`;

@Injectable()
export class AssessmentsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  // ---------- skills ----------
  async listSkills(query: unknown, user: AuthUser) {
    const q = parse(ListSkills, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => ({
      skills: (
        await c.query(
          `SELECT ${SKILL_COLS} FROM skills s WHERE s.branch_id = $1 AND ($2::level IS NULL OR s.for_level = $2) AND ($3::boolean OR s.active) ORDER BY s.for_level, s.sort_order, s.name`,
          [branchId, q.forLevel ?? null, q.includeInactive === 'true'],
        )
      ).rows,
    }));
  }

  async createSkill(body: unknown, user: AuthUser) {
    const b = parse(CreateSkill, body);
    const branchId = branchFor(b.branchId, user);
    try {
      return await this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
        const id = (
          await c.query(`INSERT INTO skills (branch_id, name, description, for_level, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [branchId, b.name, b.description ?? null, b.forLevel, b.sortOrder])
        ).rows[0].id as string;
        await writeAudit(c, user, branchId, AUDIT.SKILL_CREATE, ENTITY.SKILL, id, { name: b.name, forLevel: b.forLevel });
        return { id };
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException(problem('That skill already exists for this level.', CODE.SKILL_EXISTS));
      throw e;
    }
  }

  async updateSkill(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(UpdateSkill, body);
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const cur = (await c.query(`SELECT branch_id AS "branchId" FROM skills WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!cur) throw new NotFoundException('Skill not found.');
        const columns = { name: 'name', description: 'description', sortOrder: 'sort_order', active: 'active' } as const;
        const sets: string[] = [];
        const params: unknown[] = [id];
        for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
          if (!(key in b)) continue;
          params.push(b[key]);
          sets.push(`${columns[key]} = $${params.length}`);
        }
        await c.query(`UPDATE skills SET ${sets.join(', ')} WHERE id = $1`, params);
        await writeAudit(c, user, cur.branchId, AUDIT.SKILL_UPDATE, ENTITY.SKILL, id, { fields: Object.keys(b) });
        return { id };
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException(problem('That skill already exists for this level.', CODE.SKILL_EXISTS));
      throw e;
    }
  }

  // ---------- assessments ----------
  private async load(c: Tx, rawId: string, lock = false) {
    const { id } = parse(IdParam, { id: rawId });
    const a = (await c.query(`SELECT ${ASSESSMENT_COLS} ${ASSESSMENT_FROM} WHERE a.id = $1 ${lock ? 'FOR UPDATE OF a' : ''}`, [id])).rows[0];
    if (!a) throw new NotFoundException('Assessment not found.');
    return a;
  }

  private async ratingsOf(c: Tx, id: string) {
    return (
      await c.query(
        `SELECT ar.skill_id AS "skillId", s.name AS "skillName", s.for_level AS "forLevel", ar.rating, ar.evidence
           FROM assessment_ratings ar JOIN skills s ON s.id = ar.skill_id WHERE ar.assessment_id = $1 ORDER BY s.sort_order, s.name`,
        [id],
      )
    ).rows;
  }

  /** Starts an assessment for a rider: from the rider's current level, aiming at the next one. */
  async create(body: unknown, user: AuthUser) {
    const { riderId } = parse(CreateAssessment, body);
    try {
      return await this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
        const r = (await c.query(`SELECT id, branch_id AS "branchId", level, status FROM riders WHERE id = $1 FOR UPDATE`, [riderId])).rows[0];
        if (!r) throw new NotFoundException('Rider not found.');
        if (r.status !== RIDER_STATUS.ACTIVE) throw new ConflictException(problem('Only an active rider can be assessed.', CODE.NOT_EDITABLE));
        const target = nextLevel(r.level as Level);
        const id = (
          await c.query(
            `INSERT INTO assessments (branch_id, rider_id, assessor_id, from_level, target_level, recommendation) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [r.branchId, riderId, user.id, r.level, target ?? r.level, target ? 'promote' : 'stay'],
          )
        ).rows[0].id as string;
        await writeAudit(c, user, r.branchId, AUDIT.ASSESSMENT_CREATE, ENTITY.ASSESSMENT, id, { riderId, fromLevel: r.level });
        return { id, status: 'draft' };
      });
    } catch (e: unknown) {
      if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException(problem('This rider already has an assessment in progress.', CODE.OPEN_EXISTS));
      throw e;
    }
  }

  /** Records ratings, notes and the recommendation. Only the person who started the assessment, and only until it is submitted. */
  async update(rawId: string, body: unknown, user: AuthUser) {
    const b = parse(UpdateAssessment, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const a = await this.load(c, rawId, true);
      if (a.assessorId !== user.id) throw new ForbiddenException(problem('Only the person who started this assessment can change it.', CODE.NOT_ASSESSOR));
      if (!OPEN.includes(a.status)) throw new ConflictException(problem(`A ${a.status} assessment cannot be changed.`, CODE.NOT_EDITABLE));

      const recommendation = (b.recommendation ?? a.recommendation) as Recommendation;
      // The target follows the recommendation: a promotion aims one level up, anything else stays where the rider is.
      const target = recommendation === 'promote' ? (b.targetLevel ?? nextLevel(a.fromLevel) ?? a.fromLevel) : a.fromLevel;
      if (b.targetLevel && recommendation !== 'promote' && b.targetLevel !== a.fromLevel) throw new BadRequestException({ message: 'The request is not valid.', problems: [{ field: 'targetLevel', message: 'must stay the same unless the recommendation is to promote' }] });

      for (const r of b.ratings ?? []) {
        const skill = (await c.query(`SELECT 1 FROM skills WHERE id = $1 AND active`, [r.skillId])).rowCount;
        if (!skill) throw new BadRequestException({ message: 'The request is not valid.', problems: [{ field: 'ratings', message: 'refers to a skill that does not exist in this branch or is switched off' }] });
        await c.query(
          `INSERT INTO assessment_ratings (assessment_id, skill_id, rating, evidence) VALUES ($1,$2,$3,$4)
           ON CONFLICT (assessment_id, skill_id) DO UPDATE SET rating = EXCLUDED.rating, evidence = EXCLUDED.evidence`,
          [a.id, r.skillId, r.rating, r.evidence ?? null],
        );
      }
      await c.query(`UPDATE assessments SET recommendation = $2, target_level = $3, notes = $4 WHERE id = $1`, [a.id, recommendation, target, b.notes ?? a.notes]);
      return this.detail(c, a.id);
    });
  }

  /** Sends it for approval, if the rules are met: see checkAssessment in the domain package. */
  async submit(rawId: string, user: AuthUser) {
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const a = await this.load(c, rawId, true);
      if (a.assessorId !== user.id) throw new ForbiddenException(problem('Only the person who started this assessment can submit it.', CODE.NOT_ASSESSOR));
      if (!OPEN.includes(a.status)) throw new ConflictException(problem(`A ${a.status} assessment cannot be submitted.`, CODE.NOT_EDITABLE));
      const ratings = await this.ratingsOf(c, a.id);
      const required = (await c.query(`SELECT id, name FROM skills WHERE branch_id = $1 AND for_level = $2 AND active ORDER BY sort_order, name`, [a.branchId, a.targetLevel])).rows as { id: string; name: string }[];
      const check = checkAssessment({
        fromLevel: a.fromLevel, targetLevel: a.targetLevel, recommendation: a.recommendation, notes: a.notes,
        requiredSkills: a.recommendation === 'promote' ? required : [], ratings: ratings.map((r) => ({ skillId: r.skillId, rating: r.rating })), passRating: PASS_RATING,
      });
      if (!check.ok) throw new UnprocessableEntityException({ message: 'This assessment is not ready to submit.', problems: check.reasons.map((message) => ({ code: CODE.NOT_READY, message })) });
      await c.query(`UPDATE assessments SET status = 'submitted', submitted_at = now(), decision_note = NULL WHERE id = $1`, [a.id]);
      await writeAudit(c, user, a.branchId, AUDIT.ASSESSMENT_SUBMIT, ENTITY.ASSESSMENT, a.id, { recommendation: a.recommendation, targetLevel: a.targetLevel });
      return { id: a.id, status: 'submitted' };
    });
  }

  /**
   * A manager or owner, who is not the assessor, decides. Approving a promotion changes the rider's level and writes the level history
   * in the same transaction. If the rider's level was changed by someone else in the meantime, the approval is refused.
   */
  async decide(rawId: string, body: unknown, user: AuthUser) {
    const b = parse(Decide, body);
    if (b.decision !== 'approve' && !b.note?.trim()) throw new BadRequestException({ message: 'The request is not valid.', problems: [{ field: 'note', message: 'say why' }] });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const a = await this.load(c, rawId, true);
      if (a.assessorId === user.id) throw new ForbiddenException(problem('You cannot decide your own assessment. Another manager or the owner must.', CODE.OWN_ASSESSMENT));
      if (a.status !== 'submitted') throw new ConflictException(problem('Only a submitted assessment can be decided.', CODE.NOT_SUBMITTED));
      const rider = (await c.query(`SELECT level FROM riders WHERE id = $1 FOR UPDATE`, [a.riderId])).rows[0];

      if (b.decision === 'request_more') {
        await c.query(`UPDATE assessments SET status = 'needs_more', decision_note = $2 WHERE id = $1`, [a.id, b.note]);
        await writeAudit(c, user, a.branchId, AUDIT.ASSESSMENT_DECIDE, ENTITY.ASSESSMENT, a.id, { decision: 'request_more', note: b.note });
        return { id: a.id, status: 'needs_more' };
      }
      if (b.decision === 'reject') {
        await c.query(`UPDATE assessments SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [a.id, user.id, b.note]);
        await writeAudit(c, user, a.branchId, AUDIT.ASSESSMENT_DECIDE, ENTITY.ASSESSMENT, a.id, { decision: 'reject', note: b.note });
        await queueForRider(c, a.riderId, { event: 'assessment.decided', branchId: a.branchId, dedupeKey: `assessment:${a.id}:decided`, data: { outcome: 'the level stays the same for now' } });
        return { id: a.id, status: 'rejected', level: rider.level as string };
      }

      const effect = levelAfterApproval({ fromLevel: a.fromLevel, targetLevel: a.targetLevel, recommendation: a.recommendation }, rider.level as Level);
      if ('stale' in effect) throw new ConflictException(problem(`The rider's level is now ${rider.level}, not ${a.fromLevel} as when this assessment began. Start a new assessment.`, CODE.LEVEL_CHANGED));
      if (effect.changes) {
        await c.query(`UPDATE riders SET level = $2 WHERE id = $1`, [a.riderId, effect.to]);
        await c.query(`INSERT INTO rider_level_history (branch_id, rider_id, from_level, to_level, reason, assessment_id, changed_by) VALUES ($1,$2,$3,$4,'assessment',$5,$6)`, [a.branchId, a.riderId, a.fromLevel, effect.to, a.id, user.id]);
      }
      await c.query(`UPDATE assessments SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [a.id, user.id, b.note ?? null]);
      await writeAudit(c, user, a.branchId, AUDIT.ASSESSMENT_DECIDE, ENTITY.ASSESSMENT, a.id, { decision: 'approve', from: a.fromLevel, to: effect.changes ? effect.to : a.fromLevel });
      await queueForRider(c, a.riderId, {
        event: 'assessment.decided', branchId: a.branchId, dedupeKey: `assessment:${a.id}:decided`,
        data: effect.changes ? { outcome: 'approved', newLevel: effect.to } : { outcome: `the level stays at ${a.fromLevel}` },
      });
      return { id: a.id, status: 'approved', level: effect.changes ? effect.to : (rider.level as string) };
    });
  }

  private async detail(c: Tx, id: string) {
    const a = await this.load(c, id);
    return { ...a, ratings: await this.ratingsOf(c, id) };
  }

  async get(rawId: string, user: AuthUser) {
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => this.detail(c, rawId));
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListAssessments, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const rows = (
        await c.query(
          `SELECT ${ASSESSMENT_COLS}, count(*) OVER ()::int AS total ${ASSESSMENT_FROM}
            WHERE a.branch_id = $1 AND ($2::uuid IS NULL OR a.rider_id = $2) AND ($3::text IS NULL OR a.status = $3)
            ORDER BY a.created_at DESC, a.id LIMIT $4 OFFSET $5`,
          [branchId, q.riderId ?? null, q.status ?? null, q.limit, q.offset],
        )
      ).rows;
      return { total: rows[0]?.total ?? 0, assessments: rows.map(({ total: _total, ...r }) => r) };
    });
  }

  /**
   * A rider's progress: current level, the full level history, and the assessments. Staff see every assessment with the assessor's notes.
   * A rider or guardian sees only approved assessments, with the skills and ratings but without the assessor's private notes (BRD ATT-005).
   */
  async progress(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const family = user.role === ROLE.CUSTOMER;
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = (await c.query(`SELECT r.id, r.level FROM riders r WHERE r.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')})`, [id, family, user.id])).rows[0];
      if (!r) throw new NotFoundException('Rider not found.');
      const history = (
        await c.query(
          `SELECT h.from_level AS "fromLevel", h.to_level AS "toLevel", h.reason, h.changed_at AS "changedAt", ${family ? 'NULL::text' : 'h.note'} AS note, ${family ? 'NULL::text' : 'acc.full_name'} AS "changedBy"
             FROM rider_level_history h LEFT JOIN accounts acc ON acc.id = h.changed_by WHERE h.rider_id = $1 ORDER BY h.id DESC`,
          [id],
        )
      ).rows;
      const list = (
        await c.query(
          `SELECT a.id, a.from_level AS "fromLevel", a.target_level AS "targetLevel", a.recommendation, a.status, ${family ? 'NULL::text' : 'a.notes'} AS notes, a.decided_at AS "decidedAt",
                  ${family ? 'NULL::text' : 'ac.full_name'} AS "assessorName"
             FROM assessments a JOIN accounts ac ON ac.id = a.assessor_id WHERE a.rider_id = $1 AND ($2::boolean = false OR a.status = 'approved') ORDER BY a.created_at DESC`,
          [id, family],
        )
      ).rows;
      const assessments = [];
      for (const a of list) assessments.push({ ...a, ratings: (await this.ratingsOf(c, a.id)).map(({ skillName, rating, forLevel, evidence }) => ({ skillName, forLevel, rating, evidence: family ? null : evidence })) });
      return { riderId: id, level: r.level as string, history, assessments, passRating: PASS_RATING, ratingMax: LIMITS.ratingMax };
    });
  }
}
