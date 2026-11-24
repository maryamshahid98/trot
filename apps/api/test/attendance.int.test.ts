import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ctx, makeBranch, startApp, stopApp } from './helpers.ts';
import { balanceOf, codes, makeClass, makePackage, readyRider } from './booking-helpers.ts';
import { auditActions, customer, directBooking, MIN, post, staff, statusOf } from './flow-helpers.ts';

before(startApp);
after(stopApp);

/** A class that starts `inMin` minutes from now (negative = already started). */
const classAt = (inMin: number, o: { hours?: number; coachId?: string; status?: string; capacity?: number } = {}) => makeClass({ startsAt: Date.now() + inMin * MIN, ...o });

describe('POST /bookings/:id/check-in', () => {
  test('no token, a customer and a stable hand are refused', async () => {
    const occ = await classAt(30);
    const b = await directBooking({ occurrenceId: occ, riderId: await readyRider() });
    assert.equal((await post(`/bookings/${b}/check-in`, undefined)).status, 401);
    assert.equal((await post(`/bookings/${b}/check-in`, (await customer()).token)).status, 403);
    assert.equal((await post(`/bookings/${b}/check-in`, (await staff('stable_hand')).token)).status, 403);
  });

  test('reception checks a rider in inside the window, and it is audited', async () => {
    const rec = await staff();
    const b = await directBooking({ occurrenceId: await classAt(30), riderId: await readyRider() });
    const r = await post(`/bookings/${b}/check-in`, rec.token);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'checked_in');
    assert.deepEqual(await auditActions(b), ['booking.check_in']);
  });

  test('too early, and after the class has ended', async () => {
    const rec = await staff();
    const early = await directBooking({ occurrenceId: await classAt(180), riderId: await readyRider() });
    const e = await post(`/bookings/${early}/check-in`, rec.token);
    assert.equal(e.status, 409);
    assert.deepEqual(codes(e), ['CHECKIN_TOO_EARLY']);
    const late = await directBooking({ occurrenceId: await classAt(-180, { hours: 1 }), riderId: await readyRider() });
    const l = await post(`/bookings/${late}/check-in`, rec.token);
    assert.equal(l.status, 409);
    assert.deepEqual(codes(l), ['CHECKIN_CLOSED']);
  });

  test('payment pending, already checked in, cancelled booking, cancelled class and suspended rider are each refused', async () => {
    const rec = await staff();
    const occ = await classAt(20);
    const unpaid = await directBooking({ occurrenceId: occ, riderId: await readyRider(), status: 'pending_office_payment', holdExpiresInMin: 10 });
    assert.deepEqual(codes(await post(`/bookings/${unpaid}/check-in`, rec.token)), ['PAYMENT_PENDING']);

    const once = await directBooking({ occurrenceId: occ, riderId: await readyRider() });
    assert.equal((await post(`/bookings/${once}/check-in`, rec.token)).status, 201);
    assert.deepEqual(codes(await post(`/bookings/${once}/check-in`, rec.token)), ['ALREADY_CHECKED_IN']);

    const gone = await directBooking({ occurrenceId: occ, riderId: await readyRider(), status: 'cancelled' });
    assert.deepEqual(codes(await post(`/bookings/${gone}/check-in`, rec.token)), ['NOT_CHECKABLE']);

    const cancelledClass = await classAt(20, { status: 'cancelled' });
    const inCancelled = await directBooking({ occurrenceId: cancelledClass, riderId: await readyRider() });
    assert.deepEqual(codes(await post(`/bookings/${inCancelled}/check-in`, rec.token)), ['CLASS_NOT_RUNNING']);

    const rider = await readyRider();
    const sus = await directBooking({ occurrenceId: occ, riderId: rider });
    await ctx.admin.query(`UPDATE riders SET status = 'suspended' WHERE id = $1`, [rider]);
    assert.deepEqual(codes(await post(`/bookings/${sus}/check-in`, rec.token)), ['RIDER_NOT_ACTIVE']);
  });

  test('a coach checks in their own class only; other branches and bad ids are 404 or 400', async () => {
    const coach = await staff('coach');
    const own = await directBooking({ occurrenceId: await classAt(20, { coachId: coach.id }), riderId: await readyRider() });
    const other = await directBooking({ occurrenceId: await classAt(20), riderId: await readyRider() });
    assert.equal((await post(`/bookings/${own}/check-in`, coach.token)).status, 201);
    assert.equal((await post(`/bookings/${other}/check-in`, coach.token)).status, 404);
    const outsider = await staff('manager', [await makeBranch()]);
    assert.equal((await post(`/bookings/${other}/check-in`, outsider.token)).status, 404);
    const rec = await staff();
    assert.equal((await post(`/bookings/nope/check-in`, rec.token)).status, 400);
    assert.equal((await post(`/bookings/00000000-0000-0000-0000-00000000dead/check-in`, rec.token)).status, 404);
  });

  test('two desks checking in at once: one succeeds', async () => {
    const a = await staff();
    const b = await staff('manager');
    const id = await directBooking({ occurrenceId: await classAt(20), riderId: await readyRider() });
    const rs = await Promise.all([post(`/bookings/${id}/check-in`, a.token), post(`/bookings/${id}/check-in`, b.token)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
  });
});

describe('POST /bookings/:id/no-show', () => {
  test('refused before the class starts, for customers, and without a token', async () => {
    const rec = await staff();
    const b = await directBooking({ occurrenceId: await classAt(60), riderId: await readyRider() });
    const r = await post(`/bookings/${b}/no-show`, rec.token);
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r), ['NO_SHOW_TOO_EARLY']);
    assert.equal((await post(`/bookings/${b}/no-show`, (await customer()).token)).status, 403);
    assert.equal((await post(`/bookings/${b}/no-show`, undefined)).status, 401);
  });

  test('a package booking that is a no-show keeps its class used; an unpaid office booking costs nothing', async () => {
    const rec = await staff();
    const occ = await classAt(-10, { hours: 2 });
    const rider = await readyRider();
    const pack = await makePackage(rider, { balance: 3 });
    const paid = await directBooking({ occurrenceId: occ, riderId: rider, packageId: pack });
    assert.equal(await balanceOf(pack), 2);
    const r = await post(`/bookings/${paid}/no-show`, rec.token);
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.status, r.body.consumedClass], ['no_show', true]);
    assert.equal(await balanceOf(pack), 2, 'no extra charge and no refund');

    const unpaid = await directBooking({ occurrenceId: occ, riderId: await readyRider(), status: 'pending_office_payment', holdExpiresInMin: 5 });
    const u = await post(`/bookings/${unpaid}/no-show`, rec.token);
    assert.equal(u.body.consumedClass, false);
  });

  test('an attended or cancelled booking cannot be a no-show; doing it twice is refused', async () => {
    const rec = await staff();
    const occ = await classAt(-10, { hours: 2 });
    const attended = await directBooking({ occurrenceId: occ, riderId: await readyRider(), status: 'checked_in' });
    assert.deepEqual(codes(await post(`/bookings/${attended}/no-show`, rec.token)), ['NOT_NO_SHOWABLE']);
    const b = await directBooking({ occurrenceId: occ, riderId: await readyRider() });
    assert.equal((await post(`/bookings/${b}/no-show`, rec.token)).status, 201);
    assert.equal((await post(`/bookings/${b}/no-show`, rec.token)).status, 409);
    assert.equal(await statusOf(b), 'no_show');
  });
});

describe('POST /schedule/:id/complete', () => {
  test('refused before the class starts, for customers and without a token; unknown class is 404', async () => {
    const mgr = await staff('manager');
    const occ = await classAt(60);
    const r = await post(`/schedule/${occ}/complete`, mgr.token);
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r), ['CLASS_NOT_STARTED']);
    assert.equal((await post(`/schedule/${occ}/complete`, (await customer()).token)).status, 403);
    assert.equal((await post(`/schedule/${occ}/complete`, undefined)).status, 401);
    assert.equal((await post(`/schedule/00000000-0000-0000-0000-00000000dead/complete`, mgr.token)).status, 404);
    assert.equal((await post(`/schedule/${occ}/complete`, mgr.token, { markRemainingNoShow: 'yes' })).status, 400);
  });

  test('people who were not checked in must be dealt with first; then everything is settled in one step', async () => {
    const mgr = await staff('manager');
    const occ = await classAt(-20, { hours: 2 });
    const here = await directBooking({ occurrenceId: occ, riderId: await readyRider(), status: 'checked_in' });
    const rider = await readyRider();
    const pack = await makePackage(rider, { balance: 2 });
    const absent = await directBooking({ occurrenceId: occ, riderId: rider, packageId: pack });
    const unpaid = await directBooking({ occurrenceId: occ, riderId: await readyRider(), status: 'pending_office_payment', holdExpiresInMin: 5 });
    await ctx.admin.query(`INSERT INTO waitlist_entries (occurrence_id, rider_id) VALUES ($1,$2)`, [occ, await readyRider()]);

    const blocked = await post(`/schedule/${occ}/complete`, mgr.token);
    assert.equal(blocked.status, 409);
    assert.deepEqual(codes(blocked), ['UNRESOLVED_BOOKINGS']);
    assert.equal(blocked.body.unresolved, 2);
    assert.equal(await statusOf(absent), 'confirmed', 'nothing changed by the refusal');

    const done = await post(`/schedule/${occ}/complete`, mgr.token, { markRemainingNoShow: true });
    assert.equal(done.status, 201, done.text);
    assert.deepEqual([done.body.completed, done.body.noShows], [1, 2]);
    assert.equal(await statusOf(here), 'completed');
    assert.equal(await statusOf(absent), 'no_show');
    assert.equal(await statusOf(unpaid), 'no_show');
    assert.equal((await ctx.admin.query(`SELECT status FROM occurrences WHERE id = $1`, [occ])).rows[0].status, 'completed');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE occurrence_id = $1 AND status = 'expired'`, [occ])).rows[0].n, 1);
    assert.equal(await balanceOf(pack), 1, 'the no-show kept its used class');
    assert.equal((await post(`/schedule/${occ}/complete`, mgr.token, { markRemainingNoShow: true })).status, 409, 'cannot complete twice');
  });

  test('a coach completes their own class only; reception may complete any', async () => {
    const coach = await staff('coach');
    const own = await classAt(-10, { coachId: coach.id });
    const other = await classAt(-10);
    assert.equal((await post(`/schedule/${other}/complete`, coach.token)).status, 404);
    assert.equal((await post(`/schedule/${own}/complete`, coach.token)).status, 201);
    assert.equal((await post(`/schedule/${other}/complete`, (await staff()).token)).status, 201);
  });
});

describe('POST /schedule/:id/cancel', () => {
  test('only a manager or owner may cancel a class; a reason is required', async () => {
    const occ = await classAt(500);
    for (const who of [await customer(), await staff('reception'), await staff('coach')]) assert.equal((await post(`/schedule/${occ}/cancel`, who.token, { reason: 'x' })).status, 403);
    assert.equal((await post(`/schedule/${occ}/cancel`, undefined, { reason: 'x' })).status, 401);
    const mgr = await staff('manager');
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x', cause: 'customer' }, { reason: 'x'.repeat(600) }]) {
      assert.equal((await post(`/schedule/${occ}/cancel`, mgr.token, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(`/schedule/${occ}/cancel`, (await staff('manager', [await makeBranch()])).token, { reason: 'x' })).status, 404);
  });

  test('every booking is cancelled as the club\'s doing, package classes come back, the waitlist closes', async () => {
    const mgr = await staff('manager');
    const occ = await classAt(500);
    const r1 = await readyRider();
    const pack = await makePackage(r1, { balance: 3 });
    const paid = await directBooking({ occurrenceId: occ, riderId: r1, packageId: pack });
    const office = await directBooking({ occurrenceId: occ, riderId: await readyRider(), status: 'pending_office_payment', holdExpiresInMin: 5 });
    const here = await directBooking({ occurrenceId: occ, riderId: await readyRider(), status: 'checked_in' });
    const waiter = await readyRider();
    await ctx.admin.query(`INSERT INTO waitlist_entries (occurrence_id, rider_id) VALUES ($1,$2)`, [occ, waiter]);
    assert.equal(await balanceOf(pack), 2);

    const r = await post(`/schedule/${occ}/cancel`, mgr.token, { reason: 'Arena flooded', cause: 'weather' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.bookingsCancelled, r.body.packageClassesReturned, r.body.waitlistClosed], [3, 1, 1]);
    for (const b of [paid, office, here]) assert.equal(await statusOf(b), 'cancelled');
    const row = (await ctx.admin.query(`SELECT cancel_cause, consumed_class FROM bookings WHERE id = $1`, [paid])).rows[0];
    assert.deepEqual(row, { cancel_cause: 'weather', consumed_class: false });
    assert.equal(await balanceOf(pack), 3);
    const d = (await ctx.admin.query(`SELECT detail::text AS d FROM audit_log WHERE entity_id = $1 AND action = 'class.cancel'`, [occ])).rows[0].d;
    assert.ok(d.includes('Arena flooded'));
  });

  test('cancelling twice, or a completed class, is refused; two managers at once refund once', async () => {
    const mgr = await staff('manager');
    const done = await classAt(-10);
    await post(`/schedule/${done}/complete`, mgr.token);
    assert.deepEqual(codes(await post(`/schedule/${done}/cancel`, mgr.token, { reason: 'x' })), ['CLASS_NOT_CANCELLABLE']);

    const occ = await classAt(500);
    const rider = await readyRider();
    const pack = await makePackage(rider, { balance: 2 });
    await directBooking({ occurrenceId: occ, riderId: rider, packageId: pack });
    const mgr2 = await staff('owner');
    const rs = await Promise.all([post(`/schedule/${occ}/cancel`, mgr.token, { reason: 'a' }), post(`/schedule/${occ}/cancel`, mgr2.token, { reason: 'b' })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await balanceOf(pack), 2);
  });

  test('a cancelled class can no longer be booked', async () => {
    const mgr = await staff('manager');
    const occ = await classAt(500);
    await post(`/schedule/${occ}/cancel`, mgr.token, { reason: 'closed' });
    const c = await customer();
    assert.equal((await post('/bookings', c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' })).status, 404);
  });
});
