// Messages: queued with the change that causes them, sent with retries, essential ones always, reminders only if wanted.
// Everything runs in a private branch, because the sender works on a whole branch and other test files run at the same time.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DbService } from '../src/db/db.service.ts';
import { NotificationsService } from '../src/notifications/notifications.service.ts';
import { channelsFor } from '../src/notifications/outbox.ts';
import { render } from '../src/notifications/templates.ts';
import { api, ctx, makeBranch, startApp, stopApp } from './helpers.ts';
import type { Json } from './helpers.ts';
import { balanceOf, DAY, HOUR, makeClass, makePackage } from './booking-helpers.ts';
import { customer, staff } from './flow-helpers.ts';

let branch = '';
let manager: { id: string; token: string };
let reception: { id: string; token: string };
const svc = () => ctx.app.get(NotificationsService) as NotificationsService;
type Provider = { send: (m: { to: string; subject: string; body: string }) => Promise<{ ref?: string }> };
const providers = () => (svc() as unknown as { providers: { email: Provider | null; sms: Provider | null } }).providers;

before(async () => {
  await startApp();
  branch = await makeBranch();
  manager = await staff('manager', [branch]);
  reception = await staff('reception', [branch]);
});
after(stopApp);

const classIn = async (hoursAhead: number, o: { capacity?: number; priceMinor?: number } = {}) => {
  const id = await makeClass({ branchId: branch, startsAt: Date.now() + hoursAhead * HOUR, capacity: o.capacity });
  await ctx.admin.query(`UPDATE occurrences SET price_minor = $2, title = 'Jumping basics' WHERE id = $1`, [id, o.priceMinor ?? 0]);
  return id;
};
const family = () => customer({ branchId: branch });
const rows = async (accountId: string) =>
  (await ctx.admin.query(`SELECT id, event, channel, status, subject, body, to_address, attempts, last_error, dedupe_key FROM notification_outbox WHERE account_id = $1 ORDER BY id`, [accountId])).rows;
const events = async (accountId: string) => (await rows(accountId)).map((r) => r.event as string);
const book = (token: string, occurrenceId: string, riderId: string) => api('POST', '/bookings', { token, body: { occurrenceId, riderId, payWith: 'office' } });
const dispatch = () => api('POST', '/notifications/dispatch', { token: manager.token, body: {} });

describe('messages that follow what people do', () => {
  test('booking, paying, then cancelling queue a message each, to the family, with the right words', async () => {
    const f = await family();
    const cls = await classIn(30, { priceMinor: 12000 });
    const b = await book(f.token, cls, f.riderId);
    assert.equal(b.status, 201, b.text);
    assert.deepEqual(await events(f.id), ['booking.pending_payment']);
    const held = (await rows(f.id))[0];
    assert.equal(held.channel, 'email');
    assert.match(held.subject, /Place held: Jumping basics/);
    assert.match(held.body, /SAR 120\.00/);

    const paid = await api('POST', `/bookings/${b.body.id}/payment`, { token: reception.token, body: { method: 'cash', amountMinor: 12000 } });
    assert.equal(paid.status, 201, paid.text);
    assert.deepEqual(await events(f.id), ['booking.pending_payment', 'payment.received']);
    assert.match((await rows(f.id))[1].subject, /^Receipt R-\d+/);

    assert.equal((await api('POST', `/bookings/${b.body.id}/cancel`, { token: f.token, body: { cause: 'customer' } })).status, 201);
    assert.equal((await events(f.id)).at(-1), 'booking.cancelled');
  });

  test('a refund tells the family how much, and why', async () => {
    const f = await family();
    const b = await book(f.token, await classIn(32, { priceMinor: 11500 }), f.riderId);
    await api('POST', `/bookings/${b.body.id}/payment`, { token: reception.token, body: { method: 'cash', amountMinor: 11500 } });
    const receipt = (await ctx.admin.query(`SELECT id FROM receipts WHERE for_booking_id = $1`, [b.body.id])).rows[0].id;
    assert.equal((await api('POST', `/receipts/${receipt}/adjustments`, { token: manager.token, body: { kind: 'refund', amountMinor: 5000, reason: 'Class cut short' } })).status, 201);
    const m = (await rows(f.id)).find((x) => x.event === 'payment.refunded');
    assert.ok(m, 'told');
    assert.match(m.subject, /Refund processed: SAR 50\.00/);
    assert.match(m.body, /Class cut short/);
  });

  test('a package booking says confirmed, and the times are on the branch clock (Riyadh, UTC+3)', async () => {
    const f = await family();
    const pack = await makePackage(f.riderId, { balance: 3, branchId: branch });
    const cls = await classIn(30);
    const start = new Date((await ctx.admin.query(`SELECT lower(during) AS s FROM occurrences WHERE id = $1`, [cls])).rows[0].s);
    const r = await api('POST', '/bookings', { token: f.token, body: { occurrenceId: cls, riderId: f.riderId, payWith: 'package', packageId: pack } });
    assert.equal(r.status, 201, r.text);
    const m = (await rows(f.id))[0];
    assert.equal(m.event, 'booking.confirmed');
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: false }).format(start);
    assert.ok(m.body.includes(local), `the body shows ${local}`);
    assert.equal(await balanceOf(pack), 2);
  });

  test('cancelling the whole class tells every rider, with the reason, and says nobody is charged', async () => {
    const a = await family();
    const b = await family();
    const cls = await classIn(40);
    await book(a.token, cls, a.riderId);
    await book(b.token, cls, b.riderId);
    const r = await api('POST', `/schedule/${cls}/cancel`, { token: manager.token, body: { cause: 'weather', reason: 'Sandstorm' } });
    assert.equal(r.status, 201, r.text);
    for (const f of [a, b]) {
      const m = (await rows(f.id)).find((x) => x.event === 'class.cancelled');
      assert.ok(m, 'told');
      assert.match(m.body, /Sandstorm/);
      assert.match(m.body, /not been charged/);
    }
  });

  test('a free place opening on the waitlist tells the next rider, with the time to answer by', async () => {
    const first = await family();
    const second = await family();
    const cls = await classIn(50, { capacity: 1 });
    const booked = await book(first.token, cls, first.riderId);
    const wl = await book(second.token, cls, second.riderId);
    assert.equal(wl.body.status, 'waitlisted', wl.text);
    assert.deepEqual(await events(second.id), [], 'joining the waitlist sends nothing');
    assert.equal((await api('POST', `/bookings/${booked.body.id}/cancel`, { token: first.token, body: { cause: 'customer' } })).status, 201);
    const offer = (await rows(second.id)).find((x) => x.event === 'waitlist.offered');
    assert.ok(offer, 'offered');
    assert.match(offer.body, /Please accept it before/);
  });

  test('a high or critical incident tells the managers (not the person who reported it), and carries no description', async () => {
    const other = await staff('manager', [branch]);
    const create = (severity: string) => api('POST', '/incidents', { token: manager.token, body: { branchId: branch, severity, kind: 'rider_fall', description: 'SECRET medical detail', occurredAt: new Date(Date.now() - HOUR).toISOString() } });
    assert.equal((await create('low')).status, 201);
    assert.deepEqual(await events(other.id), [], 'a low incident sends nothing');
    const hi = await create('critical');
    assert.equal(hi.status, 201, hi.text);
    const m = (await rows(other.id)).find((x) => x.event === 'incident.escalated');
    assert.ok(m);
    assert.match(m.subject, /critical incident/i);
    assert.ok(!m.body.includes('SECRET'), 'the description never leaves the system');
    assert.ok(!(await events(manager.id)).includes('incident.escalated'), 'the reporter is not told about their own report');
  });

  test('nothing is queued when the action is refused, or for a rider nobody can be told about', async () => {
    const f = await family();
    const before = (await ctx.admin.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE branch_id = $1`, [branch])).rows[0].n;
    const cls = await classIn(60);
    assert.equal((await book(f.token, cls, '00000000-0000-0000-0000-00000000dead')).status >= 400, true, 'a refused booking');
    // a walk-in rider has no account and no guardian
    const walkIn = (await ctx.admin.query(`INSERT INTO riders (branch_id, full_name, date_of_birth, status, is_walk_in) VALUES ($1,'Walk In','1990-01-01','active',true) RETURNING id`, [branch])).rows[0].id;
    await ctx.admin.query(`INSERT INTO rider_documents (rider_id, kind, status, signed_at, expires_at) VALUES ($1,'medical_form','verified',now(),'2060-01-01'), ($1,'waiver','verified',now(),NULL)`, [walkIn]);
    const r = await api('POST', '/bookings', { token: reception.token, body: { occurrenceId: cls, riderId: walkIn, payWith: 'office' } });
    assert.equal(r.status, 201, r.text);
    const after = (await ctx.admin.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE branch_id = $1`, [branch])).rows[0].n;
    assert.equal(after, before, 'no recipients, so no messages');
  });
});

describe('who gets what, and on which channel', () => {
  const person = (o: Partial<Parameters<typeof channelsFor>[1]> = {}) => ({ id: 'x', email: 'a@b.test', phone: '0500000000', locale: 'en' as const, emailEnabled: true, smsEnabled: true, ...o });
  test('essential messages ignore opt-outs and use one channel; reminders follow the switches', () => {
    assert.deepEqual(channelsFor('essential', person({ emailEnabled: false, smsEnabled: false })), ['email']);
    assert.deepEqual(channelsFor('essential', person({ email: null })), ['sms']);
    assert.deepEqual(channelsFor('essential', person({ email: null, phone: null })), []);
    assert.deepEqual(channelsFor('reminder', person()), ['email', 'sms']);
    assert.deepEqual(channelsFor('reminder', person({ emailEnabled: false })), ['sms']);
    assert.deepEqual(channelsFor('reminder', person({ emailEnabled: false, smsEnabled: false })), []);
  });

  test('a reminder goes out once, only when wanted; a confirmation is sent even to someone who switched everything off', async () => {
    const wants = await family();
    const quiet = await family();
    const tokenQuiet = quiet.token;
    assert.equal((await api('PUT', '/notifications/preferences', { token: tokenQuiet, body: { emailEnabled: false, smsEnabled: false, pushEnabled: false } })).status, 200);
    const cls = await classIn(3);
    await book(wants.token, cls, wants.riderId);
    await book(quiet.token, cls, quiet.riderId);
    for (const f of [wants, quiet]) {
      const bk = (await ctx.admin.query(`SELECT id FROM bookings WHERE rider_id = $1`, [f.riderId])).rows[0].id;
      await ctx.admin.query(`UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, [bk]);
    }
    const run = () => api('POST', '/jobs/expiry', { token: manager.token, body: {} });
    const first = await run();
    assert.equal(first.status, 200, first.text);
    assert.ok(first.body.messagesQueued >= 1);
    await run();
    await run();
    assert.equal((await events(wants.id)).filter((e) => e === 'class.reminder').length, 1, 'once, however often the job runs');
    assert.ok(!(await events(quiet.id)).includes('class.reminder'), 'switched off, no reminder');
    assert.ok((await events(quiet.id)).includes('booking.pending_payment'), 'but the essential message was still sent');
  });

  test('a package running low or about to expire, and a document about to expire, each produce one reminder', async () => {
    const f = await family();
    const pack = await makePackage(f.riderId, { balance: 1, branchId: branch, validUntil: new Date(Date.now() + 3 * DAY).toISOString() });
    await ctx.admin.query(`INSERT INTO rider_documents (rider_id, kind, status, signed_at, expires_at) VALUES ($1,'photo_permission','verified',now(), now() + interval '5 days')`, [f.riderId]);
    for (let i = 0; i < 2; i++) await api('POST', '/jobs/expiry', { token: manager.token, body: {} });
    const ev = await events(f.id);
    assert.equal(ev.filter((e) => e === 'package.low_balance').length, 1);
    assert.equal(ev.filter((e) => e === 'package.expiring').length, 1);
    assert.equal(ev.filter((e) => e === 'document.expiring').length, 1);
    assert.match((await rows(f.id)).find((r) => r.event === 'document.expiring').subject, /photo permission/);
    void pack;
  });

  test('a person with only a phone is told by SMS, and with no SMS sending set up the message is recorded as skipped', async () => {
    const f = await family();
    await ctx.admin.query(`UPDATE accounts SET email = NULL, phone = $2 WHERE id = $1`, [f.id, `05${Math.floor(Math.random() * 1e8)}`]);
    await book(f.token, await classIn(70), f.riderId);
    const m = (await rows(f.id))[0];
    assert.equal(m.channel, 'sms');
    await dispatch();
    const after = (await rows(f.id))[0];
    assert.equal(after.status, 'skipped');
    assert.match(after.last_error, /No sms sending is set up/);
  });
});

describe('sending: retries, failure, recovery', () => {
  const oneMessage = async () => {
    const f = await family();
    await book(f.token, await classIn(80), f.riderId);
    return { f, id: (await rows(f.id))[0].id as string };
  };

  test('a queued message is sent, and the list shows it with the address masked and no text', async () => {
    const { f, id } = await oneMessage();
    const d = await dispatch();
    assert.equal(d.status, 200, d.text);
    assert.ok(d.body.sent >= 1);
    assert.equal((await rows(f.id))[0].status, 'sent');
    const list = await api('GET', `/notifications?branchId=${branch}&limit=200`, { token: manager.token });
    const m = (list.body.messages as Json[]).find((x) => String(x.id) === String(id));
    assert.ok(m);
    assert.equal(m.status, 'sent');
    assert.match(m.to, /^t\*\*\*@/, 'masked');
    assert.equal(m.body, undefined, 'the text is not listed');
    assert.ok(!JSON.stringify(list.body).includes('trot-test.invalid') || !JSON.stringify(list.body).includes(f.email), 'the full address is not listed');
  });

  test('a failure is retried later with a growing delay, and after 5 tries it is marked failed, then a manager can retry it', async () => {
    const { f, id } = await oneMessage();
    const original = providers().email;
    providers().email = { send: async () => { throw new Error('SMTP is down'); } };
    try {
      await dispatch();
      let m = (await rows(f.id))[0];
      assert.equal(m.status, 'queued');
      assert.equal(m.attempts, 1);
      assert.match(m.last_error, /SMTP is down/);
      const wait = (await ctx.admin.query(`SELECT extract(epoch from next_attempt_at - now()) AS s FROM notification_outbox WHERE id = $1`, [id])).rows[0].s;
      assert.ok(wait > 60 && wait < 300, `the first retry waits about 2 minutes (${wait}s)`);
      assert.equal((await dispatch()).body.retrying, 0, 'not tried again before its time');
      for (let i = 0; i < 4; i++) {
        await ctx.admin.query(`UPDATE notification_outbox SET next_attempt_at = now() WHERE id = $1`, [id]);
        await dispatch();
      }
      m = (await rows(f.id))[0];
      assert.equal(m.status, 'failed');
      assert.equal(m.attempts, 5);
    } finally { providers().email = original; }
    assert.equal((await api('POST', `/notifications/${id}/retry`, { token: reception.token, body: {} })).status, 403);
    assert.equal((await api('POST', `/notifications/${id}/retry`, { token: manager.token, body: {} })).status, 200);
    assert.equal((await rows(f.id))[0].status, 'queued');
    await dispatch();
    assert.equal((await rows(f.id))[0].status, 'sent', 'sent once the provider works again');
    assert.equal((await api('POST', `/notifications/${id}/retry`, { token: manager.token, body: {} })).status, 404, 'a sent message cannot be retried');
  });

  test('a message claimed by a sender that died is picked up again once its lease runs out, and not before', async () => {
    const { f, id } = await oneMessage();
    await ctx.admin.query(`UPDATE notification_outbox SET status = 'sending', attempts = 1, lease_until = now() + interval '3 minutes' WHERE id = $1`, [id]);
    await dispatch();
    assert.equal((await rows(f.id))[0].status, 'sending', 'still leased to the other sender');
    await ctx.admin.query(`UPDATE notification_outbox SET lease_until = now() - interval '1 minute' WHERE id = $1`, [id]);
    await dispatch();
    assert.equal((await rows(f.id))[0].status, 'sent');
  });

  test('two senders at the same moment never send the same message twice', async () => {
    const { f } = await oneMessage();
    let sends = 0;
    const original = providers().email;
    providers().email = { send: async () => { sends++; await new Promise((r) => setTimeout(r, 50)); return { ref: 'x' }; } };
    try {
      await Promise.all([svc().dispatchBranch(branch), svc().dispatchBranch(branch), svc().dispatchBranch(branch)]);
    } finally { providers().email = original; }
    const mine = (await rows(f.id))[0];
    assert.equal(mine.status, 'sent');
    const total = (await ctx.admin.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE branch_id = $1 AND status = 'sent'`, [branch])).rows[0].n;
    assert.ok(sends <= total, 'no message was sent more than once');
  });

  test('the same message cannot be queued twice for the same person and channel', async () => {
    const f = await family();
    await ctx.admin.query(`INSERT INTO notification_outbox (branch_id, account_id, event, channel, to_address, locale, subject, body, dedupe_key) VALUES ($1,$2,'class.reminder','email','a@b.test','en','s','b','same-key')`, [branch, f.id]);
    await assert.rejects(ctx.admin.query(`INSERT INTO notification_outbox (branch_id, account_id, event, channel, to_address, locale, subject, body, dedupe_key) VALUES ($1,$2,'class.reminder','email','a@b.test','en','s','b','same-key')`, [branch, f.id]), /duplicate key/);
  });
});

describe('who can see and change what', () => {
  test('only managers and owners list, send and retry; nobody signed in is refused', async () => {
    assert.equal((await api('GET', `/notifications?branchId=${branch}`)).status, 401);
    for (const [who, token] of [['reception', reception.token], ['coach', (await staff('coach', [branch])).token], ['customer', (await family()).token]] as const) {
      assert.equal((await api('GET', `/notifications?branchId=${branch}`, { token })).status, 403, who);
      assert.equal((await api('POST', '/notifications/dispatch', { token, body: {} })).status, 403, who);
    }
    assert.equal((await api('GET', `/notifications?branchId=${branch}`, { token: (await staff('owner', [branch])).token })).status, 200);
  });

  test('a manager of another branch cannot see this branch\'s messages', async () => {
    const elsewhere = await staff('manager', [await makeBranch()]);
    assert.equal((await api('GET', `/notifications?branchId=${branch}`, { token: elsewhere.token })).status, 404);
    const own = await api('GET', '/notifications', { token: elsewhere.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.total, 0);
  });

  test('anyone signed in can read and change their own reminder choices, and bad input is refused', async () => {
    const f = await family();
    assert.deepEqual((await api('GET', '/notifications/preferences', { token: f.token })).body, { emailEnabled: true, smsEnabled: true, pushEnabled: true });
    const changed = await api('PUT', '/notifications/preferences', { token: f.token, body: { smsEnabled: false } });
    assert.deepEqual(changed.body, { emailEnabled: true, smsEnabled: false, pushEnabled: true });
    assert.equal((await api('PUT', '/notifications/preferences', { token: f.token, body: {} })).status, 400);
    assert.equal((await api('PUT', '/notifications/preferences', { token: f.token, body: { emailEnabled: 'no' } })).status, 400);
    assert.equal((await api('GET', '/notifications/preferences')).status, 401);
    const other = await family();
    assert.equal((await api('GET', '/notifications/preferences', { token: other.token })).body.smsEnabled, true, 'someone else\'s choices are separate');
  });

  test('messages of one branch are invisible to the database role of another branch (row-level security)', async () => {
    const f = await family();
    await book(f.token, await classIn(90), f.riderId);
    const db = ctx.app.get(DbService) as DbService;
    const count = (branchIds: string[]) =>
      db.scoped({ branchIds, role: 'manager' }, async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = $1`, [f.id])).rows[0].n));
    assert.equal(await count([branch]), 1);
    assert.equal(await count([await makeBranch()]), 0);
  });
});

describe('the words', () => {
  const ctxEn = { locale: 'en' as const, timeZone: 'Asia/Riyadh', currency: 'SAR' };
  test('every event has a subject and a body, in plain text, and Arabic falls back to English until it is translated', () => {
    const events = ['booking.confirmed', 'booking.pending_payment', 'payment.received', 'payment.refunded', 'booking.cancelled', 'class.cancelled', 'waitlist.offered', 'class.reminder', 'package.low_balance', 'package.expiring', 'document.expiring', 'incident.escalated', 'assessment.decided'] as const;
    for (const e of events) {
      const r = render(e, { riderName: 'Amal', title: 'Jumping', startsAt: '2026-12-03T06:00:00.000Z', amountMinor: 12000, receiptNumber: 'R-1', balance: 1, severity: 'high', reference: 'abcd1234' }, ctxEn);
      assert.ok(r.subject.length > 3 && r.body.length > 10, e);
      assert.ok(!/[<>]/.test(r.subject + r.body), `${e} is plain text`);
      assert.deepEqual(render(e, { riderName: 'Amal' }, { ...ctxEn, locale: 'ar' }).subject, render(e, { riderName: 'Amal' }, ctxEn).subject);
    }
  });
  test('times are shown on the branch clock and money uses the branch currency', () => {
    const r = render('booking.pending_payment', { title: 'X', startsAt: '2026-12-03T06:00:00.000Z', amountMinor: 12050, holdMinutes: 30 }, ctxEn);
    assert.match(r.body, /09:00/);
    assert.match(r.body, /SAR 120\.50/);
    const ny = render('booking.pending_payment', { title: 'X', startsAt: '2026-12-03T06:00:00.000Z', amountMinor: 100 }, { ...ctxEn, timeZone: 'America/New_York', currency: 'USD' });
    assert.match(ny.body, /01:00/, '06:00 UTC is 01:00 in New York in December');
    assert.match(ny.body, /USD 1\.00/);
  });
});
