import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser } from '../auth/decorators.ts';
import { errorMessage } from '../common/errors.ts';
import { writeAudit } from '../common/audit.ts';
import { parse } from '../common/validate.ts';
import { AUDIT, ENTITY, LIMITS, ROLE, UUID_RE } from '../config/constants.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { DbService } from '../db/db.service.ts';
import { buildProviders, mask } from './providers.ts';
import type { Providers } from './providers.ts';

const STATUSES = ['queued', 'sending', 'sent', 'failed', 'skipped'] as const;
const ListQuery = z.object({
  branchId: z.string().regex(UUID_RE).optional(),
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const Preferences = z.object({ emailEnabled: z.boolean().optional(), smsEnabled: z.boolean().optional(), pushEnabled: z.boolean().optional() }).refine((p) => Object.keys(p).length > 0, 'say what to change');
const IdParam = z.object({ id: z.coerce.number().int().positive() });

export interface DispatchResult { sent: number; failed: number; retrying: number; skipped: number }

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  private readonly providers: Providers;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.providers = buildProviders(config.notifications);
  }

  /**
   * Sends what is queued for one branch. A message is first CLAIMED (marked "sending" with a lease), then sent outside the database
   * transaction, then marked sent or failed. If this process dies in between, the lease runs out and the message is picked up again,
   * so nothing is lost (it may rarely be sent twice, which is the safe way round for a booking confirmation).
   * A failure is retried with a growing delay (2, 4, 8 and 16 minutes) and then marked failed for a person to look at.
   */
  async dispatchBranch(branchId: string, limit: number = LIMITS.notificationBatch): Promise<DispatchResult> {
    const scope = { branchIds: [branchId], role: ROLE.OWNER };
    const claimed = await this.db.scoped(scope, async (c) =>
      (
        await c.query(
          `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, lease_until = now() + make_interval(mins => $3)
            WHERE id IN (
              SELECT id FROM notification_outbox
               WHERE branch_id = $1 AND ((status = 'queued' AND next_attempt_at <= now()) OR (status = 'sending' AND lease_until <= now()))
               ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
            RETURNING id, channel, to_address AS "to", subject, body, attempts`,
          [branchId, limit, LIMITS.notificationLeaseMinutes],
        )
      ).rows,
    );
    const out: DispatchResult = { sent: 0, failed: 0, retrying: 0, skipped: 0 };
    for (const m of claimed) {
      const provider = m.channel === 'email' ? this.providers.email : m.channel === 'sms' ? this.providers.sms : null;
      if (!provider) {
        await this.db.scoped(scope, (c) => c.query(`UPDATE notification_outbox SET status = 'skipped', lease_until = NULL, last_error = $2 WHERE id = $1`, [m.id, `No ${m.channel} sending is set up for this club.`]));
        out.skipped++;
        continue;
      }
      try {
        const r = await provider.send({ to: m.to, subject: m.subject, body: m.body });
        await this.db.scoped(scope, (c) => c.query(`UPDATE notification_outbox SET status = 'sent', sent_at = now(), lease_until = NULL, last_error = NULL, provider_ref = $2 WHERE id = $1`, [m.id, r.ref ?? null]));
        out.sent++;
      } catch (e: unknown) {
        const giveUp = (m.attempts as number) >= LIMITS.notificationMaxAttempts;
        const reason = errorMessage(e).slice(0, 300); // the provider's reason; never the message text
        await this.db.scoped(scope, (c) =>
          c.query(
            `UPDATE notification_outbox SET status = $2, lease_until = NULL, last_error = $3, next_attempt_at = now() + make_interval(mins => $4) WHERE id = $1`,
            [m.id, giveUp ? 'failed' : 'queued', reason, 2 ** (m.attempts as number)],
          ),
        );
        if (giveUp) out.failed++; else out.retrying++;
        this.log.warn(`Message ${m.id} (${m.channel} to ${mask(m.to as string)}) ${giveUp ? 'failed for good' : 'will be retried'}: ${reason}`);
      }
    }
    return out;
  }

  /** Sends now, for the branches the person works in. */
  async dispatchFor(user: AuthUser): Promise<DispatchResult> {
    const total: DispatchResult = { sent: 0, failed: 0, retrying: 0, skipped: 0 };
    for (const branchId of user.branchIds) {
      const r = await this.dispatchBranch(branchId);
      total.sent += r.sent; total.failed += r.failed; total.retrying += r.retrying; total.skipped += r.skipped;
    }
    return total;
  }

  /** What was queued and what became of it. The text of a message is not listed, and the address is masked. */
  async list(query: unknown, user: AuthUser) {
    const q = parse(ListQuery, query);
    const branchId = q.branchId ?? (user.branchIds.length === 1 ? user.branchIds[0] : undefined);
    if (!branchId) throw new BadRequestException({ message: 'branchId is required.', problems: [{ field: 'branchId', message: 'is required for people who work in more than one branch' }] });
    if (!user.branchIds.includes(branchId)) throw new NotFoundException('Branch not found.');
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const rows = (
        await c.query(
          `SELECT n.id, n.event, n.channel, n.to_address AS "to", n.subject, n.status, n.attempts, n.last_error AS "lastError", n.created_at AS "createdAt", n.sent_at AS "sentAt",
                  a.full_name AS "recipientName", count(*) OVER ()::int AS total
             FROM notification_outbox n JOIN accounts a ON a.id = n.account_id
            WHERE n.branch_id = $1 AND ($2::text IS NULL OR n.status = $2)
            ORDER BY n.id DESC LIMIT $3 OFFSET $4`,
          [branchId, q.status ?? null, q.limit, q.offset],
        )
      ).rows;
      return { total: rows[0]?.total ?? 0, messages: rows.map(({ total: _total, to, ...r }) => ({ ...r, to: mask(String(to)) })) };
    });
  }

  /** Puts a failed or skipped message back in the queue (for example after the email settings were fixed). */
  async retry(rawId: string, user: AuthUser) {
    const { id } = parse(IdParam, { id: rawId });
    return this.db.scoped({ branchIds: user.branchIds, role: user.role }, async (c) => {
      const r = (
        await c.query(`UPDATE notification_outbox SET status = 'queued', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND status IN ('failed', 'skipped') RETURNING branch_id AS "branchId"`, [id])
      ).rows[0];
      if (!r) throw new NotFoundException('There is no failed or skipped message with that number.');
      await writeAudit(c, user, r.branchId, AUDIT.NOTIFICATION_RETRY, ENTITY.NOTIFICATION, String(id), {});
      return { id, status: 'queued' };
    });
  }

  async getPreferences(user: AuthUser) {
    const r = (await this.db.query(`SELECT email_enabled AS "emailEnabled", sms_enabled AS "smsEnabled", push_enabled AS "pushEnabled" FROM notification_preferences WHERE account_id = $1`, [user.id])).rows[0];
    return r ?? { emailEnabled: true, smsEnabled: true, pushEnabled: true };
  }

  /** Reminders follow these choices. Confirmations, receipts, cancellations and waitlist offers are sent regardless. */
  async setPreferences(body: unknown, user: AuthUser) {
    const p = parse(Preferences, body);
    await this.db.query(
      `INSERT INTO notification_preferences (account_id, email_enabled, sms_enabled, push_enabled) VALUES ($1, coalesce($2, true), coalesce($3, true), coalesce($4, true))
       ON CONFLICT (account_id) DO UPDATE SET email_enabled = coalesce($2, notification_preferences.email_enabled), sms_enabled = coalesce($3, notification_preferences.sms_enabled),
         push_enabled = coalesce($4, notification_preferences.push_enabled), updated_at = now()`,
      [user.id, p.emailEnabled ?? null, p.smsEnabled ?? null, p.pushEnabled ?? null],
    );
    return this.getPreferences(user);
  }
}
