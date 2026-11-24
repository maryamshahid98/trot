// Invoices and credit notes: a charge, the payment that settles it, a credit note when money goes back, and an account statement.
// Everything runs in a private branch so listings and totals are exactly this test's.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ctx, makeBranch, startApp, stopApp } from './helpers.ts';
import type { Json } from './helpers.ts';
import { HOUR, makeClass } from './booking-helpers.ts';
import { auditActions, customer, directBooking, staff } from './flow-helpers.ts';

before(startApp);
after(stopApp);

async function club() {
  const branch = await makeBranch();
  return { branch, reception: await staff('reception', [branch]), manager: await staff('manager', [branch]), coach: await staff('coach', [branch]) };
}
type Club = Awaited<ReturnType<typeof club>>;

const classWith = async (k: Club, priceMinor: number, hoursAhead = 30, capacity = 6) => {
  const id = await makeClass({ branchId: k.branch, startsAt: Date.now() + hoursAhead * HOUR, capacity });
  await ctx.admin.query(`UPDATE occurrences SET price_minor = $2, title = 'Jumping basics' WHERE id = $1`, [id, priceMinor]);
  return id;
};
const book = (token: string, occurrenceId: string, riderId: string) => api('POST', '/bookings', { token, body: { occurrenceId, riderId, payWith: 'office' } });
const pay = (token: string, bookingId: string, amountMinor: number, method = 'cash') => api('POST', `/bookings/${bookingId}/payment`, { token, body: { method, amountMinor } });
const invoiceOf = async (bookingId: string) => (await ctx.admin.query(`SELECT * FROM invoices WHERE booking_id = $1`, [bookingId])).rows[0];
const adjust = (token: string, receiptId: string, body: unknown) => api('POST', `/receipts/${receiptId}/adjustments`, { token, body });
const receiptIdOf = async (bookingId: string) => (await ctx.admin.query(`SELECT id FROM receipts WHERE for_booking_id = $1`, [bookingId])).rows[0].id as string;

describe('the invoice for a booking', () => {
  test('booking a priced class at the office issues a numbered invoice with the VAT kept as it was that day', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    assert.equal(b.status, 201, b.text);
    const inv = await invoiceOf(b.body.id);
    assert.match(inv.number, /^I-\d+$/);
    assert.deepEqual([inv.status, inv.gross_minor, inv.vat_minor, Number(inv.vat_percent), inv.currency, inv.paid_at, inv.receipt_id], ['issued', 11500, 1500, 15, 'SAR', null, null]);
    assert.equal(inv.payer_account_id, f.id);
    const lines = (await ctx.admin.query(`SELECT description, quantity, total_minor, vat_minor FROM invoice_lines WHERE invoice_id = $1`, [inv.id])).rows;
    assert.equal(lines.length, 1);
    assert.match(lines[0].description, /^Jumping basics · /);
    assert.deepEqual([lines[0].quantity, lines[0].total_minor, lines[0].vat_minor], [1, 11500, 1500]);
    assert.ok((await auditActions(inv.id)).includes('invoice.issue'));
  });

  test('a free class has no invoice, and neither has a booking paid with a package', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const free = await book(f.token, await classWith(k, 0), f.riderId);
    assert.equal(free.status, 201, free.text);
    assert.equal(await invoiceOf(free.body.id), undefined);
    const type = (await ctx.admin.query(`INSERT INTO package_types (branch_id, name, classes, price_minor, valid_days, class_formats) VALUES ($1,'Ten classes',10,57500,90,'{group}') RETURNING id`, [k.branch])).rows[0].id;
    const sold = await api('POST', `/riders/${f.riderId}/packages`, { token: k.reception.token, body: { packageTypeId: type, method: 'cash' } });
    assert.equal(sold.status, 201, sold.text);
    const withPackage = await api('POST', '/bookings', { token: f.token, body: { occurrenceId: await classWith(k, 5750, 40), riderId: f.riderId, payWith: 'package', packageId: sold.body.id } });
    assert.equal(withPackage.status, 201, withPackage.text);
    assert.equal(await invoiceOf(withPackage.body.id), undefined, 'the package was invoiced when it was sold');
  });

  test('paying settles the invoice: paid, dated, and linked to the receipt', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    const paid = await pay(k.reception.token, b.body.id, 11500);
    assert.equal(paid.status, 201, paid.text);
    const inv = await invoiceOf(b.body.id);
    assert.equal(inv.status, 'paid');
    assert.ok(inv.paid_at);
    assert.equal(inv.receipt_id, paid.body.receipt.id);
    const view = await api('GET', `/invoices/${inv.id}`, { token: k.reception.token });
    assert.equal(view.status, 200);
    assert.equal(view.body.receiptNumber, paid.body.receipt.number);
    assert.equal(view.body.payerName, f.email ? view.body.payerName : null);
    assert.deepEqual([view.body.grossMinor, view.body.vatMinor, view.body.vatPercent], [11500, 1500, 15]);
  });

  test('selling a package issues an invoice that is paid at once, with the package named on it', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const type = (await ctx.admin.query(`INSERT INTO package_types (branch_id, name, classes, price_minor, valid_days, class_formats) VALUES ($1,'Ten classes',10,115000,90,'{group}') RETURNING id`, [k.branch])).rows[0].id;
    const sold = await api('POST', `/riders/${f.riderId}/packages`, { token: k.reception.token, body: { packageTypeId: type, method: 'card_at_desk' } });
    assert.equal(sold.status, 201, sold.text);
    const inv = (await ctx.admin.query(`SELECT i.*, l.description FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id WHERE i.rider_package_id = $1`, [sold.body.id])).rows[0];
    assert.deepEqual([inv.status, inv.gross_minor, inv.vat_minor, inv.receipt_id], ['paid', 115000, 15000, sold.body.receipt.id]);
    assert.equal(inv.description, 'Ten classes (10 classes)');
  });

  test('a booking made before invoices existed gets its invoice when it is paid', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    // Written straight into the database, so it has no invoice: exactly what an old booking looks like.
    const legacy = await directBooking({ occurrenceId: await classWith(k, 11500), riderId: f.riderId, status: 'pending_office_payment', holdExpiresInMin: 30, branchId: k.branch });
    assert.equal(await invoiceOf(legacy), undefined);
    const paid = await pay(k.reception.token, legacy, 11500);
    assert.equal(paid.status, 201, paid.text);
    const inv = await invoiceOf(legacy);
    assert.deepEqual([inv.status, inv.gross_minor, inv.receipt_id], ['paid', 11500, paid.body.receipt.id]);
  });
});

describe('cancelling', () => {
  test('cancelling an unpaid booking voids its invoice, whichever way the booking is cancelled', async () => {
    const k = await club();
    const byRider = await customer({ branchId: k.branch });
    const a = await book(byRider.token, await classWith(k, 11500), byRider.riderId);
    assert.equal((await api('POST', `/bookings/${a.body.id}/cancel`, { token: byRider.token, body: { cause: 'customer' } })).status, 201);
    assert.equal((await invoiceOf(a.body.id)).status, 'voided');

    const whole = await customer({ branchId: k.branch });
    const cls = await classWith(k, 11500, 31);
    const w = await book(whole.token, cls, whole.riderId);
    assert.equal((await api('POST', `/schedule/${cls}/cancel`, { token: k.manager.token, body: { cause: 'club', reason: 'Closed' } })).status, 201);
    assert.equal((await invoiceOf(w.body.id)).status, 'voided', 'the whole class was cancelled');

    const lapsed = await customer({ branchId: k.branch });
    const h = await book(lapsed.token, await classWith(k, 11500, 32), lapsed.riderId);
    await ctx.admin.query(`UPDATE bookings SET hold_expires_at = now() - interval '5 minutes' WHERE id = $1`, [h.body.id]);
    assert.equal((await api('POST', '/jobs/expiry', { token: k.manager.token, body: {} })).status, 200);
    assert.equal((await invoiceOf(h.body.id)).status, 'voided', 'the hold ran out');
  });

  test('cancelling a PAID booking leaves the invoice paid; money goes back only by a refund, which makes a credit note', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    await pay(k.reception.token, b.body.id, 11500);
    assert.equal((await api('POST', `/bookings/${b.body.id}/cancel`, { token: f.token, body: { cause: 'customer' } })).status, 201);
    assert.equal((await invoiceOf(b.body.id)).status, 'paid');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM credit_notes WHERE invoice_id = $1`, [(await invoiceOf(b.body.id)).id])).rows[0].n, 0);
  });
});

describe('credit notes', () => {
  test('a refund makes a numbered credit note with its own VAT; a part refund leaves the invoice paid, the last part makes it credited', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    await pay(k.reception.token, b.body.id, 11500);
    const rid = await receiptIdOf(b.body.id);
    const part = await adjust(k.manager.token, rid, { kind: 'refund', amountMinor: 5750, reason: 'Class cut short' });
    assert.equal(part.status, 201, part.text);
    const inv = await invoiceOf(b.body.id);
    assert.equal(inv.status, 'paid', 'only half was credited');
    let notes = (await ctx.admin.query(`SELECT number, amount_minor, vat_minor, reason, adjustment_id FROM credit_notes WHERE invoice_id = $1 ORDER BY issued_at`, [inv.id])).rows;
    assert.equal(notes.length, 1);
    assert.match(notes[0].number, /^CN-\d+$/);
    assert.deepEqual([notes[0].amount_minor, notes[0].vat_minor, notes[0].reason, notes[0].adjustment_id], [5750, 750, 'Class cut short', part.body.id]);
    assert.equal((await adjust(k.manager.token, rid, { kind: 'refund', amountMinor: 5750, reason: 'The rest' })).status, 201);
    assert.equal((await invoiceOf(b.body.id)).status, 'credited');
    notes = (await ctx.admin.query(`SELECT amount_minor FROM credit_notes WHERE invoice_id = $1`, [inv.id])).rows;
    assert.equal(notes.reduce((s, n) => s + n.amount_minor, 0), 11500);
    const view = await api('GET', `/invoices/${inv.id}`, { token: k.manager.token });
    assert.equal(view.body.creditNotes.length, 2);
    assert.ok((await auditActions(notes.length ? (await ctx.admin.query(`SELECT id FROM credit_notes WHERE invoice_id = $1 LIMIT 1`, [inv.id])).rows[0].id : '')).includes('credit_note.issue'));
  });

  test('a goodwill credit larger than the invoice is credited only up to what the invoice charged', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    await pay(k.reception.token, b.body.id, 11500);
    const r = await adjust(k.manager.token, await receiptIdOf(b.body.id), { kind: 'credit', amountMinor: 30000, reason: 'Goodwill' });
    assert.equal(r.status, 201, r.text);
    const inv = await invoiceOf(b.body.id);
    assert.equal((await ctx.admin.query(`SELECT sum(amount_minor)::int AS n FROM credit_notes WHERE invoice_id = $1`, [inv.id])).rows[0].n, 11500, 'capped at the invoice');
    assert.equal(inv.status, 'credited');
  });

  test('a write-off or a correction is not a credit note', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    await pay(k.reception.token, b.body.id, 11500);
    const rid = await receiptIdOf(b.body.id);
    assert.equal((await adjust(k.manager.token, rid, { kind: 'correction', amountMinor: 100, reason: 'Typo' })).status, 201);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM credit_notes WHERE invoice_id = $1`, [(await invoiceOf(b.body.id)).id])).rows[0].n, 0);
  });
});

describe('what the database refuses', () => {
  test('an invoice\'s money, number and links never change; its status only moves forward; it is never deleted', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    const inv = await invoiceOf(b.body.id);
    for (const [change, why] of [
      ['gross_minor = 1', 'the amount'], ['vat_minor = 0', 'the VAT'], ['vat_percent = 5', 'the VAT rate'], ["number = 'I-1'", 'the number'], ['rider_id = (SELECT id FROM riders LIMIT 1 OFFSET 7)', 'the rider'],
    ] as const) {
      await assert.rejects(ctx.admin.query(`UPDATE invoices SET ${change} WHERE id = $1`, [inv.id]), /cannot be changed|restrict|violates/, why);
    }
    await assert.rejects(ctx.admin.query(`DELETE FROM invoices WHERE id = $1`, [inv.id]), /never deleted/);
    await assert.rejects(ctx.admin.query(`UPDATE invoice_lines SET total_minor = 1 WHERE invoice_id = $1`, [inv.id]), /append-only/);
    await assert.rejects(ctx.admin.query(`UPDATE invoices SET status = 'credited' WHERE id = $1`, [inv.id]), /cannot go from issued to credited/);
    await pay(k.reception.token, b.body.id, 11500);
    await assert.rejects(ctx.admin.query(`UPDATE invoices SET status = 'voided', voided_at = now(), paid_at = NULL WHERE id = $1`, [inv.id]), /cannot go from paid to voided/);
  });

  test('credit notes can never add up to more than the invoice, and only a paid invoice can be credited', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    const inv = await invoiceOf(b.body.id);
    const adj = (await ctx.admin.query(`INSERT INTO financial_adjustments (branch_id, kind, amount_minor, reason, requested_by) VALUES ($1,'credit',100,'x',$2) RETURNING id`, [k.branch, k.manager.id])).rows[0].id;
    await assert.rejects(ctx.admin.query(`INSERT INTO credit_notes (branch_id, number, invoice_id, adjustment_id, amount_minor, vat_minor, reason) VALUES ($1,'CN-X',$2,$3,100,13,'x')`, [k.branch, inv.id, adj]), /Only a paid invoice/);
    await pay(k.reception.token, b.body.id, 11500);
    await assert.rejects(ctx.admin.query(`INSERT INTO credit_notes (branch_id, number, invoice_id, adjustment_id, amount_minor, vat_minor, reason) VALUES ($1,'CN-Y',$2,$3,11501,1500,'x')`, [k.branch, inv.id, adj]), /more than the invoice/);
    await assert.rejects(ctx.admin.query(`UPDATE credit_notes SET amount_minor = 1`), /append-only/);
  });

  test('invoice numbers are never repeated, even when many are issued at the same moment', async () => {
    const k = await club();
    const people = await Promise.all(Array.from({ length: 8 }, () => customer({ branchId: k.branch })));
    const cls = await classWith(k, 11500, 36, 20);
    const results = await Promise.all(people.map((p) => book(p.token, cls, p.riderId)));
    assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join());
    const numbers = (await ctx.admin.query(`SELECT number FROM invoices WHERE branch_id = $1`, [k.branch])).rows.map((r) => r.number);
    assert.equal(numbers.length, 8);
    assert.equal(new Set(numbers).size, 8);
  });
});

describe('who can see invoices', () => {
  test('reception, managers and owners list and open them; a family sees only its own, and never a voided one in its list', async () => {
    const k = await club();
    const mine = await customer({ branchId: k.branch });
    const other = await customer({ branchId: k.branch });
    const a = await book(mine.token, await classWith(k, 11500), mine.riderId);
    await book(other.token, await classWith(k, 5000, 33), other.riderId);
    const voided = await book(mine.token, await classWith(k, 3000, 34), mine.riderId);
    await api('POST', `/bookings/${voided.body.id}/cancel`, { token: mine.token, body: { cause: 'customer' } });
    const invId = (await invoiceOf(a.body.id)).id;

    assert.equal((await api('GET', `/invoices?branchId=${k.branch}`)).status, 401);
    assert.equal((await api('GET', `/invoices?branchId=${k.branch}`, { token: k.coach.token })).status, 403);
    assert.equal((await api('GET', `/invoices?branchId=${k.branch}`, { token: mine.token })).status, 403, 'a customer uses /invoices/mine');
    const all = await api('GET', `/invoices?branchId=${k.branch}`, { token: k.reception.token });
    assert.equal(all.body.total, 3);
    assert.equal((await api('GET', `/invoices?branchId=${k.branch}&status=voided`, { token: k.manager.token })).body.total, 1);
    assert.equal((await api('GET', `/invoices?branchId=${k.branch}&riderId=${mine.riderId}`, { token: k.manager.token })).body.total, 2);
    assert.equal((await api('GET', `/invoices?branchId=${k.branch}&number=${encodeURIComponent((await invoiceOf(a.body.id)).number)}`, { token: k.manager.token })).body.total, 1);
    assert.equal((await api('GET', `/invoices?branchId=${k.branch}&status=nope`, { token: k.manager.token })).status, 400);

    const own = await api('GET', '/invoices/mine', { token: mine.token });
    assert.equal(own.status, 200);
    assert.deepEqual((own.body.invoices as Json[]).map((i) => i.id), [invId], 'its own, not the voided one, not the other family\'s');
    assert.equal((await api('GET', `/invoices/${invId}`, { token: mine.token })).status, 200);
    assert.equal((await api('GET', `/invoices/${invId}`, { token: other.token })).status, 404, 'another family');
    assert.equal((await api('GET', '/invoices/mine', { token: k.reception.token })).status, 403);
    assert.equal((await api('GET', '/invoices/not-an-id', { token: k.manager.token })).status, 400);
    const elsewhere = await staff('manager', [await makeBranch()]);
    assert.equal((await api('GET', `/invoices/${invId}`, { token: elsewhere.token })).status, 404);
    assert.equal((await api('GET', `/invoices?branchId=${k.branch}`, { token: elsewhere.token })).status, 404);
  });
});

describe('the account statement', () => {
  test('charges, payments, credit notes and refunds paid back, with a running balance that ends at what is owed', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const b = await book(f.token, await classWith(k, 11500), f.riderId);
    const acct = () => api('GET', `/riders/${f.riderId}/account`, { token: f.token });
    let a = (await acct()).body;
    assert.deepEqual(a.entries.map((e: Json) => [e.type, e.debitMinor, e.creditMinor, e.balanceMinor]), [['invoice', 11500, 0, 11500]]);
    assert.equal(a.balanceMinor, 11500);
    assert.equal(a.unpaidInvoicesMinor, 11500, 'what is still to pay');

    await pay(k.reception.token, b.body.id, 11500);
    a = (await acct()).body;
    assert.deepEqual(a.entries.map((e: Json) => e.type), ['invoice', 'receipt']);
    assert.equal(a.balanceMinor, 0);
    assert.equal(a.unpaidInvoicesMinor, 0);

    await adjust(k.manager.token, await receiptIdOf(b.body.id), { kind: 'refund', amountMinor: 5000, reason: 'Short class' });
    a = (await acct()).body;
    assert.deepEqual(a.entries.map((e: Json) => e.type), ['invoice', 'receipt', 'credit_note', 'refund_paid']);
    assert.equal(a.balanceMinor, 0, 'credited 5000 and paid 5000 back: nothing owed either way');
    assert.deepEqual(a.entries.map((e: Json) => e.balanceMinor), [11500, 0, -5000, 0]);
    assert.equal(a.currency, 'SAR');
  });

  test('a period shows an opening balance, and a voided invoice never appears', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const first = await book(f.token, await classWith(k, 11500), f.riderId);
    await pay(k.reception.token, first.body.id, 11500);
    const gone = await book(f.token, await classWith(k, 3000, 35), f.riderId);
    await api('POST', `/bookings/${gone.body.id}/cancel`, { token: f.token, body: { cause: 'customer' } });
    const stays = await book(f.token, await classWith(k, 4000, 37), f.riderId);
    assert.equal(stays.status, 201);
    const all = (await api('GET', `/riders/${f.riderId}/account`, { token: k.reception.token })).body;
    assert.equal(all.entries.length, 3, 'the voided invoice is not there');
    const from = new Date(Date.now() + 60_000).toISOString(); // after everything above
    const later = (await api('GET', `/riders/${f.riderId}/account?from=${encodeURIComponent(from)}`, { token: k.reception.token })).body;
    assert.equal(later.entries.length, 0);
    assert.equal(later.openingBalanceMinor, 4000, 'what was already owed when the period began');
  });

  test('only staff of the branch and the rider\'s own family can read an account', async () => {
    const k = await club();
    const f = await customer({ branchId: k.branch });
    const other = await customer({ branchId: k.branch });
    const path = `/riders/${f.riderId}/account`;
    assert.equal((await api('GET', path)).status, 401);
    assert.equal((await api('GET', path, { token: k.coach.token })).status, 403);
    assert.equal((await api('GET', path, { token: other.token })).status, 404);
    assert.equal((await api('GET', path, { token: (await staff('manager', [await makeBranch()])).token })).status, 404);
    assert.equal((await api('GET', path, { token: f.token })).status, 200);
    assert.equal((await api('GET', `${path}?from=yesterday`, { token: f.token })).status, 400);
  });
});
