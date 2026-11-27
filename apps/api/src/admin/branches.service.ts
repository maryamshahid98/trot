import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { effectivePolicy } from '../common/policy.ts';
import { parse } from '../common/validate.ts';
import { ADMIN_PROBLEM, AUDIT, ENTITY, OWNER_ONLY_POLICY_KEYS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { CreateBranch, IdParam, UpdateBranch, UpdateOrganisation, UpdatePolicy } from './branches.schemas.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const COLS = `b.id, b.name, b.time_zone AS "timeZone", b.currency, b.active, b.address, to_char(b.opens_at, 'HH24:MI') AS "opensAt", to_char(b.closes_at, 'HH24:MI') AS "closesAt",
  array(SELECT to_char(h, 'YYYY-MM-DD') FROM unnest(b.holidays) h ORDER BY 1) AS holidays`;
const ORG = `o.id, o.name, o.legal_name AS "legalName", o.tax_number AS "taxNumber", o.address, o.phone, o.email, o.logo_url AS "logoUrl", o.default_currency AS "defaultCurrency", o.default_time_zone AS "defaultTimeZone", o.languages`;
const OF_MINE = `o.id IN (SELECT organisation_id FROM branches WHERE id = ANY($1::uuid[]))`;

@Injectable()
export class BranchesService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Branches are not isolated by the database, so every query here names the caller's own branches. */
  async list(user: AuthUser) {
    const r = await this.db.query(`SELECT ${COLS} FROM branches b WHERE b.id = ANY($1::uuid[]) ORDER BY b.name`, [user.branchIds]);
    return { branches: r.rows };
  }

  async get(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const r = (await this.db.query(`SELECT ${COLS} FROM branches b WHERE b.id = $1 AND b.id = ANY($2::uuid[])`, [id, user.branchIds])).rows[0];
    if (!r) throw new NotFoundException(problem('Branch not found.', ADMIN_PROBLEM.BRANCH_NOT_FOUND));
    return r;
  }

  async update(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b: Record<string, unknown> = parse(UpdateBranch, body);
    await this.db.tx(async (c) => {
      const row = (await c.query(`SELECT ${COLS} FROM branches b WHERE b.id = $1 AND b.id = ANY($2::uuid[]) FOR UPDATE`, [id, user.branchIds])).rows[0];
      if (!row) throw new NotFoundException(problem('Branch not found.', ADMIN_PROBLEM.BRANCH_NOT_FOUND));
      const next = { ...row, ...b };
      if (!next.opensAt !== !next.closesAt || (next.opensAt && next.opensAt >= next.closesAt)) {
        throw new UnprocessableEntityException(problem('Give both an opening and a later closing time, or neither.', 'BAD_HOURS'));
      }
      // Only these names ever become column names.
      const columns: Record<string, string> = { name: 'name', timeZone: 'time_zone', address: 'address', opensAt: 'opens_at', closesAt: 'closes_at', holidays: 'holidays' };
      const keys = Object.keys(b).filter((k) => k in columns);
      await c.query(`UPDATE branches SET ${keys.map((k, i) => `${columns[k]} = $${i + 2}${k === 'holidays' ? '::date[]' : ''}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => b[k])]);
      const pick = (o: Record<string, unknown>) => Object.fromEntries(keys.map((k) => [k, o[k]]));
      await writeAudit(c, user, id, AUDIT.BRANCH_UPDATE, ENTITY.BRANCH, id, { from: pick(row), to: pick(next) });
    });
    return this.get(id, user);
  }

  /** A new branch of the same organisation. The owner who creates it can work in it at once. */
  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateBranch, body);
    const id = await this.db.tx(async (c) => {
      const org = (await c.query(`SELECT o.id FROM organisations o WHERE ${OF_MINE} LIMIT 1`, [user.branchIds])).rows[0];
      if (!org) throw new NotFoundException(problem('Organisation not found.', ADMIN_PROBLEM.BRANCH_NOT_FOUND));
      if ((await c.query(`SELECT 1 FROM branches WHERE organisation_id = $1 AND lower(name) = lower($2)`, [org.id, b.name])).rowCount) throw new ConflictException(problem('A branch with that name already exists.', ADMIN_PROBLEM.NAME_TAKEN));
      const made: string = (await c.query(`INSERT INTO branches (organisation_id, name, time_zone, currency, address) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [org.id, b.name, b.timeZone, b.currency, b.address ?? null])).rows[0].id;
      await c.query(`INSERT INTO account_branches (account_id, branch_id) VALUES ($1,$2)`, [user.id, made]);
      await writeAudit(c, user, made, 'branch.create', ENTITY.BRANCH, made, { name: b.name, timeZone: b.timeZone, currency: b.currency });
      return made;
    });
    return { id };
  }

  async organisation(user: AuthUser) {
    const r = (await this.db.query(`SELECT ${ORG} FROM organisations o WHERE ${OF_MINE} LIMIT 1`, [user.branchIds])).rows[0];
    if (!r) throw new NotFoundException('Organisation not found.');
    return r;
  }

  async updateOrganisation(body: unknown, user: AuthUser) {
    const b: Record<string, unknown> = parse(UpdateOrganisation, body);
    const columns: Record<string, string> = { name: 'name', legalName: 'legal_name', taxNumber: 'tax_number', address: 'address', phone: 'phone', email: 'email', logoUrl: 'logo_url', defaultCurrency: 'default_currency', defaultTimeZone: 'default_time_zone', languages: 'languages' };
    await this.db.tx(async (c) => {
      const row = (await c.query(`SELECT ${ORG} FROM organisations o WHERE ${OF_MINE} LIMIT 1 FOR UPDATE`, [user.branchIds])).rows[0];
      if (!row) throw new NotFoundException('Organisation not found.');
      const keys = Object.keys(b).filter((k) => k in columns);
      await c.query(`UPDATE organisations SET ${keys.map((k, i) => `${columns[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [row.id, ...keys.map((k) => b[k])]);
      const pick = (o: Record<string, unknown>) => Object.fromEntries(keys.map((k) => [k, o[k]]));
      await writeAudit(c, user, user.branchIds[0], 'organisation.update', 'organisation', row.id, { from: pick(row), to: pick(b) });
    });
    return this.organisation(user);
  }

  async getPolicy(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const r = (await this.db.query(`SELECT policy FROM branches WHERE id = $1 AND id = ANY($2::uuid[])`, [id, user.branchIds])).rows[0];
    if (!r) throw new NotFoundException(problem('Branch not found.', ADMIN_PROBLEM.BRANCH_NOT_FOUND));
    return { branchId: id, policy: effectivePolicy(r.policy) };
  }

  /** Change some of a branch's rules. Sending null for a rule puts it back to the club default. */
  async updatePolicy(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b: Record<string, unknown> = parse(UpdatePolicy, body);
    const sent = Object.keys(b).filter((k) => b[k] !== undefined);
    if (user.role !== ROLE.OWNER && sent.some((k) => (OWNER_ONLY_POLICY_KEYS as readonly string[]).includes(k))) {
      throw new ForbiddenException(problem('Only an owner can change the approval limit or the unpaid-confirmation rule.', ADMIN_PROBLEM.OWNER_ONLY_SETTING));
    }
    return this.db.tx(async (c) => {
      const row = (await c.query(`SELECT policy FROM branches WHERE id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`, [id, user.branchIds])).rows[0];
      if (!row) throw new NotFoundException(problem('Branch not found.', ADMIN_PROBLEM.BRANCH_NOT_FOUND));
      const before = effectivePolicy(row.policy);
      const stored: Record<string, unknown> = row.policy && typeof row.policy === 'object' ? { ...row.policy } : {};
      for (const k of sent) {
        if (b[k] === null) delete stored[k];
        else stored[k] = b[k];
      }
      const after = effectivePolicy(stored);
      if (after.horseMaxSessionsPerWeek < after.horseMaxSessionsPerDay) {
        throw new UnprocessableEntityException(problem('The weekly horse limit cannot be lower than the daily limit.', ADMIN_PROBLEM.POLICY_INCONSISTENT));
      }
      await c.query(`UPDATE branches SET policy = $2::jsonb WHERE id = $1`, [id, JSON.stringify(stored)]);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of sent) {
        const key = k as keyof typeof before;
        if (before[key] !== after[key]) changes[k] = { from: before[key], to: after[key] };
      }
      await writeAudit(c, user, id, AUDIT.POLICY_UPDATE, ENTITY.BRANCH, id, { changes });
      return { branchId: id, policy: after };
    });
  }
}
