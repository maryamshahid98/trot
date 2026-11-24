import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';
import { OWNS_RIDER, writeAudit } from '../common/audit.ts';
import { branchFor } from '../common/branch.ts';
import { parse } from '../common/validate.ts';
import { ACCOUNT_STATUS, AUDIT, ENTITY, PG_ERROR, RELATION, RIDER_PROBLEM, RIDER_STATUS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import {
  AddGuardian, CreateRider, GuardianParams, IdParam, ListRiders, SetLevel, SetStatus, UpdateRiderCustomer, UpdateRiderStaff,
} from './riders.schemas.ts';

const isCustomer = (u: AuthUser) => u.role === ROLE.CUSTOMER;
const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const ageOn = (dob: string) => {
  const d = new Date(`${dob}T00:00:00Z`);
  const n = new Date();
  let a = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--;
  return a;
};

/** Columns a caller may see on one rider. Medical details only go to the family and the front desk. */
const DETAIL = `r.id, r.branch_id AS "branchId", r.account_id AS "accountId", r.full_name AS "fullName",
  to_char(r.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth", r.level, r.status, r.is_walk_in AS "isWalkIn",
  r.medical_notes AS "medicalNotes", r.allergies, r.emergency_contact AS "emergencyContact", r.created_at AS "createdAt"`;
const SUMMARY = `r.id, r.full_name AS "fullName", to_char(r.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth", r.level, r.status, r.is_walk_in AS "isWalkIn", r.created_at AS "createdAt"`;

/** Escapes % and _ so a search for "50%" finds "50%", not everything. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

@Injectable()
export class RidersService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Finds one rider the caller may see. A customer only ever finds their own riders and wards; anything else looks like it does not exist. */
  private async load(c: any, id: string, user: AuthUser, columns = DETAIL, lock = false) {
    const r = (
      await c.query(`SELECT ${columns} FROM riders r WHERE r.id = $1 AND ($2::boolean = false OR ${OWNS_RIDER('r', '$3')})${lock ? ' FOR UPDATE OF r' : ''}`, [id, isCustomer(user), user.id])
    ).rows[0];
    if (!r) throw new NotFoundException('Rider not found.');
    return r;
  }

  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateRider, body);
    const branchId = branchFor(b.branchId, user);
    const customer = isCustomer(user);
    const age = ageOn(b.dateOfBirth);
    if (customer && (b.guardianAccountId || b.isWalkIn)) throw new ForbiddenException('Only staff can set that.');
    if (customer && !b.relation) {
      throw new BadRequestException({ message: 'The request is not valid.', problems: [{ field: 'relation', message: 'say whether this is you (self) or a child you guard (ward)' }] });
    }

    try {
      return await this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
        let accountId: string | null = null;
        let guardianId: string | undefined = b.guardianAccountId;
        let status: string = RIDER_STATUS.ACTIVE; // a rider added by staff has been seen in person

        if (customer) {
          status = RIDER_STATUS.PENDING_REVIEW;
          if (b.relation === RELATION.SELF) {
            if (age < 18) throw new UnprocessableEntityException(problem('A rider under 18 must be added by a parent or guardian.', RIDER_PROBLEM.CHILD_NEEDS_GUARDIAN));
            const has = await c.query(`SELECT 1 FROM riders WHERE account_id = $1`, [user.id]);
            if (has.rowCount) throw new ConflictException(problem('You already have a rider profile.', RIDER_PROBLEM.ALREADY_HAS_PROFILE));
            accountId = user.id;
          } else {
            if (age >= 18) throw new UnprocessableEntityException(problem('An adult rider needs their own account.', RIDER_PROBLEM.ADULT_NEEDS_OWN_ACCOUNT));
            guardianId = user.id;
          }
        } else if (guardianId) {
          const ok = await c.query(
            `SELECT 1 FROM accounts a JOIN account_branches ab ON ab.account_id = a.id WHERE a.id = $1 AND ab.branch_id = $2 AND a.role = $3 AND a.status = $4`,
            [guardianId, branchId, ROLE.CUSTOMER, ACCOUNT_STATUS.ACTIVE],
          );
          if (!ok.rowCount) throw new UnprocessableEntityException(problem('That guardian is not a customer of this branch.', RIDER_PROBLEM.GUARDIAN_NOT_ELIGIBLE));
        }

        const id: string = (
          await c.query(
            `INSERT INTO riders (branch_id, account_id, full_name, date_of_birth, status, is_walk_in, medical_notes, allergies, emergency_contact)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
            [branchId, accountId, b.fullName, b.dateOfBirth, status, !customer && !!b.isWalkIn, b.medicalNotes ?? null, b.allergies ?? null, b.emergencyContact ? JSON.stringify(b.emergencyContact) : null],
          )
        ).rows[0].id;
        if (guardianId) await c.query(`INSERT INTO guardian_riders (guardian_account_id, rider_id) VALUES ($1,$2)`, [guardianId, id]);
        await writeAudit(c, user, branchId, AUDIT.RIDER_CREATE, ENTITY.RIDER, id, { status, relation: b.relation ?? null });
        return { id, status };
      });
    } catch (e: any) {
      if (e?.code === PG_ERROR.UNIQUE_VIOLATION) throw new ConflictException(problem('You already have a rider profile.', RIDER_PROBLEM.ALREADY_HAS_PROFILE));
      if (e?.code === PG_ERROR.INSUFFICIENT_PRIVILEGE) throw new ForbiddenException('That is outside the branches you may work in.');
      throw e;
    }
  }

  async mine(user: AuthUser) {
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const riders = (await c.query(`SELECT ${DETAIL} FROM riders r WHERE ${OWNS_RIDER('r', '$1')} ORDER BY r.created_at`, [user.id])).rows;
      return { riders };
    });
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListRiders, query);
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const rows = (
        await c.query(
          `SELECT ${SUMMARY}, count(*) OVER ()::int AS total FROM riders r
            WHERE r.branch_id = $1 AND r.anonymised_at IS NULL
              AND ($2::text IS NULL OR r.full_name ILIKE $2 ESCAPE '\\')
              AND ($3::rider_status IS NULL OR r.status = $3)
            ORDER BY r.full_name, r.id LIMIT $4 OFFSET $5`,
          [branchId, q.q ? likePattern(q.q) : null, q.status ?? null, q.limit, q.offset],
        )
      ).rows;
      return { total: rows[0]?.total ?? 0, riders: rows.map(({ total: _total, ...r }: any) => r) };
    });
  }

  async get(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, (c) => this.load(c, id, user));
  }

  async update(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b: Record<string, any> = parse(isCustomer(user) ? UpdateRiderCustomer : UpdateRiderStaff, body);
    // Whitelist: only these keys ever become column names.
    const COLUMNS: Record<string, string> = { fullName: 'full_name', dateOfBirth: 'date_of_birth', medicalNotes: 'medical_notes', allergies: 'allergies', emergencyContact: 'emergency_contact' };
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = await this.load(c, id, user, 'r.id, r.branch_id AS "branchId", r.status', true);
      if (r.status === RIDER_STATUS.ARCHIVED) throw new ConflictException('This rider has been archived.');
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, col] of Object.entries(COLUMNS)) {
        if (!(key in b)) continue;
        params.push(key === 'emergencyContact' ? (b[key] === null ? null : JSON.stringify(b[key])) : b[key]);
        sets.push(`${col} = $${params.length}${key === 'emergencyContact' ? '::jsonb' : ''}`);
      }
      await c.query(`UPDATE riders SET ${sets.join(', ')} WHERE id = $1`, params);
      await writeAudit(c, user, r.branchId, AUDIT.RIDER_UPDATE, ENTITY.RIDER, id, { fields: Object.keys(b) }); // field names only, never the medical text
      return this.load(c, id, user);
    });
  }

  async setLevel(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { level } = parse(SetLevel, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = await this.load(c, id, user, 'r.id, r.branch_id AS "branchId", r.level', true);
      if (r.level !== level) {
        await c.query(`UPDATE riders SET level = $2 WHERE id = $1`, [id, level]);
        await writeAudit(c, user, r.branchId, AUDIT.RIDER_LEVEL, ENTITY.RIDER, id, { from: r.level, to: level });
      }
      return { id, level };
    });
  }

  async setStatus(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { status, reason } = parse(SetStatus, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = await this.load(c, id, user, 'r.id, r.branch_id AS "branchId", r.status', true);
      if (r.status === status) throw new ConflictException(problem(`The rider is already ${status}.`, RIDER_PROBLEM.SAME_STATUS));
      if (r.status === RIDER_STATUS.ARCHIVED) throw new ConflictException(problem('An archived rider cannot be changed.', RIDER_PROBLEM.NOT_ALLOWED_STATUS));
      // Reception handles sign-ups only. Restricting or suspending someone is a manager's decision.
      if (user.role === ROLE.RECEPTION) {
        const decidingSignup = r.status === RIDER_STATUS.PENDING_REVIEW && (status === RIDER_STATUS.ACTIVE || status === RIDER_STATUS.INACTIVE);
        if (!decidingSignup) throw new ForbiddenException('Only a manager can change a rider\'s status after sign-up.');
      }
      // Everything except an approval needs a written reason, so the history says why.
      if (status !== RIDER_STATUS.ACTIVE && !reason) {
        throw new BadRequestException({ message: 'A reason is required.', problems: [{ field: 'reason', message: 'is required unless approving' }] });
      }
      await c.query(`UPDATE riders SET status = $2 WHERE id = $1`, [id, status]);
      await writeAudit(c, user, r.branchId, AUDIT.RIDER_STATUS, ENTITY.RIDER, id, { from: r.status, to: status, reason: reason ?? null });
      return { id, status };
    });
  }

  async guardians(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      await this.load(c, id, user, 'r.id');
      const rows = (
        await c.query(`SELECT a.id AS "accountId", a.full_name AS "fullName", a.email, a.phone FROM guardian_riders g JOIN accounts a ON a.id = g.guardian_account_id WHERE g.rider_id = $1 ORDER BY a.full_name`, [id])
      ).rows;
      return { guardians: rows };
    });
  }

  async addGuardian(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const { accountId } = parse(AddGuardian, body);
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = await this.load(c, id, user, 'r.id, r.branch_id AS "branchId"', true);
      const ok = await c.query(
        `SELECT 1 FROM accounts a JOIN account_branches ab ON ab.account_id = a.id WHERE a.id = $1 AND ab.branch_id = $2 AND a.role = $3 AND a.status = $4`,
        [accountId, r.branchId, ROLE.CUSTOMER, ACCOUNT_STATUS.ACTIVE],
      );
      if (!ok.rowCount) throw new UnprocessableEntityException(problem('That person is not a customer of this branch.', RIDER_PROBLEM.GUARDIAN_NOT_ELIGIBLE));
      const ins = await c.query(`INSERT INTO guardian_riders (guardian_account_id, rider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [accountId, id]);
      if (!ins.rowCount) throw new ConflictException('That person is already a guardian of this rider.');
      await writeAudit(c, user, r.branchId, AUDIT.GUARDIAN_ADD, ENTITY.RIDER, id, { accountId });
      return { riderId: id, accountId };
    });
  }

  async removeGuardian(rawId: string, rawAccountId: string, user: AuthUser) {
    const { id, accountId } = parse(GuardianParams, { id: rawId, accountId: rawAccountId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = await this.load(c, id, user, `r.id, r.branch_id AS "branchId", to_char(r.date_of_birth, 'YYYY-MM-DD') AS dob`, true);
      const links = (await c.query(`SELECT guardian_account_id AS "accountId" FROM guardian_riders WHERE rider_id = $1 FOR UPDATE`, [id])).rows;
      if (!links.some((l: any) => l.accountId === accountId)) throw new NotFoundException('That person is not a guardian of this rider.');
      // A child must always have someone responsible for them.
      if (links.length === 1 && ageOn(r.dob) < 18) throw new ConflictException(problem('A rider under 18 must keep at least one guardian.', RIDER_PROBLEM.LAST_GUARDIAN));
      await c.query(`DELETE FROM guardian_riders WHERE rider_id = $1 AND guardian_account_id = $2`, [id, accountId]);
      await writeAudit(c, user, r.branchId, AUDIT.GUARDIAN_REMOVE, ENTITY.RIDER, id, { accountId });
      return { riderId: id, accountId, removed: true };
    });
  }
}
