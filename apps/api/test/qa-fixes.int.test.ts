// The behaviour added for the QA findings against BRD v1.2.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { after, before } from 'node:test';
import { api, BRANCH, ctx, makeBranch, startApp, stopApp } from './helpers.ts';
import { balanceOf, codes, DAY, guard, HOUR, makeClass, makePackage, makeRider, readyRider, verifyDocs } from './booking-helpers.ts';
import { customer, directBooking, post, staff } from './flow-helpers.ts';

before(startApp);
after(stopApp);
let n = 0;
/** A different future day for every use, so sessions never clash with each other or with other test files. */
const slot = () => Math.floor(Date.now() / DAY) * DAY + (3000 + ++n) * DAY + 10 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const arena = async (capacity = 4, levels = '{beginner,intermediate,advanced}') =>
  (await ctx.admin.query(`INSERT INTO arenas (branch_id, name, max_capacity, supported_levels) VALUES ($1, $2, $3, $4) RETURNING id`, [BRANCH, `QA arena ${process.pid}-${++n}`, capacity, levels])).rows[0].id as string;

describe('arena rules', () => {
  test('capacity above the arena and an unsupported level need a manager override', async () => {
    const rec = await staff('reception');
    const coach = await staff('coach');
    const start = slot();
    const body = { branchId: BRANCH, title: 'Too big', arenaId: await arena(2, '{beginner}'), coachId: coach.id, format: 'group', minLevel: 'advanced', startsAt: iso(start), endsAt: iso(start + HOUR), capacity: 9 };
    const refused = await post('/schedule', rec.token, body);
    assert.equal(refused.status, 422);
    assert.deepEqual(codes(refused).sort(), ['ARENA_CAPACITY', 'ARENA_LEVEL']);
    const forced = await post('/schedule', (await staff('manager')).token, { ...body, override: { reason: 'agreed with the owner' } });
    assert.equal(forced.status, 201, forced.text);
  });

  test('a session in the past is refused even with an override', async () => {
    const m = await staff('manager');
    const start = Date.now() - 2 * DAY;
    const r = await post('/schedule', m.token, { branchId: BRANCH, title: 'Late', arenaId: await arena(), coachId: (await staff('coach')).id, format: 'group', startsAt: iso(start), endsAt: iso(start + HOUR), capacity: 2, override: { reason: 'x' } });
    assert.equal(r.status, 422);
    assert.ok(codes(r).includes('IN_THE_PAST'));
  });

  test('bookings stop at the arena capacity even when the class says more', async () => {
    const rec = await staff('reception');
    const occurrenceId = await makeClass({ startsAt: slot(), capacity: 6, arenaId: await arena(1) });
    const first = await post('/bookings', rec.token, { occurrenceId, riderId: await readyRider(), payWith: 'office' });
    const second = await post('/bookings', rec.token, { occurrenceId, riderId: await readyRider(), payWith: 'office' });
    assert.equal(first.body.status, 'pending_office_payment');
    assert.equal(second.body.status, 'waitlisted');
  });
});

describe('publish and change', () => {
  test('a draft is published, then moved; a coach may not', async () => {
    const m = await staff('manager');
    const coach = await staff('coach');
    const start = slot();
    const made = await post('/schedule', m.token, { branchId: BRANCH, title: 'Draft', arenaId: await arena(), coachId: coach.id, format: 'group', startsAt: iso(start), endsAt: iso(start + HOUR), capacity: 2, status: 'draft' });
    assert.equal((await post(`/schedule/${made.body.id}/publish`, coach.token, {})).status, 403);
    const published = await post(`/schedule/${made.body.id}/publish`, m.token, {});
    assert.equal(published.body.status, 'published', published.text);
    assert.equal((await post(`/schedule/${made.body.id}/publish`, m.token, {})).status, 409);
    const moved = await api('PATCH', `/schedule/${made.body.id}`, { token: m.token, body: { startsAt: iso(start + 2 * HOUR) } });
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual(moved.body.changed.sort(), ['endsAt', 'startsAt']);
  });
});

describe('safety and desk work', () => {
  test('a child with no emergency contact cannot be booked', async () => {
    const rec = await staff('reception');
    const child = await makeRider({ dob: '2016-01-01' });
    await verifyDocs(child);
    const parent = await post('/accounts/customers', rec.token, { fullName: 'Parent', phone: `+9665${String(Date.now()).slice(-8)}` });
    assert.equal(parent.status, 201, parent.text);
    assert.equal((await post(`/riders/${child}/guardians`, rec.token, { accountId: parent.body.id })).status, 201);
    await ctx.admin.query(`UPDATE riders SET emergency_contact = NULL WHERE id = $1`, [child]);
    const r = await post('/bookings', rec.token, { occurrenceId: await makeClass({ startsAt: slot() }), riderId: child, payWith: 'office' });
    assert.deepEqual(codes(r), ['EMERGENCY_CONTACT_REQUIRED']);
  });

  test('the same name and birth date needs a confirmation', async () => {
    const rec = await staff('reception');
    const body = { branchId: BRANCH, fullName: `Twin ${Date.now()}`, dateOfBirth: '1990-02-02' };
    assert.equal((await post('/riders', rec.token, body)).status, 201);
    const again = await post('/riders', rec.token, body);
    assert.equal(again.status, 409);
    assert.deepEqual(codes(again), ['DUPLICATE_RIDER']);
    assert.equal((await post('/riders', rec.token, { ...body, confirmDuplicate: true })).status, 201);
  });

  test('a rider let in unpaid can pay later, once', async () => {
    const m = await staff('manager');
    const start = slot();
    const occurrenceId = await makeClass({ startsAt: start });
    await ctx.admin.query(`UPDATE occurrences SET price_minor = 5000 WHERE id = $1`, [occurrenceId]);
    const b = await post('/bookings', m.token, { occurrenceId, riderId: await readyRider(), payWith: 'office' });
    assert.equal((await post(`/bookings/${b.body.id}/confirm-unpaid`, m.token, { reason: 'later' })).status, 201);
    const paid = await post(`/bookings/${b.body.id}/payment`, m.token, { method: 'cash', amountMinor: 5000 });
    assert.equal(paid.status, 201, paid.text);
    assert.ok(paid.body.receipt.number);
    assert.equal((await post(`/bookings/${b.body.id}/payment`, m.token, { method: 'cash', amountMinor: 5000 })).status, 409);
    const preview = await api('GET', `/bookings/${b.body.id}/cancel-preview?cause=club`, { token: m.token });
    assert.equal(preview.body.payment.paidMinor, 5000, preview.text);
  });
});

describe('safety records', () => {
  test('a horse weight limit needs the rider weight and refuses a heavier rider', async () => {
    const m = await staff('manager');
    const arenaId = await arena();
    const occurrenceId = await makeClass({ startsAt: slot(), arenaId });
    const riderId = await readyRider();
    await post('/bookings', m.token, { occurrenceId, riderId, payWith: 'office' });
    const horse = await post('/horses', m.token, { branchId: BRANCH, name: `QA horse ${Date.now()}`, suitableLevels: ['beginner'], arenaIds: [arenaId], maxRiderWeightKg: 60 });
    assert.equal(horse.status, 201, horse.text);
    const unknown = await post(`/schedule/${occurrenceId}/horses`, m.token, { horseId: horse.body.id, riderId });
    assert.deepEqual(codes(unknown), ['RIDER_WEIGHT_UNKNOWN']);
    await ctx.admin.query('UPDATE riders SET weight_kg = 75 WHERE id = $1', [riderId]);
    const heavy = await post(`/schedule/${occurrenceId}/horses`, m.token, { horseId: horse.body.id, riderId, override: { reason: 'no' } });
    assert.deepEqual(codes(heavy), ['RIDER_TOO_HEAVY']);
  });

  test('an instructor who is not qualified for the level needs an override', async () => {
    const m = await staff('manager');
    const coach = await staff('coach');
    assert.equal((await api('PUT', `/staff/${coach.id}/profile`, { token: m.token, body: { levels: ['beginner'] } })).status, 200);
    const start = slot();
    const r = await post('/schedule', m.token, { branchId: BRANCH, title: 'Adv', arenaId: await arena(), coachId: coach.id, format: 'group', minLevel: 'advanced', startsAt: iso(start), endsAt: iso(start + HOUR), capacity: 2 });
    assert.deepEqual(codes(r), ['COACH_NOT_QUALIFIED']);
  });

  test('a shared arena takes a second session only while the places fit', async () => {
    const m = await staff('manager');
    const arenaId = await arena(5);
    await ctx.admin.query('UPDATE arenas SET shared_use = true WHERE id = $1', [arenaId]);
    const start = slot();
    const make = async (capacity: number) => post('/schedule', m.token, { branchId: BRANCH, title: 'Shared', arenaId, coachId: (await staff('coach')).id, format: 'group', startsAt: iso(start), endsAt: iso(start + HOUR), capacity });
    assert.equal((await make(3)).status, 201);
    assert.equal((await make(2)).status, 201);
    assert.deepEqual(codes(await make(1)), ['ARENA_SHARED_FULL']);
  });

  test('a new waiver version must be signed before riding', async () => {
    const branch = await makeBranch();
    const m = await staff('manager', [branch]);
    const riderId = await readyRider({ branchId: branch });
    const klass = async () => makeClass({ branchId: branch, startsAt: slot() });
    const published = await post('/waiver-versions', m.token, { branchId: branch, version: `v${Date.now()}`, body: 'New wording', requiresResign: true });
    assert.equal(published.status, 201, published.text);
    const refused = await post('/bookings', m.token, { occurrenceId: await klass(), riderId, payWith: 'office' });
    assert.deepEqual(codes(refused), ['WAIVER_MISSING']);
    const doc = await post(`/riders/${riderId}/documents`, m.token, { kind: 'waiver' });
    await post(`/documents/${doc.body.id}/verify`, m.token);
    assert.equal((await post('/bookings', m.token, { occurrenceId: await klass(), riderId, payWith: 'office' })).status, 201);
  });
});

describe('the day sheet', () => {
  test('lists a horse that was assigned or only recorded as ridden', async () => {
    const m = await staff('manager');
    const arenaId = await arena();
    const start = Date.now() - 20 * 60000;
    const occurrenceId = await makeClass({ startsAt: start, arenaId });
    const booking = await directBooking({ occurrenceId, riderId: await readyRider() });
    const name = `Ridden ${process.pid}-${Date.now()}`;
    const horse = await post('/horses', m.token, { branchId: BRANCH, name, suitableLevels: ['beginner'], arenaIds: [arenaId] });
    const listed = async () => (await api('GET', `/schedule?branchId=${BRANCH}&from=${iso(start - HOUR)}&to=${iso(start + HOUR)}`, { token: m.token })).body.find((o: { id: string }) => o.id === occurrenceId).horses;
    assert.equal(await listed(), null);
    assert.equal((await api('PUT', `/bookings/${booking}/record`, { token: m.token, body: { horseId: horse.body.id } })).status, 200);
    assert.equal(await listed(), name);
  });
});

describe('least privilege and privacy', () => {
  test('a title is refused the rider documents and money it has no work with, whatever the capitals', async () => {
    const riderId = await readyRider();
    const status = async (role: string, path: string) => (await api('GET', path, { token: (await staff(role)).token })).status;
    for (const role of ['finance', 'scheduler', 'auditor']) {
      assert.equal(await status(role, `/riders/${riderId}/documents`), 403, role);
      assert.equal(await status(role, `/Riders/${riderId}/DOCUMENTS`), 403, role);
    }
    for (const part of ['account', 'packages', 'Account', 'packages/']) assert.equal(await status('scheduler', `/riders/${riderId}/${part}`), 403, part);
    assert.equal(await status('scheduler', `/riders/${riderId}`), 200);
    for (const role of ['finance', 'auditor', 'reception']) assert.equal(await status(role, `/riders/${riderId}/account`), 200, role);
    for (const role of ['reception', 'director']) assert.equal(await status(role, `/riders/${riderId}/documents`), 200, role);
  });

  test('showing medical details to staff is recorded, without the details; a title that is not shown them leaves no entry', async () => {
    const riderId = await readyRider();
    await ctx.admin.query(`UPDATE riders SET medical_notes = 'asthma' WHERE id = $1`, [riderId]);
    const views = async () => (await ctx.admin.query(`SELECT actor_account_id AS actor, detail::text AS d FROM audit_log WHERE entity_id = $1 AND action = 'rider.medical_view'`, [riderId])).rows;
    assert.equal((await api('GET', `/riders/${riderId}`, { token: (await staff('finance')).token })).body.medicalNotes, null);
    assert.equal((await views()).length, 0);
    const rec = await staff('reception');
    assert.equal((await api('GET', `/riders/${riderId}`, { token: rec.token })).body.medicalNotes, 'asthma');
    const seen = await views();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].actor, rec.id);
    assert.ok(!seen[0].d.includes('asthma'));
  });

  test("the family sees a lesson's outcome but not the instructor's notes", async () => {
    const parent = await customer();
    const riderId = await readyRider();
    await guard(parent.id, riderId);
    const booking = await directBooking({ occurrenceId: await makeClass({ startsAt: Date.now() - 20 * 60000 }), riderId });
    await ctx.admin.query(`UPDATE bookings SET lesson_outcome = 'Good seat', instructor_notes = 'Internal only' WHERE id = $1`, [booking]);
    const family = (await api('GET', `/riders/${riderId}/history`, { token: parent.token })).body.bookings[0];
    assert.equal(family.outcome, 'Good seat');
    assert.equal(family.notes, null);
    assert.equal((await api('GET', `/riders/${riderId}/history`, { token: (await staff('reception')).token })).body.bookings[0].notes, 'Internal only');
  });
});

describe('two schedulers at once', () => {
  test('the second is always told about the clash, never given a server error', async () => {
    const m = await staff('manager');
    const rec = await staff('reception');
    const arenaId = await arena(8);
    const coaches = [(await staff('coach')).id, (await staff('coach')).id];
    for (let round = 0; round < 60; round++) {
      const start = slot();
      const body = { branchId: BRANCH, title: 'Race', arenaId, format: 'group', startsAt: iso(start), endsAt: iso(start + HOUR), capacity: 2 };
      const two = await Promise.all([post('/schedule', m.token, { ...body, coachId: coaches[0] }), post('/schedule', rec.token, { ...body, coachId: coaches[1] })]);
      const [first, second] = two.map((r) => r.status).sort();
      assert.equal(first, 201, `round ${round}: ${two.map((r) => r.text).join(' / ')}`);
      assert.ok(second === 409 || second === 422, `round ${round}: second got ${second}`);
    }
  });
});

describe('lessons, rides and packages', () => {
  const rideType = async (m: { token: string }, extra: object = {}) =>
    (await post('/ride-types', m.token, { branchId: BRANCH, name: `QA ride ${process.pid}-${++n}`, priceMinor: 20000, durationMinutes: 60, capacity: 4, ...extra })).body.id as string;

  test('a ride that needs a horse is drafted, given one, then published', async () => {
    const m = await staff('manager');
    const arenaId = await arena();
    const rideTypeId = await rideType(m, { horseRequired: true });
    const body = { branchId: BRANCH, rideTypeId, arenaId, coachId: (await staff('coach')).id, startsAt: iso(slot()) };
    assert.deepEqual(codes(await post('/rides', m.token, body)), ['HORSE_REQUIRED']);
    const draft = await post('/rides', m.token, { ...body, status: 'draft' });
    assert.equal(draft.status, 201, draft.text);
    assert.deepEqual(codes(await post(`/schedule/${draft.body.id}/publish`, m.token, {})), ['HORSE_REQUIRED']);
    const horse = await post('/horses', m.token, { branchId: BRANCH, name: `QA ride horse ${Date.now()}`, suitableLevels: ['beginner'], arenaIds: [arenaId] });
    assert.equal((await post(`/schedule/${draft.body.id}/horses`, m.token, { horseId: horse.body.id })).status, 201);
    assert.equal((await post(`/schedule/${draft.body.id}/publish`, m.token, {})).status, 201);
  });

  test('a package covers a ride only when it names the ride type; a later rate applies from its day', async () => {
    const m = await staff('manager');
    const rideTypeId = await rideType(m);
    const start = slot();
    assert.equal((await post(`/ride-types/${rideTypeId}/rates`, m.token, { fromDate: iso(start - 10 * DAY).slice(0, 10), priceMinor: 33000, durationMinutes: 90 })).status, 201);
    const ride = await post('/rides', m.token, { branchId: BRANCH, rideTypeId, arenaId: await arena(), coachId: (await staff('coach')).id, startsAt: iso(start) });
    assert.equal(ride.status, 201, ride.text);
    const saved = (await ctx.admin.query('SELECT price_minor, extract(epoch FROM upper(during) - lower(during))::int AS s FROM occurrences WHERE id = $1', [ride.body.id])).rows[0];
    assert.deepEqual([saved.price_minor, saved.s], [33000, 5400]);
    const riderId = await readyRider();
    const sell = async (rideTypeIds: string[]) => {
      const type = await post('/package-types', m.token, { branchId: BRANCH, name: `QA pack ${++n}`, classes: 3, priceMinor: 1000, validDays: 1095 * 1, classFormats: rideTypeIds.length ? [] : ['group'], rideTypeIds });
      assert.equal(type.status, 201, type.text);
      const sold = await post(`/riders/${riderId}/packages`, m.token, { packageTypeId: type.body.id, method: 'cash' });
      await ctx.admin.query(`UPDATE rider_packages SET valid_until = '2060-01-01' WHERE id = $1`, [sold.body.id]);
      return sold.body.id as string;
    };
    const wrong = await post('/bookings', m.token, { occurrenceId: ride.body.id, riderId, payWith: 'package', packageId: await sell([]) });
    assert.ok(codes(wrong).includes('RIDE_NOT_IN_PACKAGE'), wrong.text);
    const right = await post('/bookings', m.token, { occurrenceId: ride.body.id, riderId, payWith: 'package', packageId: await sell([rideTypeId]) });
    assert.equal(right.body.status, 'confirmed', right.text);
    assert.match(right.body.number, /^B-\d+$/);
  });

  test('a one-off class takes no package and cannot repeat', async () => {
    const m = await staff('manager');
    const type = await post('/class-types', m.token, { branchId: BRANCH, name: `QA trial ${++n}`, format: 'trial', durationMinutes: 45, capacity: 1, minLevel: 'beginner', priceMinor: 9000, singleVisit: true });
    assert.equal(type.status, 201, type.text);
    const start = slot();
    const body = { branchId: BRANCH, title: 'Trial', arenaId: await arena(), coachId: (await staff('coach')).id, format: 'trial', classTypeId: type.body.id, startsAt: iso(start), endsAt: iso(start + HOUR), capacity: 1, priceMinor: 9000 };
    assert.deepEqual(codes(await post('/schedule/series', m.token, { ...body, repeat: { everyWeeks: 1, count: 2 }, skipConflicts: true })), ['SINGLE_VISIT_NO_SERIES']);
    assert.deepEqual(codes(await post('/schedule', m.token, { ...body, capacity: 2 })), ['CLASS_TYPE_CAPACITY']);
    const made = await post('/schedule', m.token, body);
    const riderId = await readyRider();
    const r = await post('/bookings', m.token, { occurrenceId: made.body.id, riderId, payWith: 'package', packageId: await makePackage(riderId, { formats: ['trial'] }) });
    assert.ok(codes(r).includes('SINGLE_VISIT_NO_PACKAGE'), r.text);
  });

  test('changing final attendance needs a manager and a reason, and returns the class', async () => {
    const m = await staff('manager');
    const riderId = await readyRider();
    const packageId = await makePackage(riderId, { balance: 2 });
    const occurrenceId = await makeClass({ startsAt: Date.now() - 2 * HOUR });
    const bookingId = await directBooking({ occurrenceId, riderId, packageId, status: 'completed' });
    assert.equal(await balanceOf(packageId), 1);
    assert.equal((await post(`/bookings/${bookingId}/attendance`, (await staff('reception')).token, { attendance: 'excused', reason: 'x' })).status, 403);
    assert.equal((await post(`/bookings/${bookingId}/attendance`, m.token, { attendance: 'excused' })).status, 400);
    assert.equal((await post(`/bookings/${bookingId}/attendance`, m.token, { attendance: 'excused', reason: 'doctor' })).status, 201);
    assert.equal(await balanceOf(packageId), 2);
    assert.equal((await api('PUT', `/bookings/${bookingId}/record`, { token: m.token, body: { outcome: 'Trotted well' } })).status, 200);
  });
});

describe('incidents, reports and wording', () => {
  test('a serious incident closes only with an immediate action and finished corrective actions', async () => {
    const owner = await staff('owner');
    const made = await post('/incidents', owner.token, { branchId: BRANCH, severity: 'high', kind: 'fall', description: 'Fall', occurredAt: iso(Date.now() - HOUR), witnesses: 'Coach' });
    assert.match(made.body.number, /^INC-\d+$/);
    const id = made.body.id;
    const action = await post(`/incidents/${id}/actions`, owner.token, { action: 'Check the saddle' });
    await ctx.admin.query(`UPDATE incidents SET status = 'pending_closure' WHERE id = $1`, [id]);
    const close = () => post(`/incidents/${id}/status`, owner.token, { status: 'closed', note: 'ok' });
    assert.deepEqual(codes(await close()), ['ACTIONS_OPEN']);
    await post(`/incidents/${id}/actions/${action.body.id}/done`, owner.token, { note: 'checked' });
    assert.deepEqual(codes(await close()), ['IMMEDIATE_ACTION_REQUIRED']);
    assert.equal((await api('PATCH', `/incidents/${id}`, { token: owner.token, body: { immediateAction: 'First aid' } })).status, 200);
    assert.equal((await close()).status, 201);
    const png = await fetchDetail(id, owner.token);
    assert.equal(png.body.actions.length, 1);
  });
  const fetchDetail = (id: string, token: string) => api('GET', `/incidents/${id}/detail`, { token });

  test('every list report runs, and only managers see more than the daily sheet', async () => {
    const m = await staff('manager');
    const q = `branchId=${BRANCH}&from=${iso(Date.now() - 30 * DAY)}&to=${iso(Date.now() + 30 * DAY)}`;
    for (const name of ['daily', 'class-occupancy', 'instructors', 'horse-welfare', 'progression', 'package-liability', 'walk-ins', 'receivables', 'reconciliation', 'incidents']) {
      const r = await api('GET', `/reports/table/${name}?${q}`, { token: m.token });
      assert.equal(r.status, 200, `${name}: ${r.text}`);
    }
    const rec = await staff('reception');
    assert.equal((await api('GET', `/reports/table/daily?${q}`, { token: rec.token })).status, 200);
    assert.equal((await api('GET', `/reports/table/receivables?${q}`, { token: rec.token })).status, 404);
    assert.equal((await api('GET', `/reports/table/constructor?${q}`, { token: m.token })).status, 404);
  });

  test('a branch can use its own message wording and go back', async () => {
    const branch = await makeBranch();
    const m = await staff('manager', [branch]);
    const set = await api('PUT', '/notifications/templates', { token: m.token, body: { branchId: branch, event: 'booking.confirmed', subject: 'See you, {riderName}', body: 'At {when}' } });
    assert.equal(set.status, 200, set.text);
    const list = await api('GET', `/notifications/templates?branchId=${branch}`, { token: m.token });
    assert.equal(list.body.templates.find((t: { event: string }) => t.event === 'booking.confirmed').subject, 'See you, {riderName}');
    assert.equal((await api('PUT', '/notifications/templates', { token: m.token, body: { branchId: branch, event: 'booking.confirmed', subject: null, body: null } })).status, 200);
  });
});

describe('roles and password reset', () => {
  test('finance takes money and reads reports; a scheduler plans; an auditor only reads', async () => {
    const [finance, scheduler, auditor] = [await staff('finance'), await staff('scheduler'), await staff('auditor')];
    const q = `branchId=${BRANCH}&from=${iso(Date.now() - DAY)}&to=${iso(Date.now() + DAY)}`;
    assert.equal((await api('GET', `/reports/table/receivables?${q}`, { token: finance.token })).status, 200);
    assert.equal((await post('/horses', finance.token, {})).status, 403);
    const start = slot();
    const body = { branchId: BRANCH, title: 'Planned', arenaId: await arena(), coachId: (await staff('coach')).id, format: 'group', startsAt: iso(start), endsAt: iso(start + HOUR), capacity: 2 };
    assert.equal((await post('/schedule', scheduler.token, body)).status, 201);
    assert.equal((await api('GET', `/receipts?branchId=${BRANCH}`, { token: scheduler.token })).status, 403);
    const rider = await readyRider();
    await ctx.admin.query(`UPDATE riders SET medical_notes = 'asthma' WHERE id = $1`, [rider]);
    const seen = await api('GET', `/riders/${rider}`, { token: auditor.token });
    assert.deepEqual([seen.status, seen.body.medicalNotes], [200, null]);
    assert.equal((await post('/schedule', auditor.token, body)).status, 403);
    const me = await api('GET', '/auth/me', { token: finance.token });
    assert.deepEqual([me.body.role, me.body.actsAs], ['finance', 'reception']);
  });

  test('a code resets the password once; wrong guesses end it', async () => {
    const who = await staff('reception');
    assert.equal((await api('POST', '/auth/forgot', { body: { identifier: who.email } })).status, 200);
    assert.equal((await api('POST', '/auth/forgot', { body: { identifier: 'nobody@example.test' } })).status, 200);
    const sent = (await ctx.admin.query(`SELECT body FROM notification_outbox WHERE account_id = $1 AND event = 'auth.reset_code'`, [who.id])).rows[0].body as string;
    const code = /code is (\d{6})/.exec(sent)![1];
    const wrong = code === '000000' ? '111111' : '000000';
    const reset = (c: string) => api('POST', '/auth/reset', { body: { identifier: who.email, code: c, newPassword: 'A-new-password-1' } });
    assert.equal((await reset(wrong)).status, 400);
    assert.equal((await reset(code)).status, 200);
    assert.equal((await reset(code)).status, 400, 'a code works once');
    assert.equal((await api('POST', '/auth/login', { body: { identifier: who.email, password: 'A-new-password-1' } })).status, 200);
  });
});
