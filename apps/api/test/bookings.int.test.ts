import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BRANCH, ctx, makeAccount, makeBranch, randomDay, startApp, stopApp, tokenFor } from './helpers.ts';
import { balanceOf, codes, DAY, guard, HOUR, liveBookings, makeClass, makePackage, makeRider, readyRider, theCoach, verifyDocs } from './booking-helpers.ts';

before(startApp);
after(stopApp);

/** A customer with a token and a ready-to-book rider of their own. */
async function customer() {
  const acct = await makeAccount({ role: 'customer' });
  const token = await tokenFor(acct);
  const riderId = await readyRider({ accountId: acct.id });
  return { ...acct, token, riderId };
}
async function staff(role = 'reception', branchIds = [BRANCH]) {
  const acct = await makeAccount({ role, branchIds });
  return { ...acct, token: await tokenFor(acct) };
}
const book = (token: string | undefined, body: unknown) => api('POST', '/bookings', { token, body });
const future = () => randomDay() + 8 * HOUR;

describe('POST /bookings: access and input', () => {
  test('no token is refused', async () => {
    assert.equal((await book(undefined, {})).status, 401);
  });

  test('a coach cannot book', async () => {
    const coach = await staff('coach');
    assert.equal((await book(coach.token, {})).status, 403);
  });

  test('bad input is a 400 that names the fields', async () => {
    const c = await customer();
    for (const body of [
      {},
      { occurrenceId: 'nope', riderId: c.riderId, payWith: 'office' },
      { occurrenceId: await makeClass({ startsAt: future() }), riderId: c.riderId, payWith: 'cash' },
      { occurrenceId: await makeClass({ startsAt: future() }), riderId: c.riderId, payWith: 'package' }, // package needs an id
      { occurrenceId: await makeClass({ startsAt: future() }), riderId: c.riderId, payWith: 'office', packageId: c.riderId }, // office must not have one
    ]) {
      const r = await book(c.token, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(Array.isArray(r.body.problems) && r.body.problems.length > 0);
    }
    assert.equal((await api('POST', '/bookings', { token: c.token, rawBody: '{not json' })).status, 400);
  });

  test('an unknown class or rider is a 404', async () => {
    const c = await customer();
    const occ = await makeClass({ startsAt: future() });
    const ghost = '00000000-0000-0000-0000-00000000dead';
    assert.equal((await book(c.token, { occurrenceId: ghost, riderId: c.riderId, payWith: 'office' })).status, 404);
    assert.equal((await book(c.token, { occurrenceId: occ, riderId: ghost, payWith: 'office' })).status, 404);
  });
});

describe('POST /bookings: who may book for whom', () => {
  test("a customer cannot book someone else's rider, and cannot tell the rider exists", async () => {
    const a = await customer();
    const b = await customer();
    const occ = await makeClass({ startsAt: future() });
    const r = await book(a.token, { occurrenceId: occ, riderId: b.riderId, payWith: 'office' });
    assert.equal(r.status, 404);
    assert.equal(await liveBookings(occ), 0);
  });

  test('a guardian books for a ward', async () => {
    const parent = await makeAccount({ role: 'customer' });
    const token = await tokenFor(parent);
    const ward = await makeRider({ dob: '2015-05-05', name: 'Ward' });
    await verifyDocs(ward);
    await guard(parent.id, ward);
    const occ = await makeClass({ startsAt: future() });
    const r = await book(token, { occurrenceId: occ, riderId: ward, payWith: 'office' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'pending_office_payment');
  });

  test('a child with no guardian linked is refused', async () => {
    const acct = await makeAccount({ role: 'customer' });
    const token = await tokenFor(acct);
    const child = await makeRider({ accountId: acct.id, dob: '2015-05-05' });
    await verifyDocs(child);
    const r = await book(token, { occurrenceId: await makeClass({ startsAt: future() }), riderId: child, payWith: 'office' });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r), ['GUARDIAN_REQUIRED']);
  });

  test('reception books for any rider in the branch, and the booking is marked as made by staff', async () => {
    const rec = await staff();
    const rider = await readyRider();
    const occ = await makeClass({ startsAt: future() });
    const r = await book(rec.token, { occurrenceId: occ, riderId: rider, payWith: 'office' });
    assert.equal(r.status, 201, r.text);
    const row = (await ctx.admin.query(`SELECT source, created_by FROM bookings WHERE id = $1`, [r.body.id])).rows[0];
    assert.equal(row.source, 'staff_portal');
    assert.equal(row.created_by, rec.id);
  });

  test('staff in another branch cannot see or book the class', async () => {
    const otherBranch = await makeBranch();
    const outsider = await staff('reception', [otherBranch]);
    const rider = await readyRider();
    const occ = await makeClass({ startsAt: future() });
    assert.equal((await book(outsider.token, { occurrenceId: occ, riderId: rider, payWith: 'office' })).status, 404);
  });

  test('a rider from another branch cannot be put in this branch\'s class', async () => {
    const otherBranch = await makeBranch();
    const both = await staff('manager', [BRANCH, otherBranch]);
    const rider = await readyRider({ branchId: otherBranch });
    const occ = await makeClass({ startsAt: future() });
    const r = await book(both.token, { occurrenceId: occ, riderId: rider, payWith: 'office' });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r), ['RIDER_WRONG_BRANCH']);
  });
});

describe('POST /bookings: the rules', () => {
  test('paying with a package confirms the booking and uses one class', async () => {
    const c = await customer();
    const pack = await makePackage(c.riderId, { balance: 3 });
    const occ = await makeClass({ startsAt: future() });
    const r = await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'package', packageId: pack });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'confirmed');
    assert.equal(await balanceOf(pack), 2);
    const row = (await ctx.admin.query(`SELECT source, rider_package_id FROM bookings WHERE id = $1`, [r.body.id])).rows[0];
    assert.equal(row.source, 'customer_app');
    assert.equal(row.rider_package_id, pack);
  });

  test('paying at the office holds the place for a limited time and uses no package', async () => {
    const c = await customer();
    const occ = await makeClass({ startsAt: future() });
    const r = await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'pending_office_payment');
    const mins = (Date.parse(r.body.holdExpiresAt) - Date.now()) / 60_000;
    assert.ok(mins > 8 && mins <= 10, `hold was ${mins} minutes`);
  });

  test('every reason is returned at once', async () => {
    const acct = await makeAccount({ role: 'customer' });
    const token = await tokenFor(acct);
    const rider = await makeRider({ accountId: acct.id, level: 'beginner' }); // no documents
    const occ = await makeClass({ startsAt: future(), minLevel: 'advanced' });
    const r = await book(token, { occurrenceId: occ, riderId: rider, payWith: 'office' });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r).sort(), ['LEVEL_TOO_LOW', 'MEDICAL_MISSING', 'WAIVER_MISSING']);
  });

  test('a document that was submitted but not verified does not count', async () => {
    const acct = await makeAccount({ role: 'customer' });
    const token = await tokenFor(acct);
    const rider = await makeRider({ accountId: acct.id });
    await verifyDocs(rider, { status: 'submitted' });
    const r = await book(token, { occurrenceId: await makeClass({ startsAt: future() }), riderId: rider, payWith: 'office' });
    assert.deepEqual(codes(r).sort(), ['MEDICAL_MISSING', 'WAIVER_MISSING']);
  });

  test('a medical form that expires before the class is refused; one with no expiry date is accepted', async () => {
    const day = randomDay();
    const a = await makeAccount({ role: 'customer' });
    const ta = await tokenFor(a);
    const ra = await makeRider({ accountId: a.id });
    await verifyDocs(ra, { medicalExpiresAt: new Date(day - DAY).toISOString() });
    const occ = await makeClass({ startsAt: day + 8 * HOUR });
    const refused = await book(ta, { occurrenceId: occ, riderId: ra, payWith: 'office' });
    assert.deepEqual(codes(refused), ['MEDICAL_EXPIRED']);

    const b = await makeAccount({ role: 'customer' });
    const tb = await tokenFor(b);
    const rb = await makeRider({ accountId: b.id });
    await verifyDocs(rb, { medicalExpiresAt: null });
    assert.equal((await book(tb, { occurrenceId: occ, riderId: rb, payWith: 'office' })).status, 201);
  });

  test('a rider who is not approved is refused', async () => {
    const acct = await makeAccount({ role: 'customer' });
    const token = await tokenFor(acct);
    const rider = await makeRider({ accountId: acct.id, status: 'pending_review' });
    await verifyDocs(rider);
    const r = await book(token, { occurrenceId: await makeClass({ startsAt: future() }), riderId: rider, payWith: 'office' });
    assert.deepEqual(codes(r), ['RIDER_NOT_ACTIVE']);
  });

  test('a draft or cancelled class: customers get a 404, staff get the reason', async () => {
    const c = await customer();
    const rec = await staff();
    for (const status of ['draft', 'cancelled']) {
      const occ = await makeClass({ startsAt: future(), status });
      assert.equal((await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' })).status, 404, status);
      const r = await book(rec.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' });
      assert.equal(r.status, 422);
      assert.deepEqual(codes(r), ['CLASS_NOT_BOOKABLE']);
    }
  });

  test('a class that has started cannot be booked', async () => {
    const c = await customer();
    const occ = await makeClass({ startsAt: Date.now() - HOUR, hours: 3 });
    const r = await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r), ['CLASS_STARTED']);
  });

  test('booking the same class twice is refused', async () => {
    const c = await customer();
    const occ = await makeClass({ startsAt: future() });
    assert.equal((await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' })).status, 201);
    const again = await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' });
    assert.equal(again.status, 422);
    assert.deepEqual(codes(again), ['DUPLICATE_BOOKING']);
    assert.equal(await liveBookings(occ), 1);
  });

  test('two classes at the same time for one rider are refused', async () => {
    const c = await customer();
    const t = future();
    assert.equal((await book(c.token, { occurrenceId: await makeClass({ startsAt: t }), riderId: c.riderId, payWith: 'office' })).status, 201);
    const clash = await book(c.token, { occurrenceId: await makeClass({ startsAt: t + HOUR / 2 }), riderId: c.riderId, payWith: 'office' });
    assert.deepEqual(codes(clash), ['RIDER_OVERLAP']);
  });

  test('a third class on the same day is refused (limit is 2)', async () => {
    const c = await customer();
    const day = randomDay();
    for (const h of [8, 10]) assert.equal((await book(c.token, { occurrenceId: await makeClass({ startsAt: day + h * HOUR }), riderId: c.riderId, payWith: 'office' })).status, 201);
    const third = await book(c.token, { occurrenceId: await makeClass({ startsAt: day + 12 * HOUR }), riderId: c.riderId, payWith: 'office' });
    assert.deepEqual(codes(third), ['DAILY_LIMIT']);
  });

  test('a cancelled booking frees the slot to book again', async () => {
    const c = await customer();
    const occ = await makeClass({ startsAt: future() });
    const first = await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' });
    assert.equal((await api('POST', `/bookings/${first.body.id}/cancel`, { token: c.token, body: {} })).status, 201);
    assert.equal((await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' })).status, 201);
  });
});

describe('POST /bookings: packages', () => {
  test('an empty package is refused and nothing is written', async () => {
    const c = await customer();
    const pack = await makePackage(c.riderId, { balance: 0 });
    const occ = await makeClass({ startsAt: future() });
    const r = await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'package', packageId: pack });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r), ['NO_PACKAGE_BALANCE']);
    assert.equal(await liveBookings(occ), 0);
  });

  test("another rider's package cannot be used", async () => {
    const a = await customer();
    const b = await customer();
    const theirs = await makePackage(b.riderId, { balance: 5 });
    const r = await book(a.token, { occurrenceId: await makeClass({ startsAt: future() }), riderId: a.riderId, payWith: 'package', packageId: theirs });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r), ['PACKAGE_NOT_FOUND']);
    assert.equal(await balanceOf(theirs), 5);
  });

  test('a frozen package, an expired package and the wrong kind of class are each refused', async () => {
    const c = await customer();
    const day = randomDay();
    const frozen = await makePackage(c.riderId, { status: 'frozen' });
    const expired = await makePackage(c.riderId, { validUntil: new Date(day - DAY).toISOString() });
    const privateOnly = await makePackage(c.riderId, { formats: ['private'] });
    const occ = await makeClass({ startsAt: day + 8 * HOUR });
    const got = async (packageId: string) => codes(await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'package', packageId }));
    assert.deepEqual(await got(frozen), ['PACKAGE_NOT_ACTIVE']);
    assert.deepEqual(await got(expired), ['PACKAGE_EXPIRED']);
    assert.deepEqual(await got(privateOnly), ['PACKAGE_FORMAT_MISMATCH']);
    assert.equal(await liveBookings(occ), 0);
  });

  test('the last class in a package cannot be spent twice at the same moment', async () => {
    const c = await customer();
    const pack = await makePackage(c.riderId, { balance: 1 });
    const day = randomDay();
    const classes = [await makeClass({ startsAt: day + 8 * HOUR }), await makeClass({ startsAt: day + 8 * HOUR + DAY }), await makeClass({ startsAt: day + 8 * HOUR + 2 * DAY })];
    const results = await Promise.all(classes.map((occurrenceId) => book(c.token, { occurrenceId, riderId: c.riderId, payWith: 'package', packageId: pack })));
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    for (const r of results.filter((r) => r.status !== 201)) {
      assert.equal(r.status, 422);
      assert.deepEqual(codes(r), ['NO_PACKAGE_BALANCE']);
    }
    assert.equal(await balanceOf(pack), 0);
    const live = (await ctx.admin.query(`SELECT count(*)::int AS n FROM bookings WHERE rider_package_id = $1 AND status = 'confirmed'`, [pack])).rows[0].n;
    assert.equal(live, 1, 'a refused booking must not leave a row behind');
  });
});

describe('POST /bookings: full classes and the waitlist', () => {
  test('a full class puts the next rider on the waitlist, in order, and uses no package class', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 1 });
    const first = await customer();
    const second = await customer();
    const third = await customer();
    const pack = await makePackage(second.riderId, { balance: 2 });
    assert.equal((await book(first.token, { occurrenceId: occ, riderId: first.riderId, payWith: 'office' })).body.status, 'pending_office_payment');
    const w2 = await book(second.token, { occurrenceId: occ, riderId: second.riderId, payWith: 'package', packageId: pack });
    assert.equal(w2.status, 201, w2.text);
    assert.equal(w2.body.status, 'waitlisted');
    assert.equal(w2.body.position, 1);
    assert.equal(await balanceOf(pack), 2, 'waiting costs nothing');
    const w3 = await book(third.token, { occurrenceId: occ, riderId: third.riderId, payWith: 'office' });
    assert.equal(w3.body.position, 2);
    assert.equal(await liveBookings(occ), 1);
  });

  test('a rider already waiting cannot join twice', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 1 });
    const first = await customer();
    const second = await customer();
    await book(first.token, { occurrenceId: occ, riderId: first.riderId, payWith: 'office' });
    await book(second.token, { occurrenceId: occ, riderId: second.riderId, payWith: 'office' });
    const again = await book(second.token, { occurrenceId: occ, riderId: second.riderId, payWith: 'office' });
    assert.equal(again.status, 422);
    assert.deepEqual(codes(again), ['ALREADY_WAITLISTED']);
  });

  test('an ineligible rider cannot join the waitlist either', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 1 });
    const first = await customer();
    await book(first.token, { occurrenceId: occ, riderId: first.riderId, payWith: 'office' });
    const acct = await makeAccount({ role: 'customer' });
    const token = await tokenFor(acct);
    const rider = await makeRider({ accountId: acct.id }); // no documents
    assert.equal((await book(token, { occurrenceId: occ, riderId: rider, payWith: 'office' })).status, 422);
  });

  test('when many people ask for the last place at once, exactly one gets it', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 1 });
    const people = await Promise.all(Array.from({ length: 6 }, () => customer()));
    const results = await Promise.all(people.map((p) => book(p.token, { occurrenceId: occ, riderId: p.riderId, payWith: 'office' })));
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
    assert.equal(results.filter((r) => r.body.status === 'pending_office_payment').length, 1);
    assert.equal(results.filter((r) => r.body.status === 'waitlisted').length, 5);
    assert.equal(await liveBookings(occ), 1);
    const positions = results.filter((r) => r.body.status === 'waitlisted').map((r) => r.body.position).sort();
    assert.deepEqual(positions, [1, 2, 3, 4, 5]);
  });

  test('a double click never makes two bookings or two charges', async () => {
    const c = await customer();
    const pack = await makePackage(c.riderId, { balance: 3 });
    const occ = await makeClass({ startsAt: future() });
    const body = { occurrenceId: occ, riderId: c.riderId, payWith: 'package', packageId: pack };
    const results = await Promise.all([book(c.token, body), book(c.token, body), book(c.token, body)]);
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 422 || r.status === 409));
    assert.equal(await liveBookings(occ), 1);
    assert.equal(await balanceOf(pack), 2);
  });
});

describe('POST /bookings/:id/cancel', () => {
  async function booked(o: { startsAt: number; pay: 'package' | 'office' }) {
    const c = await customer();
    const pack = o.pay === 'package' ? await makePackage(c.riderId, { balance: 2 }) : undefined;
    const occ = await makeClass({ startsAt: o.startsAt });
    const r = await book(c.token, { occurrenceId: occ, riderId: c.riderId, payWith: o.pay, packageId: pack });
    assert.equal(r.status, 201, r.text);
    return { ...c, pack, occ, bookingId: r.body.id as string };
  }
  const cancel = (token: string | undefined, id: string, body: unknown = {}) => api('POST', `/bookings/${id}/cancel`, { token, body });

  test('no token, bad id and unknown id', async () => {
    const x = await booked({ startsAt: future(), pay: 'office' });
    assert.equal((await cancel(undefined, x.bookingId)).status, 401);
    assert.equal((await cancel(x.token, 'not-an-id')).status, 400);
    assert.equal((await cancel(x.token, '00000000-0000-0000-0000-00000000dead')).status, 404);
  });

  test('a coach cannot cancel', async () => {
    const x = await booked({ startsAt: future(), pay: 'office' });
    const coach = await staff('coach');
    assert.equal((await cancel(coach.token, x.bookingId)).status, 403);
  });

  test("a customer cannot cancel someone else's booking", async () => {
    const x = await booked({ startsAt: future(), pay: 'office' });
    const other = await customer();
    assert.equal((await cancel(other.token, x.bookingId)).status, 404);
    assert.equal(await liveBookings(x.occ), 1);
  });

  test('cancelling in good time gives the class back', async () => {
    const x = await booked({ startsAt: future(), pay: 'package' });
    assert.equal(await balanceOf(x.pack!), 1);
    const r = await cancel(x.token, x.bookingId);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'cancelled');
    assert.equal(r.body.consumedClass, false);
    assert.equal(r.body.returnedToPackage, true);
    assert.equal(await balanceOf(x.pack!), 2);
    assert.equal(await liveBookings(x.occ), 0);
  });

  test('cancelling late uses the class', async () => {
    const x = await booked({ startsAt: Date.now() + 2 * HOUR, pay: 'package' });
    const r = await cancel(x.token, x.bookingId);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.consumedClass, true);
    assert.equal(r.body.returnedToPackage, false);
    assert.equal(await balanceOf(x.pack!), 1);
    const row = (await ctx.admin.query(`SELECT status, consumed_class, cancel_cause FROM bookings WHERE id = $1`, [x.bookingId])).rows[0];
    assert.deepEqual(row, { status: 'cancelled', consumed_class: true, cancel_cause: 'customer' });
  });

  test('cancelling an office booking touches no package', async () => {
    const x = await booked({ startsAt: future(), pay: 'office' });
    const r = await cancel(x.token, x.bookingId);
    assert.equal(r.status, 201);
    assert.equal(r.body.returnedToPackage, false);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM package_ledger WHERE booking_id = $1`, [x.bookingId])).rows[0].n, 0);
  });

  test('cancelling twice, even at the same moment, refunds once', async () => {
    const x = await booked({ startsAt: future(), pay: 'package' });
    const results = await Promise.all([cancel(x.token, x.bookingId), cancel(x.token, x.bookingId), cancel(x.token, x.bookingId)]);
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal(await balanceOf(x.pack!), 2);
    const returns = (await ctx.admin.query(`SELECT count(*)::int AS n FROM package_ledger WHERE booking_id = $1 AND reason = 'return'`, [x.bookingId])).rows[0].n;
    assert.equal(returns, 1);
  });

  test('a customer cannot claim the club or the weather caused it; staff can, and the rider pays nothing', async () => {
    const x = await booked({ startsAt: Date.now() + 2 * HOUR, pay: 'package' });
    assert.equal((await cancel(x.token, x.bookingId, { cause: 'weather' })).status, 403);
    assert.equal((await cancel(x.token, x.bookingId, { cause: 'bogus' })).status, 400);
    const rec = await staff();
    const r = await cancel(rec.token, x.bookingId, { cause: 'weather' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.consumedClass, false);
    assert.equal(r.body.returnedToPackage, true);
    assert.equal(await balanceOf(x.pack!), 2);
  });

  test('a class that has already started cannot be cancelled by the customer', async () => {
    const x = await booked({ startsAt: Date.now() + 3 * HOUR, pay: 'office' });
    await ctx.admin.query(`UPDATE occurrences SET during = tstzrange(now() - interval '10 minutes', now() + interval '50 minutes') WHERE id = $1`, [x.occ]);
    const r = await cancel(x.token, x.bookingId);
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r), ['CANNOT_CANCEL']);
  });

  test('staff in another branch cannot cancel it', async () => {
    const x = await booked({ startsAt: future(), pay: 'office' });
    const outsider = await staff('reception', [await makeBranch()]);
    assert.equal((await cancel(outsider.token, x.bookingId)).status, 404);
  });

  test('every booking and cancellation is written to the audit log', async () => {
    const x = await booked({ startsAt: future(), pay: 'office' });
    await cancel(x.token, x.bookingId);
    const actions = (await ctx.admin.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at`, [x.bookingId])).rows.map((r: any) => r.action);
    assert.deepEqual(actions, ['booking.create', 'booking.cancel']);
  });
});

describe('GET /bookings (roster) and GET /bookings/mine', () => {
  test('roster: no token, wrong role, bad input', async () => {
    const c = await customer();
    assert.equal((await api('GET', '/bookings?occurrenceId=x')).status, 401);
    assert.equal((await api('GET', '/bookings?occurrenceId=00000000-0000-0000-0000-00000000dead', { token: c.token })).status, 403);
    const rec = await staff();
    assert.equal((await api('GET', '/bookings', { token: rec.token })).status, 400);
    assert.equal((await api('GET', '/bookings?occurrenceId=nope', { token: rec.token })).status, 400);
    assert.equal((await api('GET', '/bookings?occurrenceId=00000000-0000-0000-0000-00000000dead', { token: rec.token })).status, 404);
  });

  test('staff see the whole roster and waitlist, with no medical or contact details', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 1 });
    const a = await customer();
    const b = await customer();
    await book(a.token, { occurrenceId: occ, riderId: a.riderId, payWith: 'office' });
    await book(b.token, { occurrenceId: occ, riderId: b.riderId, payWith: 'office' });
    const rec = await staff();
    const r = await api('GET', `/bookings?occurrenceId=${occ}`, { token: rec.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.bookings.length, 1);
    assert.equal(r.body.waitlist.length, 1);
    for (const banned of ['medical', 'allergies', 'emergency', 'email', 'phone', 'dateOfBirth']) assert.ok(!r.text.toLowerCase().includes(banned.toLowerCase()), `${banned} leaked`);
  });

  test('a coach sees only their own classes', async () => {
    const mine = await staff('coach');
    const ownClass = await makeClass({ startsAt: future(), coachId: mine.id });
    const someoneElses = await makeClass({ startsAt: future(), coachId: await theCoach() });
    assert.equal((await api('GET', `/bookings?occurrenceId=${ownClass}`, { token: mine.token })).status, 200);
    assert.equal((await api('GET', `/bookings?occurrenceId=${someoneElses}`, { token: mine.token })).status, 404);
  });

  test("staff in another branch cannot read this branch's roster", async () => {
    const occ = await makeClass({ startsAt: future() });
    const outsider = await staff('manager', [await makeBranch()]);
    assert.equal((await api('GET', `/bookings?occurrenceId=${occ}`, { token: outsider.token })).status, 404);
  });

  test('mine: a customer sees their own and their wards, never anyone else\'s; staff are refused', async () => {
    const parent = await makeAccount({ role: 'customer' });
    const token = await tokenFor(parent);
    const self = await readyRider({ accountId: parent.id });
    const ward = await makeRider({ dob: '2015-05-05', name: 'Ward' });
    await verifyDocs(ward);
    await guard(parent.id, ward);
    const stranger = await customer();
    const t = future();
    await book(token, { occurrenceId: await makeClass({ startsAt: t }), riderId: self, payWith: 'office' });
    await book(token, { occurrenceId: await makeClass({ startsAt: t + DAY }), riderId: ward, payWith: 'office' });
    await book(stranger.token, { occurrenceId: await makeClass({ startsAt: t + 2 * DAY }), riderId: stranger.riderId, payWith: 'office' });
    const full = await makeClass({ startsAt: t + 3 * DAY, capacity: 1 });
    await book(stranger.token, { occurrenceId: full, riderId: stranger.riderId, payWith: 'office' });
    await book(token, { occurrenceId: full, riderId: self, payWith: 'office' });

    const r = await api('GET', '/bookings/mine', { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.bookings.length, 2);
    assert.deepEqual(new Set(r.body.bookings.map((x: any) => x.riderId)), new Set([self, ward]));
    assert.equal(r.body.waitlist.length, 1);
    assert.equal(r.body.waitlist[0].riderId, self);

    assert.equal((await api('GET', '/bookings/mine')).status, 401);
    assert.equal((await api('GET', '/bookings/mine', { token: (await staff()).token })).status, 403);
  });
});
