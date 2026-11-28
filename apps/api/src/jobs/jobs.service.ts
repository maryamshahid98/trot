import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import { MS } from '@trot/domain';
import { expireStaleHolds, lockOccurrence, promoteWaitlist, toOccurrence } from '../bookings/core.ts';
import { writeAudit } from '../common/audit.ts';
import { loadPolicy } from '../common/policy.ts';
import { AUDIT, BOOKING_STATUS, DOC_STATUS, ENTITY, LEDGER_REASON, LIMITS, OCCURRENCE_STATUS, PACKAGE_STATUS, ROLE, WAITLIST_STATUS } from '../config/constants.ts';
import { APP_CONFIG } from '../config/env.ts';
import type { AppConfig } from '../config/env.ts';
import { DbService } from '../db/db.service.ts';
import { NotificationsService } from '../notifications/notifications.service.ts';
import { queueForRider } from '../notifications/outbox.ts';
import { errorMessage } from '../common/errors.ts';

export interface JobResult { branches: number; holdsReleased: number; offersPassedOn: number; packagesExpired: number; messagesQueued: number; messagesSent: number }

/**
 * The work nobody should have to remember: releasing unpaid holds, passing a place on when an offer is not answered,
 * and expiring packages that ran out of time. It is safe to run twice at once or twice in a row; the second run finds nothing to do.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobsService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap() {
    const seconds = this.config.jobs.intervalSeconds;
    if (seconds <= 0) return;
    this.timer = setInterval(() => {
      void this.runTimed();
    }, seconds * 1000);
    this.timer.unref(); // never keeps the process alive on its own
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scheduled run over every branch. Returns undefined when another server is already doing it. */
  async runScheduled(): Promise<JobResult | undefined> {
    // With several API servers on one database, only one of them runs the clean-up at a time.
    return this.db.withAdvisoryLock(LIMITS.jobAdvisoryLockKey, async () => {
      const all = (await this.db.query(`SELECT id::text FROM branches WHERE active`)).rows.map((r) => r.id as string);
      const r = await this.run(all, Date.now());
      if (r.holdsReleased + r.offersPassedOn + r.packagesExpired > 0) this.log.log(`Background job: ${JSON.stringify(r)}`);
      return r;
    });
  }

  private async runTimed() {
    if (this.running) return; // the last run is still going
    this.running = true;
    try {
      await this.runScheduled();
    } catch (e: unknown) {
      this.log.error(`Background job failed: ${errorMessage(e)}`);
    } finally {
      this.running = false;
    }
  }

  /** Runs the clean-up for these branches. Each branch is its own transaction, so one problem never blocks the others. */
  async run(branchIds: string[], now: number): Promise<JobResult> {
    const out: JobResult = { branches: branchIds.length, holdsReleased: 0, offersPassedOn: 0, packagesExpired: 0, messagesQueued: 0, messagesSent: 0 };
    for (const branchId of branchIds) {
      await this.db.scoped({ branchIds: [branchId], role: ROLE.OWNER }, async (c) => {
        const r = await this.classes(c, branchId, now);
        out.holdsReleased += r.holds;
        out.offersPassedOn += r.offers;
        out.packagesExpired += await this.packages(c, branchId, now);
        out.messagesQueued += await this.reminders(c, branchId, now);
      });
      // Send what is waiting (including what was just queued). A problem sending never stops the clean-up above.
      try { out.messagesSent += (await this.notifications.dispatchBranch(branchId)).sent; } catch (e: unknown) { this.log.error(`Sending messages failed for a branch: ${errorMessage(e)}`); }
    }
    return out;
  }

  /**
   * Queues the messages that are due because time has passed, not because someone did something: class reminders, packages running low
   * or about to expire, and documents about to expire. Safe to run as often as you like: the same message is never queued twice.
   */
  private async reminders(c: pg.PoolClient, branchId: string, now: number): Promise<number> {
    const n = this.config.notifications;
    const at = new Date(now).toISOString();
    let queued = 0;

    // Only riders somebody can be told about (their own account, or a guardian): otherwise the same rows would come back on every run.
    const hasContact = `(r.account_id IS NOT NULL OR EXISTS (SELECT 1 FROM guardian_riders g WHERE g.rider_id = r.id))`;

    const classes = (
      await c.query(
        `SELECT b.id, b.rider_id AS "riderId", b.occurrence_id AS "occurrenceId"
           FROM bookings b JOIN occurrences o ON o.id = b.occurrence_id JOIN riders r ON r.id = b.rider_id
          WHERE b.branch_id = $1 AND b.status = $2 AND o.status = $3
            AND lower(o.during) > $4::timestamptz AND lower(o.during) <= $4::timestamptz + make_interval(hours => $5)
            AND ${hasContact}
            AND NOT EXISTS (SELECT 1 FROM notification_outbox x WHERE x.dedupe_key = 'booking:' || b.id || ':reminder')
          ORDER BY lower(o.during) LIMIT $6`,
        [branchId, BOOKING_STATUS.CONFIRMED, OCCURRENCE_STATUS.PUBLISHED, at, n.reminderHours, LIMITS.jobBatchSize],
      )
    ).rows;
    for (const b of classes) {
      queued += await queueForRider(c, b.riderId, { event: 'class.reminder', branchId, occurrenceId: b.occurrenceId, dedupeKey: `booking:${b.id}:reminder`, data: {} });
    }

    const packages = (
      await c.query(
        `SELECT p.id, p.rider_id AS "riderId", t.name AS "packageName", p.valid_until AS "validUntil", bal.balance
           FROM rider_packages p JOIN package_types t ON t.id = p.package_type_id JOIN riders r ON r.id = p.rider_id
           JOIN LATERAL (SELECT coalesce(sum(l.delta), 0)::int AS balance FROM package_ledger l WHERE l.rider_package_id = p.id) bal ON true
          WHERE t.branch_id = $1 AND p.status = $2 AND p.valid_until > $3::timestamptz AND bal.balance > 0 AND ${hasContact}
            AND (bal.balance <= $4 OR p.valid_until <= $3::timestamptz + make_interval(days => $5))
          ORDER BY p.valid_until LIMIT $6`,
        [branchId, PACKAGE_STATUS.ACTIVE, at, n.lowBalanceClasses, n.packageExpiryNoticeDays, LIMITS.jobBatchSize],
      )
    ).rows;
    for (const p of packages) {
      const data = { packageName: p.packageName, balance: p.balance, validUntil: new Date(p.validUntil).toISOString() };
      if (p.balance <= n.lowBalanceClasses) queued += await queueForRider(c, p.riderId, { event: 'package.low_balance', branchId, dedupeKey: `package:${p.id}:low:${p.balance}`, data });
      if (Date.parse(p.validUntil) <= now + n.packageExpiryNoticeDays * MS.day) queued += await queueForRider(c, p.riderId, { event: 'package.expiring', branchId, dedupeKey: `package:${p.id}:expiring`, data });
    }

    const documents = (
      await c.query(
        `SELECT d.id, d.rider_id AS "riderId", d.kind, d.expires_at AS "expiresAt"
           FROM rider_documents d JOIN riders r ON r.id = d.rider_id
          WHERE r.branch_id = $1 AND d.status = $2 AND d.expires_at > $3::timestamptz AND d.expires_at <= $3::timestamptz + make_interval(days => $4) AND ${hasContact}
          ORDER BY d.expires_at LIMIT $5`,
        [branchId, DOC_STATUS.VERIFIED, at, n.documentExpiryNoticeDays, LIMITS.jobBatchSize],
      )
    ).rows;
    for (const d of documents) {
      queued += await queueForRider(c, d.riderId, { event: 'document.expiring', branchId, dedupeKey: `document:${d.id}:expiring`, data: { documentKind: String(d.kind).replace(/_/g, ' '), expiresAt: new Date(d.expiresAt).toISOString() } });
    }
    return queued;
  }

  private async classes(c: pg.PoolClient, branchId: string, now: number) {
    const iso = new Date(now).toISOString();
    const candidates: string[] = (
      await c.query(
        `SELECT o.id FROM occurrences o
          WHERE o.branch_id = $1 AND o.status = ANY($2::occurrence_status[])
            AND (EXISTS (SELECT 1 FROM bookings b WHERE b.occurrence_id = o.id AND b.status = $3 AND b.hold_expires_at <= $5::timestamptz)
              OR EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.occurrence_id = o.id AND w.status = $4 AND w.offer_expires_at <= $5::timestamptz))
          ORDER BY lower(o.during) LIMIT $6`,
        [branchId, [OCCURRENCE_STATUS.PUBLISHED, OCCURRENCE_STATUS.IN_PROGRESS], BOOKING_STATUS.PENDING_OFFICE_PAYMENT, WAITLIST_STATUS.OFFERED, iso, LIMITS.jobBatchSize],
      )
    ).rows.map((r) => r.id);
    let holds = 0;
    let offers = 0;
    const policy = await loadPolicy(c, branchId);
    for (const id of candidates) {
      // The class lock comes first, the same order as every booking action, so nothing waits on anything else.
      const row = await lockOccurrence(c, id);
      if (!row) continue;
      holds += await expireStaleHolds(c, id, branchId, now);
      const expiredBefore = Number((await c.query(`SELECT count(*) AS n FROM waitlist_entries WHERE occurrence_id = $1 AND status = $2`, [id, WAITLIST_STATUS.EXPIRED])).rows[0].n);
      await promoteWaitlist(c, { ...toOccurrence(row), branchId }, now, policy, null);
      offers += Number((await c.query(`SELECT count(*) AS n FROM waitlist_entries WHERE occurrence_id = $1 AND status = $2`, [id, WAITLIST_STATUS.EXPIRED])).rows[0].n) - expiredBefore;
    }
    return { holds, offers };
  }

  /** A package whose time ran out loses its remaining classes. The ledger records it, so the history stays complete. */
  private async packages(c: pg.PoolClient, branchId: string, now: number): Promise<number> {
    const due = (
      await c.query(
        `SELECT p.id, coalesce((SELECT sum(l.delta) FROM package_ledger l WHERE l.rider_package_id = p.id), 0)::int AS balance
           FROM rider_packages p JOIN package_types t ON t.id = p.package_type_id
          WHERE t.branch_id = $1 AND p.status = $2 AND p.valid_until <= $3::timestamptz ORDER BY p.valid_until LIMIT $4 FOR UPDATE OF p`,
        [branchId, PACKAGE_STATUS.ACTIVE, new Date(now).toISOString(), LIMITS.jobBatchSize],
      )
    ).rows;
    for (const p of due) {
      if (p.balance > 0) {
        await c.query(`INSERT INTO package_ledger (rider_package_id, delta, reason, ref_key, note) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (rider_package_id, ref_key) DO NOTHING`, [
          p.id, -p.balance, LEDGER_REASON.EXPIRY, `expiry:${p.id}`, 'Package expired',
        ]);
      }
      await c.query(`UPDATE rider_packages SET status = $2 WHERE id = $1`, [p.id, PACKAGE_STATUS.EXPIRED]);
      await writeAudit(c, null, branchId, AUDIT.PACKAGE_EXPIRED, ENTITY.PACKAGE, p.id, { classesLost: p.balance });
    }
    return due.length;
  }
}
