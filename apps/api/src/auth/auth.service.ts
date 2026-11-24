import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type pg from 'pg';
import { ACCOUNT_STATUS, AUDIT, ENTITY, LIMITS } from '../config/constants.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { DbService } from '../db/db.service.ts';
import type { AuthUser } from './decorators.ts';
import { dummyHash, hashPassword, verifyPassword } from './password.ts';
import { hashToken, TokenService } from './tokens.ts';

// One message for every sign-in failure, so the answer never reveals which accounts exist or are locked.
const invalid = () => new UnauthorizedException('Invalid credentials.');
const invalidSession = () => new UnauthorizedException('Your session is not valid. Please sign in again.');

/** The columns of an account that a new session needs. */
export interface SessionAccount { id: string; role: string; full_name: string | null; locale: string; theme: string }

@Injectable()
export class AuthService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async audit(c: { query(text: string, params?: unknown[]): Promise<unknown> }, accountId: string, action: string, detail: object = {}) {
    // accountId is sent twice: Postgres cannot give one placeholder two types (uuid for the actor, text for entity_id).
    await c.query(`INSERT INTO audit_log (actor_account_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)`, [
      accountId, action, ENTITY.ACCOUNT, accountId, JSON.stringify(detail),
    ]);
  }

  private async newRefresh(c: pg.PoolClient, accountId: string, familyId: string | null, userAgent?: string) {
    const t = this.tokens.newRefreshToken();
    await c.query(
      `INSERT INTO refresh_tokens (account_id, family_id, token_hash, expires_at, user_agent)
       VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, now() + make_interval(days => $4::int), $5)`,
      [accountId, familyId, t.hash, this.config.auth.refreshTtlDays, (userAgent ?? '').slice(0, LIMITS.userAgentMax)],
    );
    return t.token;
  }

  /** Counts a wrong password (or a wrong code) against the account, and locks it after too many. */
  async registerFailure(accountId: string, detail: object = {}) {
    const { maxFailedLogins, lockoutMinutes } = this.config.auth;
    const u = await this.db.query(
      `UPDATE accounts
          SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
              locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3::int) ELSE locked_until END
        WHERE id = $1 RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS now_locked`,
      [accountId, maxFailedLogins, lockoutMinutes],
    );
    await this.audit(this.db, accountId, AUDIT.LOGIN_FAILED, { lockedNow: !!u.rows[0]?.now_locked, ...detail });
  }

  /**
   * Checks the password. If the account has two-step sign-in on, the answer is a short-lived token (mfaRequired) and the sign-in is
   * finished by MfaService.verifyLogin once the code is right; otherwise the session starts at once.
   */
  async login(input: { identifier: string; password: string }, userAgent?: string) {
    const r = await this.db.query(
      `SELECT id, role, full_name, status, password_hash, locale, theme,
              (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
         FROM accounts WHERE lower(email) = lower($1) OR phone = $1 LIMIT 1`,
      [input.identifier],
    );
    const a = r.rows[0];
    if (!a || a.status !== ACCOUNT_STATUS.ACTIVE || !a.password_hash || a.is_locked) {
      await verifyPassword(input.password, await dummyHash()); // same effort as a real check
      throw invalid();
    }
    if (!(await verifyPassword(input.password, a.password_hash))) {
      await this.registerFailure(a.id);
      throw invalid();
    }
    const mfa = await this.db.query(`SELECT 1 FROM account_mfa WHERE account_id = $1 AND confirmed_at IS NOT NULL`, [a.id]);
    if (mfa.rowCount) return { mfaRequired: true as const, mfaToken: await this.tokens.signMfa(a.id), expiresIn: LIMITS.mfaTokenSeconds };
    return this.startSession(a as SessionAccount, userAgent);
  }

  /** The sign-in is complete (password, and the code if there is one): clear the failure count and hand out the tokens. */
  async startSession(a: SessionAccount, userAgent?: string) {
    const { accessTtlSeconds } = this.config.auth;
    return this.db.tx(async (c) => {
      await c.query('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = $1', [a.id]);
      const branches = await c.query(`SELECT branch_id::text AS id FROM account_branches WHERE account_id = $1`, [a.id]);
      const refreshToken = await this.newRefresh(c, a.id, null, userAgent);
      await this.audit(c, a.id, AUDIT.LOGIN);
      return {
        accessToken: await this.tokens.signAccess(a.id),
        refreshToken,
        expiresIn: accessTtlSeconds,
        user: { id: a.id, role: a.role, fullName: a.full_name, locale: a.locale, theme: a.theme, branchIds: branches.rows.map((b: { id: string }) => b.id) },
      };
    });
  }

  /** Swaps a refresh token for a new pair. Each refresh token works once; presenting a used one cancels the whole sign-in. */
  async refresh(token: string, userAgent?: string) {
    const outcome = await this.db.tx(async (c) => {
      const row = (
        await c.query(`SELECT id, account_id, family_id, expires_at <= now() AS expired, used_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [hashToken(token)])
      ).rows[0];
      if (!row || row.revoked_at) return { ok: false as const };
      if (row.used_at) {
        // A token that was already swapped is being used again: assume it was copied and end this sign-in everywhere.
        await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]);
        await this.audit(c, row.account_id, AUDIT.REFRESH_REUSE_DETECTED);
        return { ok: false as const };
      }
      if (row.expired) return { ok: false as const };
      const acct = (await c.query(`SELECT status FROM accounts WHERE id = $1`, [row.account_id])).rows[0];
      if (!acct || acct.status !== ACCOUNT_STATUS.ACTIVE) return { ok: false as const };

      await c.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [row.id]);
      const refreshToken = await this.newRefresh(c, row.account_id, row.family_id, userAgent);
      return { ok: true as const, accountId: row.account_id as string, refreshToken };
    });
    if (!outcome.ok) throw invalidSession();
    return { accessToken: await this.tokens.signAccess(outcome.accountId), refreshToken: outcome.refreshToken, expiresIn: this.config.auth.accessTtlSeconds };
  }

  /** Ends the sign-in this token belongs to. Always answers the same, whether or not the token was known. */
  async logout(token: string) {
    await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [hashToken(token)],
    );
    return { ok: true };
  }

  async changePassword(user: AuthUser, input: { currentPassword: string; newPassword: string }) {
    const row = (await this.db.query('SELECT password_hash FROM accounts WHERE id = $1', [user.id])).rows[0];
    if (!row?.password_hash || !(await verifyPassword(input.currentPassword, row.password_hash))) {
      throw new BadRequestException({ message: 'The current password is not correct.', problems: [{ field: 'currentPassword', message: 'is not correct' }] });
    }
    const hash = await hashPassword(input.newPassword);
    await this.db.tx(async (c) => {
      await c.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [user.id, hash]);
      // Every other device is signed out.
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [user.id]);
      await this.audit(c, user.id, AUDIT.PASSWORD_CHANGED);
    });
    return { ok: true };
  }
}
