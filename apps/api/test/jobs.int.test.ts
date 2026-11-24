import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DbService } from '../src/db/db.service.ts';
import { ctx, makeBranch, randomDay, startApp, stopApp } from './helpers.ts';
import { balanceOf, HOUR, makeClass, makePackage, readyRider } from './booking-helpers.ts';
import { auditActions, customer, directBooking, post, staff, statusOf } from './flow-helpers.ts';

before(startApp);
after(stopApp);

const run = (token?: string) => post('/jobs/expiry', token);
const future = () => randomDay() + 8 * HOUR;
const packageStatus = async (id: string): Promise<string> => (await ctx.admin.query(`SELECT status FROM rider_packages WHERE id = $1`, [id])).rows[0].status;
const waitlistRow = async (occurrenceId: string, riderId: string) => (await ctx.admin.query(`SELECT id, status FROM waitlist_entries WHERE occurrence_id = $1 AND rider_id = $2 ORDER BY joined_at DESC LIMIT 1`, [occurrenceId, riderId])).rows[0];
const addWaiting = async (occurrenceId: string, riderId: string, o: { status?: string; offerExpiresInMin?: number } = {}) =>
  (await ctx.admin.query(
    `INSERT INTO waitlist_entries (occurrence_id, rider_id, status, offered_at, offer_expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [occurrenceId, riderId, o.status ?? 'active', o.offerExpiresInMin === undefined ? null : new Date().toISOString(), o.offerExpiresInMin === undefined ? null : new Date(Date.now() + o.offerExpiresInMin * 60_000).toISOString()],
  )).rows[0].id;

describe('several servers', () => {
  test('only one server at a time holds the background-job lock', async () => {
    const db = ctx.app.get(DbService) as DbService;
    const key = 987_654_321; // a key of its own, so this test never touches the real job's lock
    let ranInner: boolean | undefined;
    const outer = await db.withAdvisoryLock(key, async () => {
      // A second server tries while the first still holds the lock: it must be told to skip, not wait or run.
      const other = new pg.Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
      try {
        const c = await other.connect();
        ranInner = (await c.query('SELECT pg_try_advisory_lock($1) AS ok', [key])).rows[0].ok;
        c.release();
      } finally {
        await other.end();
      }
      return 'ran';
    });
    assert.equal(outer, 'ran');
    assert.equal(ranInner, false, 'the second connection must not get the lock while the first holds it');
    assert.equal(await db.withAdvisoryLock(key, async () => 'again'), 'again', 'the lock is released afterwards');
  });
});

describe('who can run the job', () => {
  test('no token is refused; only managers and owners may run it', async () => {
    assert.equal((await run()).status, 401);
    for (const role of ['customer', 'coach', 'stable_hand', 'reception']) assert.equal((await run((await staff(role)).token)).status, 403, role);
    assert.equal((await run((await staff('manager')).token)).status, 200);
  });
});

describe('unpaid holds and waitlist offers', () => {
  test('a lapsed hold is released and the place is offered to the next person waiting', async () => {
    const manager = await staff('manager');
    const occurrenceId = await makeClass({ startsAt: future(), capacity: 1 });
    const holder = await readyRider();
    const waiting = await readyRider();
    const booking = await directBooking({ occurrenceId, riderId: holder, status: 'pending_office_payment', holdExpiresInMin: -5 });
    await addWaiting(occurrenceId, waiting);
    const res = await run(manager.token);
    assert.equal(res.status, 200);
    assert.ok(res.body.holdsReleased >= 1);
    assert.equal(await statusOf(booking), 'cancelled');
    assert.equal((await waitlistRow(occurrenceId, waiting)).status, 'offered');
    assert.ok((await auditActions(booking)).includes('booking.hold_expired'));
    const actor = (await ctx.admin.query(`SELECT actor_account_id FROM audit_log WHERE entity_id = $1 AND action = 'booking.hold_expired'`, [booking])).rows[0].actor_account_id;
    assert.equal(actor, null, 'a system action has no person behind it');
  });

  test('a hold that has not lapsed is left alone', async () => {
    const manager = await staff('manager');
    const occurrenceId = await makeClass({ startsAt: future(), capacity: 1 });
    const booking = await directBooking({ occurrenceId, riderId: await readyRider(), status: 'pending_office_payment', holdExpiresInMin: 30 });
    await run(manager.token);
    assert.equal(await statusOf(booking), 'pending_office_payment');
  });

  test('an offer nobody answered expires and the place goes to the next person in line', async () => {
    const manager = await staff('manager');
    const occurrenceId = await makeClass({ startsAt: future(), capacity: 1 });
    const slow = await readyRider();
    const next = await readyRider();
    await addWaiting(occurrenceId, slow, { status: 'offered', offerExpiresInMin: -10 });
    await addWaiting(occurrenceId, next);
    const res = await run(manager.token);
    assert.ok(res.body.offersPassedOn >= 1);
    assert.equal((await waitlistRow(occurrenceId, slow)).status, 'expired');
    assert.equal((await waitlistRow(occurrenceId, next)).status, 'offered');
  });

  test('an offer that is still open is left alone', async () => {
    const manager = await staff('manager');
    const occurrenceId = await makeClass({ startsAt: future(), capacity: 1 });
    const rider = await readyRider();
    await addWaiting(occurrenceId, rider, { status: 'offered', offerExpiresInMin: 60 });
    await run(manager.token);
    assert.equal((await waitlistRow(occurrenceId, rider)).status, 'offered');
  });

  test('a customer who lost a lapsed hold can book the class again afterwards', async () => {
    const manager = await staff('manager');
    const c = await customer();
    const occurrenceId = await makeClass({ startsAt: future(), capacity: 3 });
    await directBooking({ occurrenceId, riderId: c.riderId, status: 'pending_office_payment', holdExpiresInMin: -5 });
    await run(manager.token);
    assert.equal((await post('/bookings', c.token, { occurrenceId, riderId: c.riderId, payWith: 'office' })).status, 201);
  });

  test('running it twice in a row changes nothing the second time', async () => {
    const manager = await staff('manager');
    const occurrenceId = await makeClass({ startsAt: future(), capacity: 1 });
    await directBooking({ occurrenceId, riderId: await readyRider(), status: 'pending_office_payment', holdExpiresInMin: -5 });
    await addWaiting(occurrenceId, await readyRider());
    await run(manager.token);
    const again = await run(manager.token);
    assert.equal(again.body.holdsReleased, 0);
    assert.equal(again.body.offersPassedOn, 0);
  });

  test('two runs at the same moment do no harm', async () => {
    const manager = await staff('manager');
    const occurrenceId = await makeClass({ startsAt: future(), capacity: 1 });
    const booking = await directBooking({ occurrenceId, riderId: await readyRider(), status: 'pending_office_payment', holdExpiresInMin: -5 });
    const waiting = await readyRider();
    await addWaiting(occurrenceId, waiting);
    const results = await Promise.all([run(manager.token), run(manager.token)]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.equal(await statusOf(booking), 'cancelled');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE occurrence_id = $1 AND status = 'offered'`, [occurrenceId])).rows[0].n, 1);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'booking.hold_expired'`, [booking])).rows[0].n, 1);
  });

  test('a manager only cleans up their own branches', async () => {
    const other = await makeBranch();
    const otherManager = await staff('manager', [other]);
    const occurrenceId = await makeClass({ startsAt: future(), capacity: 1 });
    const booking = await directBooking({ occurrenceId, riderId: await readyRider(), status: 'pending_office_payment', holdExpiresInMin: -5 });
    assert.equal((await run(otherManager.token)).status, 200);
    assert.equal(await statusOf(booking), 'pending_office_payment');
  });
});

describe('packages', () => {
  test('a package past its end date expires, its remaining classes are taken off, and the history says why', async () => {
    const manager = await staff('manager');
    const rider = await readyRider();
    const pkg = await makePackage(rider, { balance: 4, validUntil: new Date(Date.now() - 60_000).toISOString() });
    const res = await run(manager.token);
    assert.ok(res.body.packagesExpired >= 1);
    assert.equal(await packageStatus(pkg), 'expired');
    assert.equal(await balanceOf(pkg), 0);
    const last = (await ctx.admin.query(`SELECT delta, reason, by_account FROM package_ledger WHERE rider_package_id = $1 ORDER BY at DESC, id DESC LIMIT 1`, [pkg])).rows[0];
    assert.deepEqual([last.delta, last.reason, last.by_account], [-4, 'expiry', null]);
    assert.deepEqual((await auditActions(pkg)).includes('package.expire'), true);
  });

  test('a package still in date, a frozen one, and one with no classes left are treated correctly', async () => {
    const manager = await staff('manager');
    const rider = await readyRider();
    const valid = await makePackage(rider, { balance: 3, validUntil: new Date(Date.now() + 86_400_000).toISOString() });
    const frozen = await makePackage(rider, { balance: 3, status: 'frozen', validUntil: new Date(Date.now() - 60_000).toISOString() });
    const empty = await makePackage(rider, { balance: 0, validUntil: new Date(Date.now() - 60_000).toISOString() });
    await run(manager.token);
    assert.equal(await packageStatus(valid), 'active');
    assert.equal(await balanceOf(valid), 3);
    assert.equal(await packageStatus(frozen), 'frozen');
    assert.equal(await balanceOf(frozen), 3);
    assert.equal(await packageStatus(empty), 'expired');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM package_ledger WHERE rider_package_id = $1`, [empty])).rows[0].n, 0);
  });

  test('an expired package cannot be used to book; running again changes nothing', async () => {
    const manager = await staff('manager');
    const c = await customer();
    const pkg = await makePackage(c.riderId, { balance: 2, validUntil: new Date(Date.now() - 60_000).toISOString() });
    await run(manager.token);
    const again = await run(manager.token);
    assert.equal(again.body.packagesExpired, 0);
    assert.equal(await balanceOf(pkg), 0);
    const occurrenceId = await makeClass({ startsAt: future() });
    assert.equal((await post('/bookings', c.token, { occurrenceId, riderId: c.riderId, payWith: 'package', packageId: pkg })).status, 422);
  });

  test('another branch cannot expire this branch packages', async () => {
    const otherManager = await staff('manager', [await makeBranch()]);
    const pkg = await makePackage(await readyRider(), { balance: 2, validUntil: new Date(Date.now() - 60_000).toISOString() });
    await run(otherManager.token);
    assert.equal(await packageStatus(pkg), 'active');
  });
});
