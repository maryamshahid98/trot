import { ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../auth/decorators.ts';
import { writeAudit } from '../common/audit.ts';
import { effectivePolicy } from '../common/policy.ts';
import { parse } from '../common/validate.ts';
import { ADMIN_PROBLEM, AUDIT, ENTITY, OWNER_ONLY_POLICY_KEYS, ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { IdParam, UpdateBranch, UpdatePolicy } from './branches.schemas.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const COLS = `b.id, b.name, b.time_zone AS "timeZone", b.currency, b.active`;

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
      const row = (await c.query(`SELECT name, time_zone FROM branches WHERE id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`, [id, user.branchIds])).rows[0];
      if (!row) throw new NotFoundException(problem('Branch not found.', ADMIN_PROBLEM.BRANCH_NOT_FOUND));
      await c.query(`UPDATE branches SET name = coalesce($2, name), time_zone = coalesce($3, time_zone) WHERE id = $1`, [id, b.name ?? null, b.timeZone ?? null]);
      await writeAudit(c, user, id, AUDIT.BRANCH_UPDATE, ENTITY.BRANCH, id, { from: { name: row.name, timeZone: row.time_zone }, to: { name: b.name ?? row.name, timeZone: b.timeZone ?? row.time_zone } });
    });
    return this.get(id, user);
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
