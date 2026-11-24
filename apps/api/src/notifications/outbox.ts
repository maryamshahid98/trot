// Queuing messages. These are plain functions that take the caller's open transaction, so a message is saved (or not) together with the
// change that caused it. Nothing here sends anything: see NotificationsService for the sending.
import type { Tx } from '../common/sql.ts';
import { EVENT_KIND, render } from './templates.ts';
import type { Locale, NotifyData, NotifyEvent } from './templates.ts';

interface Recipient { id: string; email: string | null; phone: string | null; locale: Locale; emailEnabled: boolean; smsEnabled: boolean }

export interface QueueRequest {
  event: NotifyEvent;
  branchId: string;
  /** Makes queuing safe to repeat: the same key never produces a second message for the same person and channel. */
  dedupeKey: string;
  /** The class or ride the message is about: its title, start time and arena are looked up and added to the message. */
  occurrenceId?: string;
  data: NotifyData;
}

/** Which channels a person gets a message on. Essential messages ignore opt-outs; the person is reached on one channel (email first). */
export function channelsFor(kind: 'essential' | 'reminder', r: Recipient): ('email' | 'sms')[] {
  if (kind === 'essential') {
    if (r.email) return ['email'];
    if (r.phone) return ['sms'];
    return [];
  }
  const out: ('email' | 'sms')[] = [];
  if (r.email && r.emailEnabled) out.push('email');
  if (r.phone && r.smsEnabled) out.push('sms');
  return out;
}

async function queue(c: Tx, req: QueueRequest, recipients: Recipient[], riderName: string | null): Promise<number> {
  if (recipients.length === 0) return 0;
  const branch = (await c.query(`SELECT time_zone AS "timeZone", currency FROM branches WHERE id = $1`, [req.branchId])).rows[0];
  if (!branch) return 0;
  const kind = EVENT_KIND[req.event];
  let details: NotifyData = {};
  if (req.occurrenceId) {
    const o = (await c.query(`SELECT o.title, lower(o.during) AS "startsAt", a.name AS arena FROM occurrences o JOIN arenas a ON a.id = o.arena_id WHERE o.id = $1`, [req.occurrenceId])).rows[0];
    if (o) details = { title: o.title, startsAt: new Date(o.startsAt).toISOString(), arena: o.arena };
  }
  let queued = 0;
  for (const r of recipients) {
    const message = render(req.event, { riderName, ...details, ...req.data }, { locale: r.locale, timeZone: branch.timeZone as string, currency: branch.currency as string });
    for (const channel of channelsFor(kind, r)) {
      const res = await c.query(
        `INSERT INTO notification_outbox (branch_id, account_id, event, channel, to_address, locale, subject, body, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key, account_id, channel) DO NOTHING`,
        [req.branchId, r.id, req.event, channel, channel === 'email' ? r.email : r.phone, r.locale, message.subject, message.body, req.dedupeKey],
      );
      queued += res.rowCount ?? 0;
    }
  }
  return queued;
}

const RECIPIENT_COLUMNS = `a.id, a.email, a.phone, a.locale, coalesce(p.email_enabled, true) AS "emailEnabled", coalesce(p.sms_enabled, true) AS "smsEnabled"`;
const toRecipient = (r: Record<string, unknown>): Recipient => ({
  id: r.id as string, email: (r.email as string | null) ?? null, phone: (r.phone as string | null) ?? null,
  locale: r.locale === 'ar' ? 'ar' : 'en', emailEnabled: r.emailEnabled === true, smsEnabled: r.smsEnabled === true,
});

/** Tells the people who look after a rider: the rider's own account (an adult customer) and every guardian. A walk-in with no contact gets nothing. */
export async function queueForRider(c: Tx, riderId: string, req: QueueRequest): Promise<number> {
  const rider = (await c.query(`SELECT full_name AS "fullName" FROM riders WHERE id = $1`, [riderId])).rows[0];
  if (!rider) return 0;
  const people = (
    await c.query(
      `SELECT ${RECIPIENT_COLUMNS}
         FROM accounts a LEFT JOIN notification_preferences p ON p.account_id = a.id
        WHERE a.status = 'active' AND a.id IN (
          SELECT account_id FROM riders WHERE id = $1 AND account_id IS NOT NULL
          UNION SELECT guardian_account_id FROM guardian_riders WHERE rider_id = $1)`,
      [riderId],
    )
  ).rows.map(toRecipient);
  return queue(c, req, people, rider.fullName as string);
}

/** Tells specific accounts (for example the managers of a branch). */
export async function queueForAccounts(c: Tx, accountIds: string[], req: QueueRequest): Promise<number> {
  if (accountIds.length === 0) return 0;
  const people = (
    await c.query(`SELECT ${RECIPIENT_COLUMNS} FROM accounts a LEFT JOIN notification_preferences p ON p.account_id = a.id WHERE a.status = 'active' AND a.id = ANY($1::uuid[])`, [accountIds])
  ).rows.map(toRecipient);
  return queue(c, req, people, null);
}

/** The managers and owners who work in a branch. */
export async function branchManagers(c: Tx, branchId: string): Promise<string[]> {
  return (
    await c.query(`SELECT a.id FROM accounts a JOIN account_branches ab ON ab.account_id = a.id WHERE ab.branch_id = $1 AND a.role IN ('manager', 'owner') AND a.status = 'active'`, [branchId])
  ).rows.map((r) => r.id as string);
}
