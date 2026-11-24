import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type pg from 'pg';
import type { AuthUser } from '../auth/decorators.ts';
import { hashPassword } from '../auth/password.ts';
import { writeAudit } from '../common/audit.ts';
import { parse } from '../common/validate.ts';
import { ACCOUNT_STATUS, ADMIN_PROBLEM, AUDIT, ENTITY, OCCURRENCE_STATUS, PG_ERROR, ROLE, ROLE_RANK } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { CreateAccount, IdParam, ListAccounts, ResetPassword, SetBranches, SetRole, SetStatus, UpdateAccount } from './accounts.schemas.ts';
import { pgConstraint, pgErrorCode } from '../common/errors.ts';

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const rank = (role: string): number => (ROLE_RANK as Record<string, number>)[role] ?? 0;
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const needReason = () => new BadRequestException({ message: 'A reason is required.', problems: [{ field: 'reason', message: 'is required' }] });
/** Only the columns that are safe to show. The password hash never leaves the database. */
const VIEW = `a.id, a.role, a.full_name AS "fullName", a.email, a.phone, a.status, a.locale,
  (a.locked_until IS NOT NULL AND a.locked_until > now()) AS "temporarilyLocked",
  coalesce(array(SELECT ab.branch_id::text FROM account_branches ab WHERE ab.account_id = a.id AND ab.branch_id = ANY($1::uuid[]) ORDER BY 1), '{}') AS "branchIds"`;
/** A person is visible to you only if they work (or belong) in one of your branches. */
const VISIBLE = `EXISTS (SELECT 1 FROM account_branches ab WHERE ab.account_id = a.id AND ab.branch_id = ANY($1::uuid[]))`;

type Target = { id: string; role: string; status: string; fullName: string | null; branchId: string };

@Injectable()
export class AccountsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Loads and locks one visible account. Someone outside your branches simply does not exist for you. */
  private async target(c: pg.PoolClient, id: string, user: AuthUser): Promise<Target> {
    const t = (
      await c.query(`SELECT a.id, a.role, a.status, a.full_name AS "fullName",
              (SELECT ab.branch_id::text FROM account_branches ab WHERE ab.account_id = a.id AND ab.branch_id = ANY($1::uuid[]) ORDER BY 1 LIMIT 1) AS "branchId" FROM accounts a WHERE a.id = $2 AND ${VISIBLE} FOR UPDATE OF a`, [user.branchIds, id])
    ).rows[0] as Target | undefined;
    if (!t) throw new NotFoundException(problem('Account not found.', ADMIN_PROBLEM.ACCOUNT_NOT_FOUND));
    return t;
  }
  private outranks(user: AuthUser, t: Target) {
    if (t.id === user.id) throw new ForbiddenException(problem('You cannot do this to your own account.', ADMIN_PROBLEM.CANNOT_ACT_ON_SELF));
    if (rank(t.role) >= rank(user.role)) throw new ForbiddenException(problem('You can only manage people ranked below you.', ADMIN_PROBLEM.ROLE_TOO_HIGH));
  }
  private notDeleted(t: Target) {
    if (t.status === ACCOUNT_STATUS.DELETED) throw new ConflictException(problem('This account has been deleted.', ADMIN_PROBLEM.ACCOUNT_DELETED));
  }
  private commonBranch(user: AuthUser, others: string[]): string {
    return others.find((b) => user.branchIds.includes(b)) ?? user.branchIds[0];
  }
  private requireStaff(t: Target) {
    if (rank(t.role) < 1) throw new UnprocessableEntityException(problem('This is a customer account, not a staff account.', ADMIN_PROBLEM.NOT_STAFF));
  }
  /** A coach with classes still ahead cannot be moved away from them. */
  private async coachBusy(c: pg.PoolClient, coachId: string, branchId?: string): Promise<boolean> {
    // Classes are branch data. This transaction has no scope, so look through the coach's own branches (or the one named).
    const look = async () =>
      c.query(
        `SELECT 1 FROM occurrences WHERE coach_id = $1 AND status <> $2 AND upper(during) > now() AND ($3::uuid IS NULL OR branch_id = $3) LIMIT 1`,
        [coachId, OCCURRENCE_STATUS.CANCELLED, branchId ?? null],
      );
    const r = branchId ? await this.db.withBranches(c, [branchId], look) : await this.db.withAccountBranches(c, coachId, look);
    return (r.rowCount ?? 0) > 0;
  }
  private async revokeSessions(c: pg.PoolClient, accountId: string) {
    await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, [accountId]);
  }
  private conflictFrom(e: unknown): never {
    if (pgErrorCode(e) === PG_ERROR.UNIQUE_VIOLATION) {
      const phone = String(pgConstraint(e) ?? '').includes('phone');
      throw new ConflictException(phone ? problem('That phone number is already used by another account.', ADMIN_PROBLEM.PHONE_TAKEN) : problem('That email is already used by another account.', ADMIN_PROBLEM.EMAIL_TAKEN));
    }
    throw e;
  }

  async list(query: unknown, user: AuthUser) {
    const q = parse(ListAccounts, query);
    if (q.branchId && !user.branchIds.includes(q.branchId)) throw new ForbiddenException('You do not work in that branch.');
    const branches = q.branchId ? [q.branchId] : user.branchIds;
    const where = `${VISIBLE} AND ($2::account_role IS NULL OR a.role = $2) AND ($3::text IS NULL OR a.status = $3)
        AND ($4::text IS NULL OR a.full_name ILIKE $4 ESCAPE '\\' OR a.email ILIKE $4 ESCAPE '\\' OR a.phone ILIKE $4 ESCAPE '\\')`;
    const params = [branches, q.role ?? null, q.status ?? null, q.q ? likePattern(q.q) : null];
    const total = Number((await this.db.query(`SELECT count(*) AS n FROM accounts a WHERE ${where}`, params)).rows[0].n);
    const rows = (await this.db.query(`SELECT ${VIEW} FROM accounts a WHERE ${where} ORDER BY a.full_name NULLS LAST, a.id LIMIT $5 OFFSET $6`, [...params, q.limit, q.offset])).rows;
    return { total, accounts: rows };
  }

  async get(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const r = (await this.db.query(`SELECT ${VIEW} FROM accounts a WHERE a.id = $2 AND ${VISIBLE}`, [user.branchIds, id])).rows[0];
    if (!r) throw new NotFoundException(problem('Account not found.', ADMIN_PROBLEM.ACCOUNT_NOT_FOUND));
    return r;
  }

  async create(body: unknown, user: AuthUser) {
    const b = parse(CreateAccount, body);
    if (rank(b.role) >= rank(user.role)) throw new ForbiddenException(problem('You cannot give a role as high as your own.', ADMIN_PROBLEM.ROLE_TOO_HIGH));
    if (!b.branchIds.every((x) => user.branchIds.includes(x))) throw new ForbiddenException('You do not work in one of those branches.');
    const hash = await hashPassword(b.password);
    try {
      return await this.db.tx(async (c) => {
        if ((await c.query(`SELECT 1 FROM accounts WHERE lower(email) = $1`, [b.email])).rowCount) throw new ConflictException(problem('That email is already used by another account.', ADMIN_PROBLEM.EMAIL_TAKEN));
        const id: string = (
          await c.query(`INSERT INTO accounts (role, full_name, email, phone, password_hash, locale) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [b.role, b.fullName, b.email, b.phone ?? null, hash, b.locale])
        ).rows[0].id;
        for (const br of b.branchIds) await c.query(`INSERT INTO account_branches (account_id, branch_id) VALUES ($1,$2)`, [id, br]);
        await writeAudit(c, user, b.branchIds[0], AUDIT.ACCOUNT_CREATE, ENTITY.ACCOUNT, id, { role: b.role, branchIds: b.branchIds });
        return { id };
      });
    } catch (e) {
      return this.conflictFrom(e);
    }
  }

  async update(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b: Record<string, unknown> = parse(UpdateAccount, body);
    try {
      await this.db.tx(async (c) => {
        const t = await this.target(c, id, user);
        this.notDeleted(t);
        if (t.id !== user.id && rank(t.role) >= rank(user.role)) throw new ForbiddenException(problem('You can only manage people ranked below you.', ADMIN_PROBLEM.ROLE_TOO_HIGH));
        if ('email' in b && (await c.query(`SELECT 1 FROM accounts WHERE lower(email) = $1 AND id <> $2`, [b.email, id])).rowCount) {
          throw new ConflictException(problem('That email is already used by another account.', ADMIN_PROBLEM.EMAIL_TAKEN));
        }
        const columns = { fullName: 'full_name', email: 'email', phone: 'phone', locale: 'locale' } as const;
        const sets: string[] = [];
        const params: unknown[] = [id];
        for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
          if (!(key in b)) continue;
          params.push(b[key]);
          sets.push(`${columns[key]} = $${params.length}`);
        }
        await c.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $1`, params);
        await writeAudit(c, user, t.branchId, AUDIT.ACCOUNT_UPDATE, ENTITY.ACCOUNT, id, { fields: Object.keys(b) });
      });
    } catch (e) {
      this.conflictFrom(e);
    }
    return this.get(id, user);
  }

  async setRole(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(SetRole, body);
    return this.db.tx(async (c) => {
      const t = await this.target(c, id, user);
      this.outranks(user, t);
      this.notDeleted(t);
      this.requireStaff(t);
      if (rank(b.role) >= rank(user.role)) throw new ForbiddenException(problem('You cannot give a role as high as your own.', ADMIN_PROBLEM.ROLE_TOO_HIGH));
      if (t.role === b.role) throw new ConflictException(problem(`They are already ${b.role}.`, ADMIN_PROBLEM.SAME_VALUE));
      if (t.role === ROLE.COACH && (await this.coachBusy(c, id))) {
        throw new ConflictException(problem('This coach still has classes ahead. Move or cancel them first.', ADMIN_PROBLEM.COACH_HAS_CLASSES));
      }
      await c.query(`UPDATE accounts SET role = $2 WHERE id = $1`, [id, b.role]);
      await writeAudit(c, user, t.branchId, AUDIT.ACCOUNT_ROLE, ENTITY.ACCOUNT, id, { from: t.role, to: b.role, reason: b.reason ?? null });
      return { id, role: b.role };
    });
  }

  /** Locking ends every sign-in at once. Unlocking also clears the failed-password counter. */
  async setStatus(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(SetStatus, body);
    return this.db.tx(async (c) => {
      const t = await this.target(c, id, user);
      this.outranks(user, t);
      this.notDeleted(t);
      if (t.status === b.status) throw new ConflictException(problem(`The account is already ${b.status}.`, ADMIN_PROBLEM.SAME_VALUE));
      if (b.status === ACCOUNT_STATUS.LOCKED && !b.reason) throw needReason();
      await c.query(`UPDATE accounts SET status = $2, failed_logins = 0, locked_until = NULL WHERE id = $1`, [id, b.status]);
      if (b.status === ACCOUNT_STATUS.LOCKED) await this.revokeSessions(c, id);
      await writeAudit(c, user, t.branchId, AUDIT.ACCOUNT_STATUS, ENTITY.ACCOUNT, id, { from: t.status, to: b.status, reason: b.reason ?? null });
      return { id, status: b.status };
    });
  }

  /** Lifts the short lockout after too many wrong passwords. */
  async unlock(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.tx(async (c) => {
      const t = await this.target(c, id, user);
      this.outranks(user, t);
      this.notDeleted(t);
      await c.query(`UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [id]);
      await writeAudit(c, user, t.branchId, AUDIT.ACCOUNT_UNLOCK, ENTITY.ACCOUNT, id, {});
      return { id, unlocked: true };
    });
  }

  /**
   * A manager or owner removes a colleague's two-step sign-in, for someone who has lost their phone AND their recovery codes. Their sign-ins end.
   * If their role must use two-step sign-in they have to set it up again before doing anything else.
   */
  async resetMfa(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.tx(async (c) => {
      const t = await this.target(c, id, user);
      this.outranks(user, t);
      this.notDeleted(t);
      this.requireStaff(t);
      await c.query(`DELETE FROM mfa_recovery_codes WHERE account_id = $1`, [id]);
      await c.query(`DELETE FROM account_mfa WHERE account_id = $1`, [id]);
      await this.revokeSessions(c, id);
      await writeAudit(c, user, t.branchId, AUDIT.MFA_RESET, ENTITY.ACCOUNT, id, {});
      return { id, mfaReset: true };
    });
  }

  /** A manager sets a new password for a staff member who is locked out. Every sign-in of theirs ends. */
  async resetPassword(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(ResetPassword, body);
    const hash = await hashPassword(b.newPassword);
    return this.db.tx(async (c) => {
      const t = await this.target(c, id, user);
      this.outranks(user, t);
      this.notDeleted(t);
      this.requireStaff(t);
      await c.query(`UPDATE accounts SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1`, [id, hash]);
      await this.revokeSessions(c, id);
      await writeAudit(c, user, t.branchId, AUDIT.ACCOUNT_PASSWORD_RESET, ENTITY.ACCOUNT, id, {}); // never the password
      return { id, reset: true };
    });
  }

  /**
   * Sets which of YOUR branches this person works in. Branches you do not manage are left exactly as they are,
   * so one manager cannot strip a colleague's access somewhere else.
   */
  async setBranches(rawId: string, body: unknown, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    const b = parse(SetBranches, body);
    if (!b.branchIds.every((x) => user.branchIds.includes(x))) throw new ForbiddenException('You do not work in one of those branches.');
    return this.db.tx(async (c) => {
      const t = await this.target(c, id, user);
      this.outranks(user, t);
      this.notDeleted(t);
      this.requireStaff(t);
      const current: string[] = (await c.query(`SELECT branch_id::text AS b FROM account_branches WHERE account_id = $1`, [id])).rows.map((r) => r.b);
      const mine = current.filter((x) => user.branchIds.includes(x));
      const removed = mine.filter((x) => !b.branchIds.includes(x));
      const added = b.branchIds.filter((x) => !current.includes(x));
      if (t.role === ROLE.COACH) {
        for (const br of removed) if (await this.coachBusy(c, id, br)) throw new ConflictException(problem('This coach still has classes ahead in a branch you are removing.', ADMIN_PROBLEM.COACH_HAS_CLASSES));
      }
      for (const br of removed) await c.query(`DELETE FROM account_branches WHERE account_id = $1 AND branch_id = $2`, [id, br]);
      for (const br of added) await c.query(`INSERT INTO account_branches (account_id, branch_id) VALUES ($1,$2)`, [id, br]);
      await writeAudit(c, user, this.commonBranch(user, b.branchIds), AUDIT.ACCOUNT_BRANCHES, ENTITY.ACCOUNT, id, { added, removed });
      return { id, branchIds: (await c.query(`SELECT branch_id::text AS b FROM account_branches WHERE account_id = $1 AND branch_id = ANY($2::uuid[]) ORDER BY 1`, [id, user.branchIds])).rows.map((r) => r.b) };
    });
  }
}
