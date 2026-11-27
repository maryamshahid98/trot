import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BRANCH, ctx, makeBranch, randomDay, startApp, stopApp } from './helpers.ts';
import { balanceOf, codes, DAY, HOUR, makeClass, makeRider, readyRider } from './booking-helpers.ts';
import { auditActions, customer, post, staff, statusOf } from './flow-helpers.ts';
import type { Json } from './helpers.ts';

before(startApp);
after(stopApp);

const future = () => randomDay() + 8 * HOUR;
/** A package sold through the API lasts valid_days from today, so a class it pays for has to fall inside that. */
const soon = () => Date.now() + 7 * DAY;
const get = (path: string, token?: string) => api('GET', path, { token });
const patch = (path: string, token: string | undefined, body: unknown) => api('PATCH', path, { token, body });
let n = 0;
const uniq = (p: string) => `${p} ${Date.now()}-${n++}`;

async function makeType(o: { price?: number; classes?: number; days?: number; active?: boolean; branchId?: string; formats?: string[] } = {}): Promise<string> {
  return (
    await ctx.admin.query(
      `INSERT INTO package_types (branch_id, name, classes, price_minor, valid_days, class_formats, active) VALUES ($1,$2,$3,$4,$5,$6::class_format[],$7) RETURNING id`,
      [o.branchId ?? BRANCH, uniq('Pack'), o.classes ?? 10, o.price ?? 115000, o.days ?? 90, o.formats ?? ['group'], o.active ?? true],
    )
  ).rows[0].id;
}
const receiptsFor = async (riderId: string) => (await ctx.admin.query(`SELECT * FROM receipts WHERE rider_id = $1 ORDER BY issued_at`, [riderId])).rows;
const withPrice = async (occ: string, price: number) => { await ctx.admin.query(`UPDATE occurrences SET price_minor = $2 WHERE id = $1`, [occ, price]); return occ; };

describe('package types: the price list', () => {
  test('list: no token is refused; customers see only what is on sale; staff can see retired ones', async () => {
    const active = await makeType();
    const retired = await makeType({ active: false });
    assert.equal((await get('/package-types')).status, 401);
    const c = await customer();
    const cust = await get('/package-types?includeInactive=true', c.token);
    assert.equal(cust.status, 200);
    const ids = cust.body.packageTypes.map((t: Json) => t.id);
    assert.ok(ids.includes(active) && !ids.includes(retired), 'customers never see retired types, even if they ask');
    const rec = await staff();
    assert.ok((await get('/package-types', rec.token)).body.packageTypes.every((t: Json) => t.active));
    assert.ok((await get('/package-types?includeInactive=true', rec.token)).body.packageTypes.some((t: Json) => t.id === retired));
    assert.deepEqual((await get('/package-types', rec.token)).body.packageTypes.find((t: Json) => t.id === active).classFormats, ['group']);
  });

  test('list: bad input and a branch the user does not work in', async () => {
    const rec = await staff();
    assert.equal((await get('/package-types?branchId=nope', rec.token)).status, 400);
    assert.equal((await get('/package-types?includeInactive=maybe', rec.token)).status, 400);
    assert.equal((await get(`/package-types?branchId=${await makeBranch()}`, rec.token)).status, 403);
  });

  test('create: managers and owners only, with validated input, and audited', async () => {
    const body = { name: uniq('10 group'), classes: 10, priceMinor: 110000, validDays: 90, classFormats: ['group', 'trial'] };
    assert.equal((await post('/package-types', undefined, body)).status, 401);
    for (const who of [await customer(), await staff('reception'), await staff('coach')]) assert.equal((await post('/package-types', who.token, body)).status, 403);
    const mgr = await staff('manager');
    const ok = await post('/package-types', mgr.token, body);
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(await auditActions(ok.body.id), ['package_type.create']);
    const bad: unknown[] = [
      {}, { ...body, name: '' }, { ...body, classes: 0 }, { ...body, classes: 100000 }, { ...body, classes: 1.5 }, { ...body, priceMinor: -1 },
      { ...body, priceMinor: 12.5 }, { ...body, validDays: 0 }, { ...body, classFormats: [] }, { ...body, classFormats: ['group', 'group'] }, { ...body, classFormats: ['polo'] },
      { ...body, priceMinor: '100' },
    ];
    for (const b of bad) assert.equal((await post('/package-types', mgr.token, b)).status, 400, JSON.stringify(b));
    assert.equal((await post('/package-types', mgr.token, { ...body, branchId: await makeBranch() })).status, 403);
  });

  test('update: changes the price list but never a package already sold', async () => {
    const mgr = await staff('manager');
    const rec = await staff();
    const type = await makeType({ price: 100000, classes: 5 });
    const rider = await readyRider();
    const sold = await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: type, method: 'cash' });
    assert.equal(sold.status, 201, sold.text);

    assert.equal((await patch(`/package-types/${type}`, rec.token, { priceMinor: 1 })).status, 403);
    assert.equal((await patch(`/package-types/${type}`, mgr.token, {})).status, 400);
    assert.equal((await patch(`/package-types/${type}`, mgr.token, { classes: 0 })).status, 400);
    const up = await patch(`/package-types/${type}`, mgr.token, { priceMinor: 90000, classes: 8, active: false });
    assert.equal(up.status, 200, up.text);
    assert.deepEqual([up.body.priceMinor, up.body.classes, up.body.active], [90000, 8, false]);
    assert.equal(await balanceOf(sold.body.id), 5, 'the rider keeps the 5 classes they paid for');
    assert.equal((await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: type, method: 'cash' })).status, 422, 'retired types cannot be sold');
    assert.equal((await patch(`/package-types/00000000-0000-0000-0000-00000000dead`, mgr.token, { active: true })).status, 404);
    assert.equal((await patch(`/package-types/${type}`, (await staff('manager', [await makeBranch()])).token, { active: true })).status, 404);
  });
});

describe('selling a package at the desk', () => {
  test('the package, its classes and the receipt are created together', async () => {
    const rec = await staff();
    const type = await makeType({ price: 115000, classes: 10, days: 90 });
    const rider = await readyRider();
    const r = await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: type, method: 'card_at_desk', amountMinor: 115000 });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.classes, 10);
    assert.match(r.body.receipt.number, /^R-\d+$/);
    assert.equal(r.body.receipt.vatMinor, 15000, '15% VAT is inside a 1150.00 price');
    assert.equal(await balanceOf(r.body.id), 10);
    const days = (Date.parse(r.body.validUntil) - Date.now()) / 86_400_000;
    assert.ok(days > 89.9 && days <= 90, `valid for ${days} days`);
    const [rc] = await receiptsFor(rider);
    assert.deepEqual([rc.amount_minor, rc.vat_minor, rc.method, rc.for_rider_package_id, rc.issued_by], [115000, 15000, 'card_at_desk', r.body.id, rec.id]);
    assert.deepEqual(await auditActions(r.body.id), ['package.sell']);
  });

  test('a wrong amount, an unapproved rider, a retired or other-branch type, and a free package', async () => {
    const rec = await staff();
    const rider = await readyRider();
    const type = await makeType({ price: 50000 });
    const wrong = await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: type, method: 'cash', amountMinor: 49999 });
    assert.equal(wrong.status, 422);
    assert.deepEqual(codes(wrong), ['AMOUNT_MISMATCH']);
    assert.equal((await receiptsFor(rider)).length, 0, 'nothing is left behind by a refused sale');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM rider_packages WHERE rider_id = $1`, [rider])).rows[0].n, 0);

    const pending = await makeRider({ status: 'pending_review' });
    assert.deepEqual(codes(await post(`/riders/${pending}/packages`, rec.token, { packageTypeId: type, method: 'cash' })), ['RIDER_NOT_ACTIVE']);
    assert.deepEqual(codes(await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: await makeType({ active: false }), method: 'cash' })), ['PACKAGE_TYPE_UNAVAILABLE']);
    const otherBranch = await makeBranch();
    assert.deepEqual(codes(await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: await makeType({ branchId: otherBranch }), method: 'cash' })), ['PACKAGE_TYPE_UNAVAILABLE']);
    assert.deepEqual(codes(await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: '00000000-0000-0000-0000-00000000dead', method: 'cash' })), ['PACKAGE_TYPE_UNAVAILABLE']);

    const free = await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: await makeType({ price: 0, classes: 1 }), method: 'cash' });
    assert.equal(free.status, 201);
    assert.equal(free.body.receipt, null);
  });

  test('access and bad input', async () => {
    const rider = await readyRider();
    const type = await makeType();
    assert.equal((await post(`/riders/${rider}/packages`, undefined, { packageTypeId: type, method: 'cash' })).status, 401);
    for (const who of [await customer(), await staff('coach')]) assert.equal((await post(`/riders/${rider}/packages`, who.token, { packageTypeId: type, method: 'cash' })).status, 403);
    const rec = await staff();
    for (const body of [{}, { packageTypeId: 'x', method: 'cash' }, { packageTypeId: type, method: 'bitcoin' }, { packageTypeId: type }, { packageTypeId: type, method: 'cash', amountMinor: -5 }]) {
      assert.equal((await post(`/riders/${rider}/packages`, rec.token, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(`/riders/${rider}/packages`, (await staff('reception', [await makeBranch()])).token, { packageTypeId: type, method: 'cash' })).status, 404);
    assert.equal((await post(`/riders/00000000-0000-0000-0000-00000000dead/packages`, rec.token, { packageTypeId: type, method: 'cash' })).status, 404);
  });

  test('two desks selling at the same moment get different receipt numbers', async () => {
    const a = await staff();
    const b = await staff();
    const type = await makeType({ price: 10000 });
    const r1 = await readyRider();
    const r2 = await readyRider();
    const rs = await Promise.all([post(`/riders/${r1}/packages`, a.token, { packageTypeId: type, method: 'cash' }), post(`/riders/${r2}/packages`, b.token, { packageTypeId: type, method: 'cash' })]);
    assert.deepEqual(rs.map((r) => r.status), [201, 201]);
    assert.notEqual(rs[0].body.receipt.number, rs[1].body.receipt.number);
  });

  test("the family sees a rider's packages and their history; strangers cannot", async () => {
    const c = await customer();
    const rec = await staff();
    const sold = await post(`/riders/${c.riderId}/packages`, rec.token, { packageTypeId: await makeType({ classes: 4 }), method: 'cash' });
    const list = await get(`/riders/${c.riderId}/packages`, c.token);
    assert.equal(list.status, 200);
    assert.equal(list.body.packages[0].balance, 4);
    assert.equal((await get(`/riders/${c.riderId}/packages`, (await customer()).token)).status, 404);
    assert.equal((await get(`/riders/${c.riderId}/packages`)).status, 401);
    const led = await get(`/packages/${sold.body.id}/ledger`, c.token);
    assert.equal(led.status, 200);
    assert.deepEqual([led.body.entries.length, led.body.balance, led.body.entries[0].reason], [1, 4, 'purchase']);
    assert.equal((await get(`/packages/${sold.body.id}/ledger`, (await customer()).token)).status, 404);
    assert.equal((await get(`/packages/${sold.body.id}/ledger`, (await staff('manager', [await makeBranch()])).token)).status, 404);
  });

  test('a sold package can be used to book, and the history shows it', async () => {
    const c = await customer();
    const rec = await staff();
    const sold = await post(`/riders/${c.riderId}/packages`, rec.token, { packageTypeId: await makeType({ classes: 2 }), method: 'cash' });
    const occ = await makeClass({ startsAt: soon() });
    const b = await post('/bookings', c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'package', packageId: sold.body.id });
    assert.equal(b.status, 201, b.text);
    const led = await get(`/packages/${sold.body.id}/ledger`, rec.token);
    assert.deepEqual(led.body.entries.map((e: Json) => e.reason), ['purchase', 'use']);
    assert.equal(led.body.balance, 1);
  });
});

describe('adjusting and freezing a package', () => {
  async function owned(classes = 3) {
    const rec = await staff();
    const rider = await readyRider();
    const sold = await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: await makeType({ classes }), method: 'cash' });
    return { rider, id: sold.body.id as string };
  }

  test('a manager adds or removes classes with a written reason; the history keeps it', async () => {
    const p = await owned(3);
    const mgr = await staff('manager');
    assert.equal((await post(`/packages/${p.id}/adjust`, (await staff()).token, { delta: 1, reason: 'x' })).status, 403);
    assert.equal((await post(`/packages/${p.id}/adjust`, undefined, { delta: 1, reason: 'x' })).status, 401);
    for (const body of [{}, { delta: 0, reason: 'x' }, { delta: 1 }, { delta: 1, reason: ' ' }, { delta: 1.5, reason: 'x' }, { delta: 1000, reason: 'x' }]) {
      assert.equal((await post(`/packages/${p.id}/adjust`, mgr.token, body)).status, 400, JSON.stringify(body));
    }
    const up = await post(`/packages/${p.id}/adjust`, mgr.token, { delta: 2, reason: 'Goodwill: class lost to a storm' });
    assert.equal(up.status, 201, up.text);
    assert.equal(up.body.balance, 5);
    const down = await post(`/packages/${p.id}/adjust`, mgr.token, { delta: -5, reason: 'Entered by mistake' });
    assert.equal(down.body.balance, 0);
    const led = await get(`/packages/${p.id}/ledger`, mgr.token);
    assert.equal(led.body.entries.at(-1).note, 'Entered by mistake');
  });

  test('the balance can never go below zero, even with two adjustments at once', async () => {
    const p = await owned(3);
    const mgr = await staff('manager');
    const refused = await post(`/packages/${p.id}/adjust`, mgr.token, { delta: -4, reason: 'too many' });
    assert.equal(refused.status, 422);
    assert.deepEqual(codes(refused), ['INSUFFICIENT_BALANCE']);
    const rs = await Promise.all([post(`/packages/${p.id}/adjust`, mgr.token, { delta: -2, reason: 'a' }), post(`/packages/${p.id}/adjust`, mgr.token, { delta: -2, reason: 'b' })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 422]);
    assert.equal(await balanceOf(p.id), 1);
    assert.equal((await post(`/packages/00000000-0000-0000-0000-00000000dead/adjust`, mgr.token, { delta: 1, reason: 'x' })).status, 404);
  });

  test('a frozen package cannot be used; unfreezing restores it; a cancelled one stays cancelled', async () => {
    const mgr = await staff('manager');
    const c = await customer();
    const rec = await staff();
    const sold = await post(`/riders/${c.riderId}/packages`, rec.token, { packageTypeId: await makeType(), method: 'cash' });
    const id = sold.body.id;
    const occ = await makeClass({ startsAt: soon() });
    const attempt = () => post('/bookings', c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'package', packageId: id });

    assert.equal((await post(`/packages/${id}/status`, rec.token, { status: 'frozen', reason: 'x' })).status, 403);
    assert.equal((await post(`/packages/${id}/status`, mgr.token, { status: 'frozen' })).status, 400, 'a reason is required');
    assert.equal((await post(`/packages/${id}/status`, mgr.token, { status: 'exhausted', reason: 'x' })).status, 400, 'only some statuses can be set');
    assert.equal((await post(`/packages/${id}/status`, mgr.token, { status: 'frozen', reason: 'Rider away for a month' })).status, 201);
    assert.deepEqual(codes(await attempt()), ['PACKAGE_NOT_ACTIVE']);
    assert.equal((await post(`/packages/${id}/status`, mgr.token, { status: 'frozen', reason: 'again' })).status, 409);
    assert.equal((await post(`/packages/${id}/status`, mgr.token, { status: 'active', reason: 'Back' })).status, 201);
    assert.equal((await attempt()).status, 201);
    assert.equal((await post(`/packages/${id}/status`, mgr.token, { status: 'cancelled', reason: 'Refunded' })).status, 201);
    const locked = await post(`/packages/${id}/status`, mgr.token, { status: 'active', reason: 'oops' });
    assert.equal(locked.status, 409);
    assert.deepEqual(codes(locked), ['PACKAGE_STATUS_LOCKED']);
  });
});

describe('POST /bookings/:id/payment: paying at the desk', () => {
  async function pending(price = 5000) {
    const c = await customer();
    const occ = await withPrice(await makeClass({ startsAt: future() }), price);
    const b = await post('/bookings', c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' });
    assert.equal(b.body.status, 'pending_office_payment', b.text);
    return { ...c, occ, bookingId: b.body.id as string };
  }
  const pay = (token: string | undefined, id: string, body: unknown) => post(`/bookings/${id}/payment`, token, body);

  test('payment confirms the booking, issues a receipt with VAT, and ends the hold', async () => {
    const p = await pending(11500);
    const rec = await staff();
    const r = await pay(rec.token, p.bookingId, { method: 'cash', amountMinor: 11500 });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'confirmed');
    assert.equal(r.body.receipt.vatMinor, 1500);
    const row = (await ctx.admin.query(`SELECT status, hold_expires_at FROM bookings WHERE id = $1`, [p.bookingId])).rows[0];
    assert.deepEqual([row.status, row.hold_expires_at], ['confirmed', null]);
    const [rc] = await receiptsFor(p.riderId);
    assert.deepEqual([rc.amount_minor, rc.for_booking_id, rc.issued_by], [11500, p.bookingId, rec.id]);
    assert.deepEqual((await auditActions(p.bookingId)).slice(-1), ['payment.record']);
  });

  test('wrong amount, bad input, wrong role, no token, unknown or other-branch booking', async () => {
    const p = await pending(5000);
    const rec = await staff();
    const wrong = await pay(rec.token, p.bookingId, { method: 'cash', amountMinor: 4000 });
    assert.equal(wrong.status, 422);
    assert.deepEqual(codes(wrong), ['AMOUNT_MISMATCH']);
    assert.equal((await receiptsFor(p.riderId)).length, 0);
    for (const body of [{}, { method: 'cash' }, { amountMinor: 5000 }, { method: 'gold', amountMinor: 5000 }, { method: 'cash', amountMinor: -5000 }, { method: 'cash', amountMinor: 50.5 }, { method: 'cash', amountMinor: '5000' }]) {
      assert.equal((await pay(rec.token, p.bookingId, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await pay(p.token, p.bookingId, { method: 'cash', amountMinor: 5000 })).status, 403);
    assert.equal((await pay(undefined, p.bookingId, { method: 'cash', amountMinor: 5000 })).status, 401);
    assert.equal((await pay((await staff('coach')).token, p.bookingId, { method: 'cash', amountMinor: 5000 })).status, 403);
    assert.equal((await pay((await staff('manager', [await makeBranch()])).token, p.bookingId, { method: 'cash', amountMinor: 5000 })).status, 404);
    assert.equal((await pay(rec.token, 'nope', { method: 'cash', amountMinor: 5000 })).status, 400);
    assert.equal((await pay(rec.token, '00000000-0000-0000-0000-00000000dead', { method: 'cash', amountMinor: 5000 })).status, 404);
  });

  test('already paid, cancelled, and a hold that ran out are each refused', async () => {
    const rec = await staff();
    const paid = await pending();
    await pay(rec.token, paid.bookingId, { method: 'cash', amountMinor: 5000 });
    const again = await pay(rec.token, paid.bookingId, { method: 'cash', amountMinor: 5000 });
    assert.equal(again.status, 409);
    assert.deepEqual(codes(again), ['ALREADY_PAID']);

    const gone = await pending();
    await post(`/bookings/${gone.bookingId}/cancel`, gone.token, {});
    assert.deepEqual(codes(await pay(rec.token, gone.bookingId, { method: 'cash', amountMinor: 5000 })), ['NOT_PENDING_PAYMENT']);

    const late = await pending();
    await ctx.admin.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [late.bookingId]);
    assert.deepEqual(codes(await pay(rec.token, late.bookingId, { method: 'cash', amountMinor: 5000 })), ['HOLD_EXPIRED']);
    assert.equal((await receiptsFor(late.riderId)).length, 0);
  });

  test('two desks taking the same payment at once make one receipt', async () => {
    const p = await pending();
    const a = await staff();
    const b = await staff('manager');
    const rs = await Promise.all([pay(a.token, p.bookingId, { method: 'cash', amountMinor: 5000 }), pay(b.token, p.bookingId, { method: 'card_at_desk', amountMinor: 5000 })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await receiptsFor(p.riderId)).length, 1);
  });

  test('a free class is confirmed with no receipt', async () => {
    const p = await pending(0);
    const rec = await staff();
    assert.equal((await pay(rec.token, p.bookingId, { method: 'cash', amountMinor: 100 })).status, 422);
    const r = await pay(rec.token, p.bookingId, { method: 'cash', amountMinor: 0 });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.receipt, null);
    assert.equal(await statusOf(p.bookingId), 'confirmed');
  });
});

describe('POST /bookings/:id/confirm-unpaid', () => {
  test('only a manager or owner, with a reason, and it is on the record', async () => {
    const c = await customer();
    const occ = await makeClass({ startsAt: future() });
    const b = await post('/bookings', c.token, { occurrenceId: occ, riderId: c.riderId, payWith: 'office' });
    const id = b.body.id;
    const rec = await staff();
    const mgr = await staff('manager');
    assert.equal((await post(`/bookings/${id}/confirm-unpaid`, rec.token, { reason: 'x' })).status, 403);
    assert.equal((await post(`/bookings/${id}/confirm-unpaid`, c.token, { reason: 'x' })).status, 403);
    assert.equal((await post(`/bookings/${id}/confirm-unpaid`, undefined, { reason: 'x' })).status, 401);
    assert.equal((await post(`/bookings/${id}/confirm-unpaid`, mgr.token, {})).status, 400);
    const r = await post(`/bookings/${id}/confirm-unpaid`, mgr.token, { reason: 'Regular rider, pays Sunday' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.status, r.body.paid], ['confirmed', false]);
    assert.equal((await receiptsFor(c.riderId)).length, 0);
    const d = (await ctx.admin.query(`SELECT detail::text AS d FROM audit_log WHERE entity_id = $1 AND action = 'booking.confirm_unpaid'`, [id])).rows[0].d;
    assert.ok(d.includes('pays Sunday'));
    assert.equal((await post(`/bookings/${id}/confirm-unpaid`, mgr.token, { reason: 'again' })).status, 409);
  });
});

describe('receipts', () => {
  async function paidReceipt(price = 20000, method = 'cash') {
    const c = await customer();
    const rec = await staff();
    const type = await makeType({ price });
    const sold = await post(`/riders/${c.riderId}/packages`, rec.token, { packageTypeId: type, method });
    return { ...c, receiptId: (await receiptsFor(c.riderId))[0].id as string, number: sold.body.receipt.number as string };
  }

  test('staff list and filter receipts; customers and strangers cannot', async () => {
    const a = await paidReceipt(20000, 'cash');
    await paidReceipt(30000, 'card_at_desk');
    const rec = await staff();
    assert.equal((await get('/receipts')).status, 401);
    assert.equal((await get('/receipts', a.token)).status, 403);
    const byRider = await get(`/receipts?riderId=${a.riderId}`, rec.token);
    assert.equal(byRider.status, 200);
    assert.deepEqual([byRider.body.total, byRider.body.receipts[0].number], [1, a.number]);
    assert.ok((await get('/receipts?method=card_at_desk', rec.token)).body.receipts.every((r: Json) => r.method === 'card_at_desk'));
    assert.equal((await get('/receipts?from=2999-01-01', rec.token)).body.total, 0);
    assert.ok((await get('/receipts?limit=1', rec.token)).body.receipts.length === 1);
    for (const qs of ['limit=0', 'limit=999', 'offset=-1', 'method=gold', 'from=yesterday', 'riderId=x', 'branchId=x']) assert.equal((await get(`/receipts?${qs}`, rec.token)).status, 400, qs);
    assert.equal((await get(`/receipts?branchId=${await makeBranch()}`, rec.token)).status, 403);
    assert.equal((await get(`/receipts?riderId=${a.riderId}`, (await staff('manager', [await makeBranch()])).token)).body.total, 0, 'another branch sees nothing');
  });

  test('a customer sees only their own receipts', async () => {
    const mine = await paidReceipt();
    await paidReceipt();
    const r = await get('/receipts/mine', mine.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.receipts.map((x: Json) => x.number), [mine.number]);
    assert.equal((await get('/receipts/mine', (await staff()).token)).status, 403);
    assert.equal((await get(`/receipts/${mine.receiptId}`, mine.token)).status, 200);
    assert.equal((await get(`/receipts/${mine.receiptId}`, (await customer()).token)).status, 404);
    assert.equal((await get(`/receipts/${mine.receiptId}`, (await staff('manager', [await makeBranch()])).token)).status, 404);
    assert.equal((await get(`/receipts/nope`, mine.token)).status, 400);
  });

  test('a receipt can never be changed or deleted, not even by the database owner', async () => {
    const x = await paidReceipt();
    await assert.rejects(ctx.admin.query(`UPDATE receipts SET amount_minor = 1 WHERE id = $1`, [x.receiptId]), /append-only/);
    await assert.rejects(ctx.admin.query(`DELETE FROM receipts WHERE id = $1`, [x.receiptId]), /append-only/);
  });
});

describe('POST /receipts/:id/adjustments', () => {
  async function receipt(price = 40000) {
    const rec = await staff();
    const rider = await readyRider();
    await post(`/riders/${rider}/packages`, rec.token, { packageTypeId: await makeType({ price }), method: 'cash' });
    return (await receiptsFor(rider))[0].id as string;
  }

  test('reception handles small ones; a manager approves; the receipt shows them', async () => {
    const id = await receipt(40000);
    const rec = await staff();
    const mgr = await staff('manager');
    const small = await post(`/receipts/${id}/adjustments`, rec.token, { kind: 'refund', amountMinor: 10000, reason: 'Class cancelled by the club' });
    assert.equal(small.status, 201, small.text);
    assert.equal(small.body.approved, false);
    const big = await post(`/receipts/${id}/adjustments`, mgr.token, { kind: 'credit', amountMinor: 60000, reason: 'Goodwill credit' });
    assert.equal(big.body.approved, true);
    const view = await get(`/receipts/${id}`, mgr.token);
    assert.deepEqual(view.body.adjustments.map((a: Json) => [a.kind, a.amountMinor, a.approvedBy === null]), [['refund', 10000, true], ['credit', 60000, false]]);
    assert.deepEqual(await auditActions(small.body.id), ['adjustment.create']);
  });

  test('a large adjustment needs a manager', async () => {
    const id = await receipt();
    const rec = await staff();
    const r = await post(`/receipts/${id}/adjustments`, rec.token, { kind: 'write_off', amountMinor: 50001, reason: 'Bad debt' });
    assert.equal(r.status, 403);
    assert.deepEqual(codes(r), ['NEEDS_MANAGER']);
    assert.equal((await post(`/receipts/${id}/adjustments`, rec.token, { kind: 'write_off', amountMinor: 50000, reason: 'Bad debt' })).status, 201, 'the threshold itself is allowed');
  });

  test('refunds can never total more than was paid', async () => {
    const id = await receipt(40000);
    const mgr = await staff('manager');
    assert.equal((await post(`/receipts/${id}/adjustments`, mgr.token, { kind: 'refund', amountMinor: 30000, reason: 'part' })).status, 201);
    const over = await post(`/receipts/${id}/adjustments`, mgr.token, { kind: 'refund', amountMinor: 10001, reason: 'too much' });
    assert.equal(over.status, 422);
    assert.deepEqual(codes(over), ['OVER_REFUND']);
    assert.equal((await post(`/receipts/${id}/adjustments`, mgr.token, { kind: 'refund', amountMinor: 10000, reason: 'rest' })).status, 201);
  });

  test('two refunds at once cannot together exceed the receipt', async () => {
    const id = await receipt(40000);
    const a = await staff('manager');
    const b = await staff('owner');
    const rs = await Promise.all([post(`/receipts/${id}/adjustments`, a.token, { kind: 'refund', amountMinor: 30000, reason: 'a' }), post(`/receipts/${id}/adjustments`, b.token, { kind: 'refund', amountMinor: 30000, reason: 'b' })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 422]);
    const total = (await ctx.admin.query(`SELECT coalesce(sum(amount_minor),0)::int AS n FROM financial_adjustments WHERE receipt_id = $1`, [id])).rows[0].n;
    assert.equal(total, 30000);
  });

  test('input rules, roles and unknown receipts', async () => {
    const id = await receipt();
    const mgr = await staff('manager');
    assert.equal((await post(`/receipts/${id}/adjustments`, undefined, { kind: 'refund', amountMinor: 1, reason: 'x' })).status, 401);
    assert.equal((await post(`/receipts/${id}/adjustments`, (await customer()).token, { kind: 'refund', amountMinor: 1, reason: 'x' })).status, 403);
    assert.equal((await post(`/receipts/${id}/adjustments`, (await staff('coach')).token, { kind: 'refund', amountMinor: 1, reason: 'x' })).status, 403);
    for (const body of [{}, { kind: 'refund', amountMinor: 100 }, { kind: 'refund', amountMinor: 0, reason: 'x' }, { kind: 'refund', amountMinor: 1.5, reason: 'x' }, { kind: 'gift', amountMinor: 100, reason: 'x' }, { kind: 'refund', amountMinor: 100, reason: '  ' }]) {
      assert.equal((await post(`/receipts/${id}/adjustments`, mgr.token, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(`/receipts/${id}/adjustments`, mgr.token, { kind: 'refund', amountMinor: -100, reason: 'x' })).status, 422, 'a refund is entered as a positive amount');
    assert.equal((await post(`/receipts/${id}/adjustments`, mgr.token, { kind: 'correction', amountMinor: -100, reason: 'Typo at the desk' })).status, 201, 'only a correction may be negative');
    assert.equal((await post(`/receipts/00000000-0000-0000-0000-00000000dead/adjustments`, mgr.token, { kind: 'refund', amountMinor: 1, reason: 'x' })).status, 404);
    assert.equal((await post(`/receipts/${id}/adjustments`, (await staff('manager', [await makeBranch()])).token, { kind: 'refund', amountMinor: 1, reason: 'x' })).status, 404);
  });
});
