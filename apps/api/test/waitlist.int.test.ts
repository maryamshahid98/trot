import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ctx, makeBranch, randomDay, startApp, stopApp } from './helpers.ts';
import { balanceOf, codes, HOUR, liveBookings, makeClass, makePackage } from './booking-helpers.ts';
import { auditActions, customer, directBooking, entryStatus, post, staff, statusOf, waitlistEntryFor } from './flow-helpers.ts';

before(startApp);
after(stopApp);

const future = () => randomDay() + 8 * HOUR;
const book = (token: string, occurrenceId: string, riderId: string, payWith: 'office' | 'package' = 'office', packageId?: string) =>
  post('/bookings', token, { occurrenceId, riderId, payWith, packageId });
const cancel = (token: string, bookingId: string) => post(`/bookings/${bookingId}/cancel`, token, {});

/** A full class of capacity 1: `holder` has the place, `waiters` are in line in order. */
async function fullClass(waiterCount = 2, capacity = 1) {
  const occ = await makeClass({ startsAt: future(), capacity });
  const holders = [] as Awaited<ReturnType<typeof customer>>[];
  const bookingIds: string[] = [];
  for (let i = 0; i < capacity; i++) {
    const h = await customer();
    holders.push(h);
    bookingIds.push((await book(h.token, occ, h.riderId)).body.id);
  }
  const waiters = [] as (Awaited<ReturnType<typeof customer>> & { entryId: string })[];
  for (let i = 0; i < waiterCount; i++) {
    const w = await customer();
    const r = await book(w.token, occ, w.riderId);
    assert.equal(r.body.status, 'waitlisted', r.text);
    waiters.push({ ...w, entryId: r.body.waitlistEntryId });
  }
  return { occ, holders, bookingIds, waiters };
}

describe('offers when a place frees up', () => {
  test('cancelling offers the place to the first person in line, and only them', async () => {
    const f = await fullClass(2);
    const r = await cancel(f.holders[0].token, f.bookingIds[0]);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.waitlistOffers, 1);
    assert.equal(await entryStatus(f.waiters[0].entryId), 'offered');
    assert.equal(await entryStatus(f.waiters[1].entryId), 'active');
    assert.deepEqual(await auditActions(f.waiters[0].entryId), ['booking.waitlist', 'waitlist.offer']);
    const expires = (await ctx.admin.query(`SELECT extract(epoch from offer_expires_at - offered_at)/60 AS mins FROM waitlist_entries WHERE id = $1`, [f.waiters[0].entryId])).rows[0].mins;
    assert.equal(Math.round(Number(expires)), 120);
  });

  test('the customer sees the offer in their list', async () => {
    const f = await fullClass(1);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const mine = await api('GET', '/bookings/mine', { token: f.waiters[0].token });
    assert.equal(mine.body.waitlist[0].status, 'offered');
    assert.ok(mine.body.waitlist[0].offerExpiresAt);
  });

  test('a stranger cannot jump the queue for an offered place', async () => {
    const f = await fullClass(1);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const stranger = await customer();
    const r = await book(stranger.token, f.occ, stranger.riderId);
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'waitlisted', 'the place is promised to the person offered it');
    assert.equal(await liveBookings(f.occ), 0);
  });

  test('two places freed at once offer two people; a third keeps waiting', async () => {
    const f = await fullClass(3, 2);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    assert.deepEqual(await Promise.all(f.waiters.map((w) => entryStatus(w.entryId))), ['offered', 'active', 'active']);
    await cancel(f.holders[1].token, f.bookingIds[1]);
    assert.deepEqual(await Promise.all(f.waiters.map((w) => entryStatus(w.entryId))), ['offered', 'offered', 'active']);
  });

  test('someone who is no longer eligible is skipped but keeps their place in line', async () => {
    const f = await fullClass(2);
    await ctx.admin.query(`UPDATE rider_documents SET status = 'expired' WHERE rider_id = $1`, [f.waiters[0].riderId]);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    assert.equal(await entryStatus(f.waiters[0].entryId), 'active');
    assert.equal(await entryStatus(f.waiters[1].entryId), 'offered');
  });

  test('no offer is made for a class that has started, been cancelled or is not published', async () => {
    const f = await fullClass(1);
    await ctx.admin.query(`UPDATE occurrences SET status = 'draft' WHERE id = $1`, [f.occ]);
    const rec = await staff();
    const r = await post(`/bookings/${f.bookingIds[0]}/cancel`, rec.token, {});
    assert.equal(r.body.waitlistOffers, 0);
    assert.equal(await entryStatus(f.waiters[0].entryId), 'active');
  });

  test('a lapsed office hold frees its place, and staff can re-run the offers', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 1 });
    const holder = await customer();
    await directBooking({ occurrenceId: occ, riderId: holder.riderId, status: 'pending_office_payment', holdExpiresInMin: -5 });
    const w = await customer();
    await ctx.admin.query(`INSERT INTO waitlist_entries (occurrence_id, rider_id) VALUES ($1,$2)`, [occ, w.riderId]);
    const rec = await staff();
    const r = await post(`/schedule/${occ}/waitlist/refresh`, rec.token);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.offers.length, 1);
    assert.equal((await ctx.admin.query(`SELECT status FROM bookings WHERE rider_id = $1`, [holder.riderId])).rows[0].status, 'cancelled');
    assert.equal((await post(`/schedule/${occ}/waitlist/refresh`, (await customer()).token)).status, 403);
    assert.equal((await post(`/schedule/00000000-0000-0000-0000-00000000dead/waitlist/refresh`, rec.token)).status, 404);
    assert.equal((await post(`/schedule/${occ}/waitlist/refresh`, (await staff('manager', [await makeBranch()])).token)).status, 404);
  });
});

describe('POST /waitlist/:id/accept', () => {
  test('accepting an offer pays at the office: a pending booking with a hold, and the entry is used up', async () => {
    const f = await fullClass(1);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const w = f.waiters[0];
    const r = await post(`/waitlist/${w.entryId}/accept`, w.token, { payWith: 'office' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'pending_office_payment');
    assert.ok(r.body.holdExpiresAt);
    assert.equal(await entryStatus(w.entryId), 'converted');
    assert.equal(await liveBookings(f.occ), 1);
    assert.ok((await auditActions(w.entryId)).includes('waitlist.accept'));
  });

  test('accepting with a package confirms it and spends a class', async () => {
    const f = await fullClass(1);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const w = f.waiters[0];
    const pack = await makePackage(w.riderId, { balance: 2 });
    const r = await post(`/waitlist/${w.entryId}/accept`, w.token, { payWith: 'package', packageId: pack });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'confirmed');
    assert.equal(await balanceOf(pack), 1);
  });

  test('an empty package refuses the acceptance but keeps the offer open', async () => {
    const f = await fullClass(1);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const w = f.waiters[0];
    const pack = await makePackage(w.riderId, { balance: 0 });
    const r = await post(`/waitlist/${w.entryId}/accept`, w.token, { payWith: 'package', packageId: pack });
    assert.equal(r.status, 422);
    assert.deepEqual(codes(r), ['NO_PACKAGE_BALANCE']);
    assert.equal(await entryStatus(w.entryId), 'offered');
    assert.equal((await post(`/waitlist/${w.entryId}/accept`, w.token, { payWith: 'office' })).status, 201);
  });

  test('bad input, no token, wrong person, no offer yet, unknown id', async () => {
    const f = await fullClass(2);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const [first, second] = f.waiters;
    assert.equal((await post(`/waitlist/${first.entryId}/accept`, undefined, { payWith: 'office' })).status, 401);
    for (const body of [{}, { payWith: 'cash' }, { payWith: 'package' }, { payWith: 'office', packageId: first.riderId }]) {
      assert.equal((await post(`/waitlist/${first.entryId}/accept`, first.token, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(`/waitlist/${first.entryId}/accept`, second.token, { payWith: 'office' })).status, 404, "someone else's entry looks like it does not exist");
    const early = await post(`/waitlist/${second.entryId}/accept`, second.token, { payWith: 'office' });
    assert.equal(early.status, 409);
    assert.deepEqual(codes(early), ['NOT_OFFERED']);
    assert.equal((await post(`/waitlist/not-an-id/accept`, first.token, { payWith: 'office' })).status, 400);
    assert.equal((await post(`/waitlist/00000000-0000-0000-0000-00000000dead/accept`, first.token, { payWith: 'office' })).status, 404);
  });

  test('an expired offer is refused, closed, and the place goes to the next person', async () => {
    const f = await fullClass(2);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    await ctx.admin.query(`UPDATE waitlist_entries SET offer_expires_at = now() - interval '1 minute' WHERE id = $1`, [f.waiters[0].entryId]);
    const r = await post(`/waitlist/${f.waiters[0].entryId}/accept`, f.waiters[0].token, { payWith: 'office' });
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r), ['OFFER_EXPIRED']);
    assert.equal(await entryStatus(f.waiters[0].entryId), 'expired', 'the closing was saved, not rolled back');
    assert.equal(await entryStatus(f.waiters[1].entryId), 'offered');
    assert.equal(await liveBookings(f.occ), 0);
  });

  test('accepting twice at once makes one booking', async () => {
    const f = await fullClass(1);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const w = f.waiters[0];
    const rs = await Promise.all([post(`/waitlist/${w.entryId}/accept`, w.token, { payWith: 'office' }), post(`/waitlist/${w.entryId}/accept`, w.token, { payWith: 'office' })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await liveBookings(f.occ), 1);
  });

  test('staff can accept on behalf of a customer; other-branch staff cannot', async () => {
    const f = await fullClass(1);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const w = f.waiters[0];
    assert.equal((await post(`/waitlist/${w.entryId}/accept`, (await staff('manager', [await makeBranch()])).token, { payWith: 'office' })).status, 404);
    const r = await post(`/waitlist/${w.entryId}/accept`, (await staff()).token, { payWith: 'office' });
    assert.equal(r.status, 201, r.text);
    const src = (await ctx.admin.query(`SELECT source FROM bookings WHERE id = $1`, [r.body.id])).rows[0].source;
    assert.equal(src, 'staff_portal');
  });

  test('a coach cannot accept', async () => {
    const f = await fullClass(1);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    assert.equal((await post(`/waitlist/${f.waiters[0].entryId}/accept`, (await staff('coach')).token, { payWith: 'office' })).status, 403);
  });
});

describe('POST /waitlist/:id/leave', () => {
  test('leaving the line removes the entry and moves nobody ahead by accident', async () => {
    const f = await fullClass(2);
    const r = await post(`/waitlist/${f.waiters[0].entryId}/leave`, f.waiters[0].token);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'removed');
    assert.equal(await entryStatus(f.waiters[1].entryId), 'active', 'the class is still full, so no offer');
  });

  test('turning down an offer passes it on', async () => {
    const f = await fullClass(2);
    await cancel(f.holders[0].token, f.bookingIds[0]);
    const r = await post(`/waitlist/${f.waiters[0].entryId}/leave`, f.waiters[0].token);
    assert.equal(r.body.status, 'declined');
    assert.equal(r.body.waitlistOffers, 1);
    assert.equal(await entryStatus(f.waiters[1].entryId), 'offered');
  });

  test('leaving twice, someone else\'s entry, no token, bad id', async () => {
    const f = await fullClass(2);
    assert.equal((await post(`/waitlist/${f.waiters[0].entryId}/leave`, undefined)).status, 401);
    assert.equal((await post(`/waitlist/${f.waiters[0].entryId}/leave`, f.waiters[1].token)).status, 404);
    assert.equal((await post(`/waitlist/${f.waiters[0].entryId}/leave`, f.waiters[0].token)).status, 201);
    assert.equal((await post(`/waitlist/${f.waiters[0].entryId}/leave`, f.waiters[0].token)).status, 409);
    assert.equal((await post(`/waitlist/zzz/leave`, f.waiters[0].token)).status, 400);
  });

  test('after leaving, the rider can join again at the back', async () => {
    const f = await fullClass(1);
    const w = f.waiters[0];
    await post(`/waitlist/${w.entryId}/leave`, w.token);
    const again = await book(w.token, f.occ, w.riderId);
    assert.equal(again.status, 201);
    assert.equal(again.body.status, 'waitlisted');
    assert.equal(again.body.position, 1);
  });
});

describe('lapsed office holds', () => {
  test('a rider whose hold ran out can book the same class again, and the old booking is closed', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 2 });
    const c = await customer();
    const old = await directBooking({ occurrenceId: occ, riderId: c.riderId, status: 'pending_office_payment', holdExpiresInMin: -3 });
    const r = await book(c.token, occ, c.riderId);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'pending_office_payment');
    assert.equal(await statusOf(old), 'cancelled');
    assert.ok((await auditActions(old)).includes('booking.hold_expired'));
  });

  test('a lapsed hold frees the last place for the next person', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 1 });
    const a = await customer();
    const b = await customer();
    await directBooking({ occurrenceId: occ, riderId: a.riderId, status: 'pending_office_payment', holdExpiresInMin: -3 });
    const r = await book(b.token, occ, b.riderId);
    assert.equal(r.body.status, 'pending_office_payment');
  });

  test('the roster does not list a lapsed hold', async () => {
    const occ = await makeClass({ startsAt: future(), capacity: 3 });
    const live = await customer();
    const lapsed = await customer();
    await directBooking({ occurrenceId: occ, riderId: live.riderId, status: 'pending_office_payment', holdExpiresInMin: 5 });
    await directBooking({ occurrenceId: occ, riderId: lapsed.riderId, status: 'pending_office_payment', holdExpiresInMin: -5 });
    const r = await api('GET', `/bookings?occurrenceId=${occ}`, { token: (await staff()).token });
    assert.deepEqual(r.body.bookings.map((b: any) => b.riderId), [live.riderId]);
  });
});

describe('races around the last place', () => {
  test('a cancellation and several new bookings at once never overfill the class', async () => {
    const f = await fullClass(0);
    const newcomers = await Promise.all(Array.from({ length: 4 }, () => customer()));
    const results = await Promise.all([cancel(f.holders[0].token, f.bookingIds[0]), ...newcomers.map((n) => book(n.token, f.occ, n.riderId))]);
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
    assert.ok((await liveBookings(f.occ)) <= 1, 'capacity is 1');
    const offered = (await ctx.admin.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE occurrence_id = $1 AND status = 'offered'`, [f.occ])).rows[0].n;
    assert.ok((await liveBookings(f.occ)) + offered <= 1, 'a place is either taken or promised, never both');
  });

  test('every waiting rider is findable by their entry', async () => {
    const f = await fullClass(2);
    assert.equal(await waitlistEntryFor(f.occ, f.waiters[1].riderId), f.waiters[1].entryId);
  });
});
