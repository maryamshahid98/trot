import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ctx, makeAccount, makeBranch, randomDay, startApp, stopApp } from './helpers.ts';
import { codes, DAY, HOUR, makeClass, makeRider, verifyDocs } from './booking-helpers.ts';
import { directBooking, staff } from './flow-helpers.ts';

before(startApp);
after(stopApp);

const get = (path: string, token?: string) => api('GET', path, { token });
const enc = encodeURIComponent;
let n = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const range = (day: number, days = 1) => `from=${enc(iso(day))}&to=${enc(iso(day + days * DAY))}`;
/** Each test works in a branch of its own, so other tests' data can never change its totals. */
async function world() {
  const branch = await makeBranch();
  const manager = await staff('manager', [branch]);
  return { branch, manager };
}
async function receipt(branch: string, by: string, o: { amount: number; vat?: number; method?: string; at: number }) {
  return (await ctx.admin.query(`INSERT INTO receipts (branch_id, number, amount_minor, vat_minor, method, issued_by, issued_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [branch, `T-${Date.now()}-${n++}`, o.amount, o.vat ?? 0, o.method ?? 'cash', by, iso(o.at)])).rows[0].id;
}
const rider = async (branch: string) => { const id = await makeRider({ branchId: branch }); await verifyDocs(id); return id; };

describe('who may read reports and the audit log', () => {
  test('no token is refused; only managers and owners may read', async () => {
    const day = randomDay();
    for (const path of [`/reports/revenue?${range(day)}`, `/reports/attendance?${range(day)}`, `/reports/utilisation?${range(day)}`, '/reports/unpaid', '/audit-log']) {
      assert.equal((await get(path)).status, 401, path);
      for (const role of ['customer', 'coach', 'stable_hand', 'reception']) assert.equal((await get(path, (await staff(role)).token)).status, 403, `${role} ${path}`);
      assert.equal((await get(path, (await staff('owner')).token)).status, 200, path);
    }
  });

  test('bad ranges and branches are refused', async () => {
    const { manager } = await world();
    const day = randomDay();
    for (const kind of ['revenue', 'attendance', 'utilisation']) {
      const base = `/reports/${kind}`;
      assert.equal((await get(`${base}?from=${enc(iso(day + DAY))}&to=${enc(iso(day))}`, manager.token)).status, 400, 'end before start');
      assert.equal((await get(`${base}?${range(day, 400)}`, manager.token)).status, 400, 'too long');
      assert.equal((await get(`${base}?from=nope&to=nope`, manager.token)).status, 400);
      assert.equal((await get(`${base}`, manager.token)).status, 400, 'missing range');
      assert.equal((await get(`${base}?${range(day)}&branchId=${await makeBranch()}`, manager.token)).status, 403, 'branch they do not work in');
    }
    const tooLong = await get(`/reports/revenue?${range(day, 400)}`, manager.token);
    assert.ok(codes(tooLong).includes('RANGE_TOO_LONG'));
  });
});

describe('revenue', () => {
  test('adds up receipts by method and day, less refunds, and leaves out other days and branches', async () => {
    const { branch, manager } = await world();
    const day = randomDay();
    const first = await receipt(branch, manager.id, { amount: 10000, vat: 1304, method: 'cash', at: day + 10 * HOUR });
    await receipt(branch, manager.id, { amount: 10000, vat: 1304, method: 'cash', at: day + 11 * HOUR });
    await receipt(branch, manager.id, { amount: 5000, vat: 652, method: 'card_at_desk', at: day + 12 * HOUR });
    await receipt(branch, manager.id, { amount: 99999, method: 'cash', at: day + 2 * DAY });
    const other = await makeBranch();
    await receipt(other, manager.id, { amount: 77777, method: 'cash', at: day + 10 * HOUR });
    // A refund counts on the day it was made, so these are made that same day (the default would be today, outside the report).
    await ctx.admin.query(`INSERT INTO financial_adjustments (branch_id, receipt_id, kind, amount_minor, reason, requested_by, created_at) VALUES ($1,$2,'refund',3000,'Class cancelled',$3,$4)`, [branch, first, manager.id, iso(day + 13 * HOUR)]);
    await ctx.admin.query(`INSERT INTO financial_adjustments (branch_id, receipt_id, kind, amount_minor, reason, requested_by, created_at) VALUES ($1,$2,'credit',500,'Goodwill',$3,$4)`, [branch, first, manager.id, iso(day + 13 * HOUR)]);
    const res = await get(`/reports/revenue?${range(day)}`, manager.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.receipts, 3);
    assert.equal(res.body.grossMinor, 25000);
    assert.equal(res.body.vatMinor, 3260);
    assert.equal(res.body.refundsMinor, 3000);
    assert.equal(res.body.netMinor, 22000);
    assert.equal(res.body.otherAdjustments.creditMinor, 500);
    assert.deepEqual(res.body.byMethod.map((m: any) => [m.method, m.receipts, m.amountMinor]), [['card_at_desk', 1, 5000], ['cash', 2, 20000]]);
    assert.deepEqual(res.body.byDay, [{ day: iso(day).slice(0, 10), amountMinor: 25000 }]);
  });

  test('an empty period reports zeros, not an error', async () => {
    const { manager } = await world();
    const res = await get(`/reports/revenue?${range(randomDay())}`, manager.token);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.receipts, res.body.grossMinor, res.body.netMinor], [0, 0, 0]);
    assert.deepEqual(res.body.byDay, []);
  });
});

describe('attendance', () => {
  test('counts who came and who did not for finished classes, overall and per coach', async () => {
    const { branch, manager } = await world();
    const coach = await makeAccount({ role: 'coach', branchIds: [branch] });
    const day = randomDay();
    const done = await makeClass({ branchId: branch, startsAt: day + 8 * HOUR, status: 'completed', coachId: coach.id });
    for (const status of ['completed', 'completed', 'completed', 'no_show', 'cancelled']) await directBooking({ occurrenceId: done, riderId: await rider(branch), status, branchId: branch });
    const notDone = await makeClass({ branchId: branch, startsAt: day + 10 * HOUR, status: 'published', coachId: coach.id });
    await directBooking({ occurrenceId: notDone, riderId: await rider(branch), status: 'confirmed', branchId: branch });
    const res = await get(`/reports/attendance?${range(day)}`, manager.token);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.classes, res.body.attended, res.body.noShows, res.body.cancelled, res.body.attendanceRate], [1, 3, 1, 1, 0.75]);
    assert.deepEqual(res.body.perCoach.map((c: any) => [c.coachId, c.classes, c.attended, c.noShows]), [[coach.id, 1, 3, 1]]);
  });

  test('no finished classes means no rate, not a divide-by-zero', async () => {
    const { manager } = await world();
    const res = await get(`/reports/attendance?${range(randomDay())}`, manager.token);
    assert.deepEqual([res.body.classes, res.body.attendanceRate, res.body.perCoach], [0, null, []]);
  });
});

describe('utilisation', () => {
  test('how full classes were, by arena; cancelled and draft classes are left out', async () => {
    const { branch, manager } = await world();
    const day = randomDay();
    const big = await makeClass({ branchId: branch, startsAt: day + 8 * HOUR, capacity: 10 });
    const small = await makeClass({ branchId: branch, startsAt: day + 10 * HOUR, capacity: 5 });
    for (let i = 0; i < 4; i++) await directBooking({ occurrenceId: big, riderId: await rider(branch), branchId: branch });
    await directBooking({ occurrenceId: big, riderId: await rider(branch), status: 'cancelled', branchId: branch });
    await directBooking({ occurrenceId: small, riderId: await rider(branch), branchId: branch });
    await makeClass({ branchId: branch, startsAt: day + 12 * HOUR, capacity: 50, status: 'cancelled' });
    await makeClass({ branchId: branch, startsAt: day + 14 * HOUR, capacity: 50, status: 'draft' });
    const res = await get(`/reports/utilisation?${range(day)}`, manager.token);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.classes, res.body.places, res.body.filled, res.body.utilisation], [2, 15, 5, 0.333]);
    assert.equal(res.body.byArena.length, 2);
  });
});

describe('unpaid', () => {
  test('lists riders let in without paying, with the reason, and leaves out paid and package bookings', async () => {
    const { branch, manager } = await world();
    const day = randomDay();
    const occurrenceId = await makeClass({ branchId: branch, startsAt: day + 8 * HOUR, capacity: 10 });
    await ctx.admin.query(`UPDATE occurrences SET price_minor = 15000 WHERE id = $1`, [occurrenceId]);
    const owing = await directBooking({ occurrenceId, riderId: await rider(branch), status: 'confirmed', payWith: 'office', branchId: branch });
    await ctx.admin.query(`INSERT INTO audit_log (actor_account_id, branch_id, action, entity, entity_id, detail) VALUES ($1,$2,'booking.confirm_unpaid','booking',$3,$4)`, [manager.id, branch, owing, JSON.stringify({ reason: 'Pays on Thursday' })]);
    const paid = await directBooking({ occurrenceId, riderId: await rider(branch), status: 'confirmed', payWith: 'office', branchId: branch });
    await ctx.admin.query(`INSERT INTO receipts (branch_id, number, amount_minor, method, for_booking_id, issued_by) VALUES ($1,$2,15000,'cash',$3,$4)`, [branch, `T-${Date.now()}-${n++}`, paid, manager.id]);
    await directBooking({ occurrenceId, riderId: await rider(branch), status: 'pending_office_payment', payWith: 'office', holdExpiresInMin: 5, branchId: branch });
    const res = await get('/reports/unpaid', manager.token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.unpaid.map((u: any) => [u.bookingId, u.reason, u.priceMinor]), [[owing, 'Pays on Thursday', 15000]]);
    assert.equal(res.body.owedMinor, 15000);
    assert.equal((await get('/reports/unpaid?limit=0', manager.token)).status, 400);
    assert.equal((await get('/reports/unpaid?limit=999', manager.token)).status, 400);
  });

  test('another branch sees none of it', async () => {
    const { branch, manager } = await world();
    const occurrenceId = await makeClass({ branchId: branch, startsAt: randomDay() + 8 * HOUR });
    await directBooking({ occurrenceId, riderId: await rider(branch), status: 'confirmed', payWith: 'office', branchId: branch });
    const other = await staff('manager', [await makeBranch()]);
    assert.deepEqual((await get('/reports/unpaid', other.token)).body.unpaid, []);
    assert.equal((await get('/reports/unpaid', manager.token)).body.unpaid.length, 1);
  });
});

describe('audit log', () => {
  async function seedAudit(branch: string, actor: string, n2: number, action = 'test.event') {
    for (let i = 0; i < n2; i++) await ctx.admin.query(`INSERT INTO audit_log (actor_account_id, branch_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,'thing',$4,'{}')`, [actor, branch, action, `e${i}`]);
  }

  test('shows my branch only, newest first, with the person behind each action', async () => {
    const { branch, manager } = await world();
    const other = await makeBranch();
    await seedAudit(branch, manager.id, 3, 'test.mine');
    await seedAudit(other, manager.id, 2, 'test.theirs');
    await ctx.admin.query(`INSERT INTO audit_log (action, entity, entity_id) VALUES ('test.nobranch','thing','x')`);
    const res = await get('/audit-log', manager.token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.entries.map((e: any) => e.action), ['test.mine', 'test.mine', 'test.mine']);
    const ids = res.body.entries.map((e: any) => Number(e.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    assert.equal(res.body.entries[0].actorName, 'Test manager');
    assert.equal(res.body.nextBefore, null);
    assert.equal((await get(`/audit-log?branchId=${other}`, manager.token)).status, 403);
  });

  test('filters by action, entity, entity id and person, and pages with a cursor', async () => {
    const { branch, manager } = await world();
    await seedAudit(branch, manager.id, 5, 'test.page');
    await seedAudit(branch, manager.id, 1, 'test.other');
    const first = await get('/audit-log?action=test.page&limit=2', manager.token);
    assert.equal(first.body.entries.length, 2);
    assert.ok(first.body.nextBefore);
    const second = await get(`/audit-log?action=test.page&limit=2&before=${first.body.nextBefore}`, manager.token);
    const third = await get(`/audit-log?action=test.page&limit=2&before=${second.body.nextBefore}`, manager.token);
    assert.equal(third.body.entries.length, 1);
    assert.equal(third.body.nextBefore, null);
    const all = [...first.body.entries, ...second.body.entries, ...third.body.entries].map((e: any) => e.id);
    assert.equal(new Set(all).size, 5, 'no entry is repeated or missed');
    assert.equal((await get('/audit-log?entityId=e0&action=test.page', manager.token)).body.entries.length, 1);
    assert.equal((await get('/audit-log?entity=thing&action=test.other', manager.token)).body.entries.length, 1);
    assert.equal((await get(`/audit-log?actorId=${manager.id}&action=test.other`, manager.token)).body.entries.length, 1);
    assert.equal((await get(`/audit-log?actorId=${(await makeAccount({ role: 'coach' })).id}&action=test.other`, manager.token)).body.entries.length, 0);
    assert.equal((await get(`/audit-log?from=${enc(iso(Date.now() + DAY))}`, manager.token)).body.entries.length, 0);
    for (const bad of ['limit=0', 'limit=9999', 'before=-1', 'before=abc', 'actorId=x', 'from=nope']) assert.equal((await get(`/audit-log?${bad}`, manager.token)).status, 400, bad);
  });
});
