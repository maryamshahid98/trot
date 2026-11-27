import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { ACCOUNT_STATUS, AUDIT, ENTITY } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { queueForAccounts } from '../notifications/outbox.ts';
import { hashPassword } from './password.ts';

const MINUTES = 15;
const MAX_GUESSES = 5;
const fingerprint = (accountId: string, code: string) => createHash('sha256').update(`${accountId}:${code}`).digest('hex');
const refused = () => new BadRequestException({ message: 'That code is not valid. Ask for a new one.', problems: [{ field: 'code', message: 'is not valid' }] });

/** A forgotten password is replaced with a one-time code sent to the account's own email or phone (IAM-001). */
@Injectable()
export class ResetService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private async account(identifier: string) {
    return (
      await this.db.query(
        `SELECT a.id, a.role, (SELECT ab.branch_id::text FROM account_branches ab WHERE ab.account_id = a.id LIMIT 1) AS "branchId"
           FROM accounts a WHERE (lower(a.email) = lower($1) OR a.phone = $1) AND a.status = $2 AND a.password_hash IS NOT NULL LIMIT 1`,
        [identifier, ACCOUNT_STATUS.ACTIVE],
      )
    ).rows[0] as { id: string; role: string; branchId: string | null } | undefined;
  }

  /** Always answers the same, so nobody can find out which addresses have accounts. */
  async forgot(identifier: string) {
    const a = await this.account(identifier);
    if (a?.branchId) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await this.db.scoped({ branchIds: [a.branchId], role: 'manager' }, async (c) => {
        // At most one code a minute for one account.
        const made = await c.query(
          `INSERT INTO password_resets (account_id, code_hash, expires_at) VALUES ($1,$2, now() + make_interval(mins => $3))
           ON CONFLICT (account_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = now()
           WHERE password_resets.created_at < now() - interval '1 minute'`,
          [a.id, fingerprint(a.id, code), MINUTES],
        );
        if (made.rowCount) await queueForAccounts(c, [a.id], { event: 'auth.reset_code', branchId: a.branchId as string, dedupeKey: `reset:${a.id}:${Date.now()}`, data: { code, minutes: MINUTES } });
      });
    }
    return { ok: true };
  }

  async reset(identifier: string, code: string, newPassword: string) {
    const a = await this.account(identifier);
    if (!a) throw refused();
    const hash = await hashPassword(newPassword);
    const ok = await this.db.tx(async (c) => {
      const r = (await c.query(`SELECT code_hash AS "codeHash", attempts, expires_at > now() AS live FROM password_resets WHERE account_id = $1 FOR UPDATE`, [a.id])).rows[0];
      if (!r || !r.live || r.attempts >= MAX_GUESSES) return false;
      if (!timingSafeEqual(Buffer.from(r.codeHash), Buffer.from(fingerprint(a.id, code)))) {
        await c.query(`UPDATE password_resets SET attempts = attempts + 1 WHERE account_id = $1`, [a.id]);
        return false; // committed, so the guess is counted
      }
      await c.query(`UPDATE accounts SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1`, [a.id, hash]);
      await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, [a.id]);
      await c.query(`DELETE FROM password_resets WHERE account_id = $1`, [a.id]);
      await c.query(`INSERT INTO audit_log (actor_account_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)`, [a.id, AUDIT.PASSWORD_CHANGED, ENTITY.ACCOUNT, a.id, JSON.stringify({ by: 'reset code' })]);
      return true;
    });
    if (!ok) throw refused();
    return { ok: true };
  }
}
