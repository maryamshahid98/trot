import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, LIMITS } from '../config/constants.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { DbService } from '../db/db.service.ts';
import { AuthService } from './auth.service.ts';
import type { SessionAccount } from './auth.service.ts';
import type { AuthUser } from './decorators.ts';
import { verifyPassword } from './password.ts';
import { TokenService } from './tokens.ts';
import { decryptSecret, encryptSecret, hashRecoveryCode, newRecoveryCodes, newSecret, otpauthUrl, verifyCode } from './totp.ts';

const Code = z.string().trim().min(1).max(40);
export const EnableBody = z.object({ code: Code });
export const DisableBody = z.object({ password: z.string().min(1).max(LIMITS.passwordMax), code: Code });
export const RegenerateBody = z.object({ code: Code });
export const VerifyBody = z
  .object({ mfaToken: z.string().min(20).max(2000), code: Code.optional(), recoveryCode: Code.optional() })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), 'give either a code or a recovery code');

const problem = (message: string, code: string) => ({ message, problems: [{ code, message }] });
const CODE = { BAD_CODE: 'INVALID_CODE', ALREADY_ON: 'MFA_ALREADY_ENABLED', NOT_STARTED: 'MFA_NOT_STARTED', REQUIRED: 'MFA_REQUIRED_FOR_ROLE' } as const;
// One message for every way a code can be wrong (wrong, reused, expired, no such recovery code), so the answer teaches an attacker nothing.
const invalidCode = () => new UnauthorizedException('Invalid code.');
const badCode = () => new BadRequestException(problem('That code is not right. Check the time on your phone and try the newest code.', CODE.BAD_CODE));

@Injectable()
export class MfaService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private key = () => this.config.auth.mfaEncryptionKey;
  private required = (role: string) => this.config.auth.mfaRequiredRoles.includes(role);

  async status(user: AuthUser) {
    const row = (await this.db.query(`SELECT confirmed_at FROM account_mfa WHERE account_id = $1`, [user.id])).rows[0];
    const left = (await this.db.query(`SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE account_id = $1 AND used_at IS NULL`, [user.id])).rows[0].n as number;
    return { enabled: !!row?.confirmed_at, setupStarted: !!row && !row.confirmed_at, required: this.required(user.role), recoveryCodesLeft: row?.confirmed_at ? left : 0 };
  }

  /** Starts set-up: a new secret and the address to scan. It protects nothing until a code from the app has been confirmed (enable). */
  async setup(user: AuthUser) {
    const existing = (await this.db.query(`SELECT confirmed_at FROM account_mfa WHERE account_id = $1`, [user.id])).rows[0];
    if (existing?.confirmed_at) throw new ConflictException(problem('Two-step sign-in is already on. Turn it off first to set it up again.', CODE.ALREADY_ON));
    const secret = newSecret();
    await this.db.query(
      `INSERT INTO account_mfa (account_id, secret_enc) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, created_at = now() WHERE account_mfa.confirmed_at IS NULL`,
      [user.id, encryptSecret(secret, this.key())],
    );
    const who = (await this.db.query(`SELECT coalesce(email, phone, id::text) AS label FROM accounts WHERE id = $1`, [user.id])).rows[0].label as string;
    return { secret, otpauthUrl: otpauthUrl(secret, who, this.config.auth.mfaIssuer) };
  }

  /** Confirms set-up with a code from the app, turns protection on, and shows the recovery codes ONCE. */
  async enable(user: AuthUser, body: unknown) {
    const { code } = parse(EnableBody, body);
    return this.db.tx(async (c) => {
      const row = (await c.query(`SELECT secret_enc AS "secretEnc", confirmed_at AS "confirmedAt" FROM account_mfa WHERE account_id = $1 FOR UPDATE`, [user.id])).rows[0];
      if (!row) throw new ConflictException(problem('Start set-up first.', CODE.NOT_STARTED));
      if (row.confirmedAt) throw new ConflictException(problem('Two-step sign-in is already on.', CODE.ALREADY_ON));
      const step = verifyCode(decryptSecret(row.secretEnc as string, this.key()), code, Date.now(), 0);
      if (step === null) throw badCode();
      await c.query(`UPDATE account_mfa SET confirmed_at = now(), last_step = $2 WHERE account_id = $1`, [user.id, step]);
      const recoveryCodes = await this.newRecoveryCodes(c, user.id);
      await this.writeAudit(c, user, AUDIT.MFA_ENABLED, {});
      return { enabled: true, recoveryCodes };
    });
  }

  /** Switching it off needs the password AND a current code (or a recovery code), so a stolen session alone cannot remove it. Not allowed where the club requires it. */
  async disable(user: AuthUser, body: unknown) {
    const { password, code } = parse(DisableBody, body);
    if (this.required(user.role)) throw new ForbiddenException(problem('Your role must use two-step sign-in, so it cannot be turned off.', CODE.REQUIRED));
    const hash = (await this.db.query(`SELECT password_hash FROM accounts WHERE id = $1`, [user.id])).rows[0]?.password_hash as string | null;
    if (!hash || !(await verifyPassword(password, hash))) throw new BadRequestException({ message: 'The password is not correct.', problems: [{ field: 'password', message: 'is not correct' }] });
    return this.db.tx(async (c) => {
      if (!(await this.checkAnyCode(c, user.id, code))) throw badCode();
      await c.query(`DELETE FROM mfa_recovery_codes WHERE account_id = $1`, [user.id]);
      await c.query(`DELETE FROM account_mfa WHERE account_id = $1`, [user.id]);
      await this.writeAudit(c, user, AUDIT.MFA_DISABLED, {});
      return { enabled: false };
    });
  }

  /** New recovery codes (the old ones stop working). Needs a current code from the app. */
  async regenerateRecoveryCodes(user: AuthUser, body: unknown) {
    const { code } = parse(RegenerateBody, body);
    return this.db.tx(async (c) => {
      const row = (await c.query(`SELECT 1 FROM account_mfa WHERE account_id = $1 AND confirmed_at IS NOT NULL FOR UPDATE`, [user.id])).rowCount;
      if (!row) throw new ConflictException(problem('Two-step sign-in is not on.', CODE.NOT_STARTED));
      if (!(await this.checkTotp(c, user.id, code))) throw badCode();
      const recoveryCodes = await this.newRecoveryCodes(c, user.id);
      await this.writeAudit(c, user, AUDIT.MFA_CODES_REGENERATED, {});
      return { recoveryCodes };
    });
  }

  /**
   * The second step of signing in: the short-lived token proves the password was right, and the code (or a recovery code) finishes it.
   * A wrong code counts against the account exactly like a wrong password, so it cannot be guessed. A code that was already used is refused.
   */
  async verifyLogin(body: unknown, userAgent?: string) {
    const b = parse(VerifyBody, body);
    let accountId: string;
    try {
      accountId = await this.tokens.verifyMfa(b.mfaToken);
    } catch {
      throw new UnauthorizedException('Your sign-in took too long. Please sign in again.');
    }
    const a = (
      await this.db.query(
        `SELECT id, role, full_name, status, locale, theme, (locked_until IS NOT NULL AND locked_until > now()) AS is_locked FROM accounts WHERE id = $1`,
        [accountId],
      )
    ).rows[0];
    if (!a || a.status !== 'active' || a.is_locked) throw invalidCode();

    const ok = await this.db.tx(async (c) => (b.code !== undefined ? this.checkTotp(c, accountId, b.code) : this.useRecoveryCode(c, accountId, b.recoveryCode as string)));
    if (!ok) {
      await this.auth.registerFailure(accountId, { mfa: true });
      throw invalidCode();
    }
    if (b.recoveryCode !== undefined) await this.db.tx((c) => this.writeAudit(c, { id: accountId }, AUDIT.MFA_RECOVERY_USED, {}));
    return this.auth.startSession(a as SessionAccount, userAgent);
  }

  // ---------- parts ----------

  /** Checks a code from the app against the saved secret, and records the step so it cannot be used again. Inside the caller's transaction. */
  private async checkTotp(c: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }, accountId: string, code: string): Promise<boolean> {
    const row = (await c.query(`SELECT secret_enc AS "secretEnc", last_step AS "lastStep" FROM account_mfa WHERE account_id = $1 AND confirmed_at IS NOT NULL FOR UPDATE`, [accountId])).rows[0];
    if (!row) return false;
    const step = verifyCode(decryptSecret(row.secretEnc as string, this.key()), code, Date.now(), Number(row.lastStep));
    if (step === null) return false;
    await c.query(`UPDATE account_mfa SET last_step = $2 WHERE account_id = $1`, [accountId, step]);
    return true;
  }

  private async useRecoveryCode(c: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }, accountId: string, code: string): Promise<boolean> {
    const r = await c.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL`, [accountId, hashRecoveryCode(code)]);
    return (r.rowCount ?? 0) === 1;
  }

  /** A six-digit code or a recovery code, whichever it looks like. */
  private async checkAnyCode(c: Parameters<MfaService['checkTotp']>[0], accountId: string, code: string): Promise<boolean> {
    return /^\d{6}$/.test(code.trim()) ? this.checkTotp(c, accountId, code.trim()) : this.useRecoveryCode(c, accountId, code);
  }

  private async newRecoveryCodes(c: Parameters<MfaService['checkTotp']>[0], accountId: string): Promise<string[]> {
    const codes = newRecoveryCodes(LIMITS.mfaRecoveryCodes);
    await c.query(`DELETE FROM mfa_recovery_codes WHERE account_id = $1`, [accountId]);
    for (const code of codes) await c.query(`INSERT INTO mfa_recovery_codes (account_id, code_hash) VALUES ($1, $2)`, [accountId, hashRecoveryCode(code)]);
    return codes;
  }

  private async writeAudit(c: Parameters<MfaService['checkTotp']>[0], user: { id: string }, action: string, detail: object) {
    await c.query(`INSERT INTO audit_log (actor_account_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)`, [user.id, action, ENTITY.ACCOUNT, user.id, JSON.stringify(detail)]);
  }
}

