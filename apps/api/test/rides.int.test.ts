// Rides: the catalogue (ride types), putting a ride on the schedule, and booking, paying and cancelling one.
// A ride is an ordinary scheduled session, so most booking rules are already tested elsewhere. Here we test what is different about rides:
// their own price and length, no class packages, a minimum age, and that nothing about a ride changes when the catalogue does.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, at, BRANCH, ctx, makeAccount, makeArena, makeBranch, randomDay, startApp, stopApp } from './helpers.ts';
import { balanceOf, codes, guard, HOUR, liveBookings, makeClass, makePackage, makeRider, readyRider, verifyDocs } from './booking-helpers.ts';
import { auditActions, customer, directBooking, post, staff, statusOf } from './flow-helpers.ts';
import type { Json } from './helpers.ts';

const DAY = 24 * HOUR;
let M: Awaited<ReturnType<typeof staff>>; // a manager
let R: Awaited<ReturnType<typeof staff>>; // reception
let O: Awaited<ReturnType<typeof staff>>; // an owner

before(async () => {
  await startApp();
  M = await staff('manager');
  R = await staff('reception');
  O = await staff('owner');
});
after(stopApp);

const get = (path: string, token?: string) => api('GET', path, { token });
const patch = (path: string, token: string | undefined, body: unknown) => api('PATCH', path, { token, body });
let n = 0;
const uniq = (p: string) => `${p} ${Date.now()}-${n++}`;
const day = randomDay();
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const typeBody = (o: Record<string, unknown> = {}) => ({ name: uniq('Beach ride'), priceMinor: 11500, durationMinutes: 60, capacity: 4, ...o });

/** A ride type written straight to the database, so setup never depends on the endpoint under test. */
async function makeType(o: { branchId?: string; name?: string; price?: number; duration?: number; capacity?: number; minLevel?: string; minAge?: number | null; active?: boolean; from?: string | null; to?: string | null } = {}): Promise<string> {
  return (
    await ctx.admin.query(
      `INSERT INTO ride_types (branch_id, name, price_minor, duration_minutes, capacity, min_level, min_age_years, active, active_from, active_to)
       VALUES ($1,$2,$3,$4,$5,$6::level,$7,$8,$9,$10) RETURNING id`,
      [o.branchId ?? BRANCH, o.name ?? uniq('Ride'), o.price ?? 11500, o.duration ?? 60, o.capacity ?? 4, o.minLevel ?? 'beginner', o.minAge ?? null, o.active ?? true, o.from ?? null, o.to ?? null],
    )
  ).rows[0].id;
}

/** Puts a ride on the schedule through the API, each with its own location and guide so rides never clash by accident. */
async function scheduleRide(typeId: string, o: { hour?: number; day?: number; token?: string; capacity?: number | string; status?: string; arenaId?: string; coachId?: string; override?: object } = {}) {
  const arenaId = o.arenaId ?? (await makeArena());
  const coachId = o.coachId ?? (await makeAccount({ role: 'coach' })).id;
  const body: Record<string, unknown> = { rideTypeId: typeId, arenaId, coachId, startsAt: at(o.day ?? day, o.hour ?? 9) };
  if (o.capacity !== undefined) body.capacity = o.capacity;
  if (o.status) body.status = o.status;
  if (o.override) body.override = o.override;
  const res = await post('/rides', o.token ?? R.token, body);
  return { res, id: res.body?.id as string, arenaId, coachId };
}
async function rideId(typeId: string, o: Parameters<typeof scheduleRide>[1] = {}): Promise<string> {
  const r = await scheduleRide(typeId, o);
  assert.equal(r.res.status, 201, r.res.text);
  return r.id;
}
const book = (token: string, occurrenceId: string, riderId: string, extra: Record<string, unknown> = {}) => post('/bookings', token, { occurrenceId, riderId, payWith: 'office', ...extra });
const occurrence = async (id: string) =>
  (await ctx.admin.query(`SELECT format, title, price_minor, capacity, min_level, min_age_years, ride_type_id, status, (extract(epoch from (upper(during) - lower(during))) / 60)::int AS minutes FROM occurrences WHERE id = $1`, [id])).rows[0];
async function makeHorse(arenaIds: string[]): Promise<string> {
  const id: string = (await ctx.admin.query(`INSERT INTO horses (branch_id, name, suitable_levels) VALUES ($1,$2,'{beginner,intermediate,advanced}') RETURNING id`, [BRANCH, uniq('Horse')])).rows[0].id;
  for (const a of arenaIds) await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [id, a]);
  return id;
}

describe('ride types: the catalogue', () => {
  test('no token is refused; only managers and owners create or change a type; everyone else gets 403', async () => {
    const body = typeBody();
    assert.equal((await post('/ride-types', undefined, body)).status, 401);
    const others = [await customer(), await staff('reception'), await staff('coach'), await staff('stable_hand')];
    for (const who of others) assert.equal((await post('/ride-types', who.token, body)).status, 403);
    const id = await makeType();
    assert.equal((await patch(`/ride-types/${id}`, undefined, { priceMinor: 1 })).status, 401);
    for (const who of others) assert.equal((await patch(`/ride-types/${id}`, who.token, { priceMinor: 1 })).status, 403);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM ride_types WHERE name = $1`, [body.name])).rows[0].n, 0, 'a refused request writes nothing');
    assert.equal((await ctx.admin.query(`SELECT price_minor FROM ride_types WHERE id = $1`, [id])).rows[0].price_minor, 11500);

    const ok = await post('/ride-types', M.token, body);
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(await auditActions(ok.body.id), ['ride_type.create']);
    assert.equal((await post('/ride-types', O.token, typeBody())).status, 201);
  });

  test('bad input is refused with 400 and nothing is saved', async () => {
    const name = uniq('Bad');
    const ok = { name, priceMinor: 11500, durationMinutes: 60, capacity: 4 };
    const bad: unknown[] = [
      {}, { ...ok, name: '' }, { ...ok, name: '   ' }, { ...ok, name: 'x'.repeat(81) },
      { ...ok, priceMinor: -1 }, { ...ok, priceMinor: 11500.5 }, { ...ok, priceMinor: '11500' }, { ...ok, priceMinor: 10_000_001 },
      { ...ok, durationMinutes: 4 }, { ...ok, durationMinutes: 601 }, { ...ok, durationMinutes: 60.5 }, { ...ok, durationMinutes: '60' },
      { ...ok, capacity: 0 }, { ...ok, capacity: 101 }, { ...ok, capacity: 2.5 },
      { ...ok, minLevel: 'expert' }, { ...ok, minAgeYears: -1 }, { ...ok, minAgeYears: 100 }, { ...ok, minAgeYears: 7.5 },
      { ...ok, activeFrom: 'tomorrow' }, { ...ok, activeFrom: '2040-1-1' }, { ...ok, description: 'x'.repeat(1001) }, { ...ok, branchId: 'nope' },
    ];
    for (const b of bad) assert.equal((await post('/ride-types', M.token, b)).status, 400, JSON.stringify(b).slice(0, 80));
    assert.equal((await api('POST', '/ride-types', { token: M.token, rawBody: '{' })).status, 400);
    const dates = await post('/ride-types', M.token, { ...ok, activeFrom: '2040-06-01', activeTo: '2040-05-31' });
    assert.equal(dates.status, 400);
    assert.deepEqual(codes(dates), ['BAD_DATES']);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM ride_types WHERE name = $1`, [name])).rows[0].n, 0);
    assert.equal((await post('/ride-types', M.token, ok)).status, 201, 'the valid version of the same request works');
  });

  test('a branch cannot have two types with the same name, in any capitals; another branch may reuse it', async () => {
    const name = uniq('Desert Ride');
    assert.equal((await post('/ride-types', M.token, typeBody({ name }))).status, 201);
    const again = await post('/ride-types', M.token, typeBody({ name: name.toUpperCase() }));
    assert.equal(again.status, 409);
    assert.deepEqual(codes(again), ['NAME_TAKEN']);
    const other = await staff('manager', [await makeBranch()]);
    assert.equal((await post('/ride-types', other.token, typeBody({ name }))).status, 201);
  });

  test('another branch can neither see nor change this branch\'s types, and nobody can create in a branch they do not work in', async () => {
    const id = await makeType();
    const ob = await makeBranch();
    const om = await staff('manager', [ob]);
    assert.equal((await get(`/ride-types/${id}`, om.token)).status, 404);
    assert.equal((await patch(`/ride-types/${id}`, om.token, { priceMinor: 1 })).status, 404);
    assert.ok(!(await get('/ride-types', om.token)).body.rideTypes.some((t: Json) => t.id === id));
    assert.equal((await post('/ride-types', om.token, typeBody({ branchId: BRANCH }))).status, 403);
    assert.equal((await post('/ride-types', M.token, typeBody({ branchId: ob }))).status, 403);
    assert.equal((await get(`/ride-types?branchId=${ob}`, M.token)).status, 403);
    assert.equal((await ctx.admin.query(`SELECT price_minor FROM ride_types WHERE id = $1`, [id])).rows[0].price_minor, 11500);
  });

  test('customers see only what is on sale, whatever they ask for; staff see everything', async () => {
    const on = await makeType();
    const off = await makeType({ active: false });
    assert.equal((await get('/ride-types')).status, 401);
    const c = await customer();
    const cust = await get('/ride-types?includeInactive=true', c.token);
    assert.equal(cust.status, 200);
    const ids = cust.body.rideTypes.map((t: Json) => t.id);
    assert.ok(ids.includes(on) && !ids.includes(off));
    assert.equal((await get(`/ride-types/${on}`, c.token)).status, 200);
    assert.equal((await get(`/ride-types/${off}`, c.token)).status, 404, 'a switched-off type does not exist for customers');

    assert.ok((await get('/ride-types', R.token)).body.rideTypes.some((t: Json) => t.id === off));
    assert.ok(!(await get('/ride-types?includeInactive=false', R.token)).body.rideTypes.some((t: Json) => t.id === off));
    const one = (await get(`/ride-types/${off}`, R.token)).body;
    assert.deepEqual([one.priceMinor, one.durationMinutes, one.capacity, one.minLevel, one.minAgeYears, one.active, one.activeFrom], [11500, 60, 4, 'beginner', null, false, null]);
  });

  test('list and read: bad input and unknown ids', async () => {
    assert.equal((await get('/ride-types?includeInactive=maybe', R.token)).status, 400);
    assert.equal((await get('/ride-types?branchId=nope', R.token)).status, 400);
    assert.equal((await get('/ride-types/nope', R.token)).status, 400);
    assert.equal((await get('/ride-types/00000000-0000-0000-0000-00000000dead', R.token)).status, 404);
  });

  test('editing saves the change, records old and new values, and refuses bad or empty changes', async () => {
    const id = await makeType({ price: 11500, duration: 60, capacity: 4, minAge: 8 });
    const renamed = uniq('Renamed');
    const r = await patch(`/ride-types/${id}`, M.token, { priceMinor: 15000, durationMinutes: 90, name: renamed });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([...r.body.changed].sort(), ['durationMinutes', 'name', 'priceMinor']);
    assert.match(r.body.note, /already scheduled/i);
    const row = (await ctx.admin.query(`SELECT name, price_minor, duration_minutes FROM ride_types WHERE id = $1`, [id])).rows[0];
    assert.deepEqual([row.name, row.price_minor, row.duration_minutes], [renamed, 15000, 90]);
    const log = (await ctx.admin.query(`SELECT detail FROM audit_log WHERE entity_id = $1 AND action = 'ride_type.update'`, [id])).rows[0].detail;
    assert.deepEqual(log.priceMinor, { from: 11500, to: 15000 });
    assert.deepEqual(log.durationMinutes, { from: 60, to: 90 });
    assert.ok(!('name' in log) || typeof log.name !== 'object', 'free text is not copied into the log');

    assert.equal((await patch(`/ride-types/${id}`, M.token, {})).status, 400);
    for (const b of [{ priceMinor: -5 }, { durationMinutes: 0 }, { capacity: 0 }, { name: '' }, { active: 'yes' }, { minLevel: 'expert' }, { activeFrom: 'soon' }]) {
      assert.equal((await patch(`/ride-types/${id}`, M.token, b)).status, 400, JSON.stringify(b));
    }
    // A date range is checked against what is already stored.
    assert.equal((await patch(`/ride-types/${id}`, M.token, { activeFrom: '2040-06-01' })).status, 200);
    const clash = await patch(`/ride-types/${id}`, M.token, { activeTo: '2040-05-01' });
    assert.equal(clash.status, 400);
    assert.deepEqual(codes(clash), ['BAD_DATES']);
    assert.equal((await patch(`/ride-types/${id}`, M.token, { activeFrom: null, minAgeYears: null })).status, 200);
    assert.equal((await ctx.admin.query(`SELECT min_age_years, active_from FROM ride_types WHERE id = $1`, [id])).rows[0].min_age_years, null);
    assert.equal((await ctx.admin.query(`SELECT price_minor FROM ride_types WHERE id = $1`, [id])).rows[0].price_minor, 15000, 'refused changes left it alone');

    assert.equal((await patch('/ride-types/00000000-0000-0000-0000-00000000dead', M.token, { priceMinor: 1 })).status, 404);
    assert.equal((await patch('/ride-types/nope', M.token, { priceMinor: 1 })).status, 400);
    const taken = await makeType({ name: uniq('Taken') });
    const name = (await ctx.admin.query(`SELECT name FROM ride_types WHERE id = $1`, [taken])).rows[0].name;
    const dup = await patch(`/ride-types/${id}`, M.token, { name: name.toLowerCase() });
    assert.equal(dup.status, 409);
    assert.deepEqual(codes(dup), ['NAME_TAKEN']);
  });
});

describe('scheduling a ride', () => {
  test('only reception, manager and owner may schedule; a refused request writes nothing', async () => {
    const t = await makeType();
    const body = { rideTypeId: t, arenaId: await makeArena(), coachId: (await makeAccount({ role: 'coach' })).id, startsAt: at(day, 7) };
    assert.equal((await post('/rides', undefined, body)).status, 401);
    for (const who of [await customer(), await staff('coach'), await staff('stable_hand')]) assert.equal((await post('/rides', who.token, body)).status, 403);
    assert.equal((await post('/rides', M.token, { branchId: BRANCH })).status, 400);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM occurrences WHERE ride_type_id = $1`, [t])).rows[0].n, 0);
    for (const who of [R, M, O]) {
      const r = await scheduleRide(t, { token: who.token, hour: 6 });
      assert.equal(r.res.status, 201, r.res.text);
    }
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM occurrences WHERE ride_type_id = $1`, [t])).rows[0].n, 3);
  });

  test('a ride takes its name, price, length, capacity, level and minimum age from the ride type', async () => {
    const name = uniq('Sunset ride');
    const t = await makeType({ name, price: 11500, duration: 75, capacity: 5, minLevel: 'intermediate', minAge: 8 });
    const r = await scheduleRide(t, { hour: 10 });
    assert.equal(r.res.status, 201, r.res.text);
    const o = await occurrence(r.id);
    assert.deepEqual(
      [o.format, o.title, o.price_minor, o.minutes, o.capacity, o.min_level, o.min_age_years, o.ride_type_id, o.status],
      ['ride', name, 11500, 75, 5, 'intermediate', 8, t, 'published'],
    );
    assert.deepEqual(await auditActions(r.id), ['occurrence.create']);
    const draft = await scheduleRide(t, { hour: 12, status: 'draft' });
    assert.equal((await occurrence(draft.id)).status, 'draft');
    assert.equal((await scheduleRide(t, { hour: 13, status: 'cancelled' })).res.status, 400);
  });

  test('capacity may be lowered for one ride but never raised above the type', async () => {
    const t = await makeType({ capacity: 4 });
    const lower = await scheduleRide(t, { hour: 8, capacity: 2 });
    assert.equal(lower.res.status, 201);
    assert.equal((await occurrence(lower.id)).capacity, 2);
    const over = await scheduleRide(t, { hour: 8, capacity: 5 });
    assert.equal(over.res.status, 422);
    assert.deepEqual(codes(over.res), ['CAPACITY_OVER_TYPE']);
    for (const c of [0, -1, 2.5, '3']) assert.equal((await scheduleRide(t, { hour: 8, capacity: c as Json })).res.status, 400, String(c));
  });

  test('a switched-off type cannot be scheduled; open-from and open-until dates use the branch\'s own calendar day', async () => {
    const off = await scheduleRide(await makeType({ active: false }));
    assert.equal(off.res.status, 422);
    assert.deepEqual(codes(off.res), ['RIDE_TYPE_INACTIVE']);

    const before = await scheduleRide(await makeType({ from: ymd(day + DAY) }));
    assert.deepEqual([before.res.status, ...codes(before.res)], [422, 'OUTSIDE_ACTIVE_DATES']);
    const after = await scheduleRide(await makeType({ to: ymd(day - DAY) }));
    assert.deepEqual([after.res.status, ...codes(after.res)], [422, 'OUTSIDE_ACTIVE_DATES']);
    assert.equal((await scheduleRide(await makeType({ from: ymd(day), to: ymd(day) }))).res.status, 201);

    // Riyadh is 3 hours ahead of UTC, so 22:00 UTC on `day` is 01:00 the NEXT local day.
    const lateOnLastDay = await scheduleRide(await makeType({ to: ymd(day) }), { hour: 22 });
    assert.deepEqual([lateOnLastDay.res.status, ...codes(lateOnLastDay.res)], [422, 'OUTSIDE_ACTIVE_DATES']);
    assert.equal((await scheduleRide(await makeType({ from: ymd(day + DAY) }), { hour: 22 })).res.status, 201);
  });

  test('unknown ride type, a type from another branch, and bad ids', async () => {
    const gone = await scheduleRide('00000000-0000-0000-0000-00000000dead');
    assert.equal(gone.res.status, 404);
    const foreign = await scheduleRide(await makeType({ branchId: await makeBranch() }));
    assert.equal(foreign.res.status, 404, 'a type that belongs to another branch is not found');
    for (const b of [{ rideTypeId: 'nope' }, { arenaId: 'nope' }, { coachId: 'nope' }, { startsAt: 'later' }, { startsAt: undefined }]) {
      const t = await makeType();
      const body = { rideTypeId: t, arenaId: await makeArena(), coachId: (await makeAccount({ role: 'coach' })).id, startsAt: at(day, 5), ...b };
      assert.equal((await post('/rides', R.token, body)).status, 400, JSON.stringify(b));
    }
  });

  test('the location and guide must belong to this branch, and the guide must be a coach', async () => {
    const t = await makeType();
    const ob = await makeBranch();
    assert.equal((await scheduleRide(t, { arenaId: await makeArena(ob) })).res.status, 400);
    assert.equal((await scheduleRide(t, { coachId: (await makeAccount({ role: 'coach', branchIds: [ob] })).id })).res.status, 400);
    assert.equal((await scheduleRide(t, { coachId: (await makeAccount({ role: 'reception' })).id })).res.status, 400);
    assert.equal((await scheduleRide(t, { coachId: (await makeAccount({ role: 'coach', status: 'locked' })).id })).res.status, 400);
  });

  test('two rides cannot share a location or a guide at the same time; only a manager may override, with a reason', async () => {
    const t = await makeType();
    const first = await scheduleRide(t, { hour: 15 });
    assert.equal(first.res.status, 201);
    const sameLocation = await scheduleRide(t, { hour: 15, arenaId: first.arenaId });
    assert.equal(sameLocation.res.status, 422);
    assert.deepEqual(codes(sameLocation.res), ['ARENA_OVERLAP']);
    const sameGuide = await scheduleRide(t, { hour: 15, coachId: first.coachId });
    assert.equal(sameGuide.res.status, 422);
    assert.deepEqual(codes(sameGuide.res), ['COACH_OVERLAP']);
    // Reception cannot override, even with a reason.
    assert.equal((await scheduleRide(t, { hour: 15, arenaId: first.arenaId, override: { reason: 'Two groups on a wide beach' } })).res.status, 422);
    // A manager can, but must say why.
    assert.equal((await scheduleRide(t, { hour: 15, arenaId: first.arenaId, token: M.token, override: { reason: '' } })).res.status, 400);
    const forced = await scheduleRide(t, { hour: 15, arenaId: first.arenaId, token: M.token, override: { reason: 'Two groups on a wide beach' } });
    assert.equal(forced.res.status, 201, forced.res.text);
    assert.equal(forced.res.body.overridden, true);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM occurrence_overrides WHERE occurrence_id = $1`, [forced.id])).rows[0].n, 1);
    // Back to back is not a clash: the first ride ends at 16:00.
    assert.equal((await scheduleRide(t, { hour: 16, arenaId: first.arenaId })).res.status, 201);
  });

  test('a closed location refuses the ride', async () => {
    const t = await makeType();
    const arenaId = await makeArena();
    await ctx.admin.query(`INSERT INTO arena_closures (arena_id, during, reason) VALUES ($1, tstzrange($2::timestamptz, $3::timestamptz), 'High tide')`, [arenaId, at(day, 8), at(day, 12)]);
    const r = await scheduleRide(t, { hour: 9, arenaId });
    assert.equal(r.res.status, 422);
    assert.deepEqual(codes(r.res), ['ARENA_CLOSED']);
  });

  test('the class schedule cannot create a ride, and class packages cannot name rides', async () => {
    const t = await post('/schedule', R.token, { branchId: BRANCH, title: 'Sneaky', arenaId: await makeArena(), coachId: (await makeAccount({ role: 'coach' })).id, format: 'ride', startsAt: at(day, 4), endsAt: at(day, 5), capacity: 3 });
    assert.equal(t.status, 400);
    const pkg = await post('/package-types', M.token, { name: uniq('Pack'), classes: 5, priceMinor: 50000, validDays: 90, classFormats: ['group', 'ride'] });
    assert.equal(pkg.status, 400);
  });

  test('the database itself refuses a ride without a type, a class with a type, and a package that covers rides', async () => {
    const arenaId = await makeArena();
    const coachId = (await makeAccount({ role: 'coach' })).id;
    const insert = (format: string, rideTypeId: string | null) =>
      ctx.admin.query(
        `INSERT INTO occurrences (branch_id, title, format, arena_id, coach_id, during, capacity, ride_type_id) VALUES ($1,'x',$2,$3,$4,tstzrange($5::timestamptz,$6::timestamptz),1,$7)`,
        [BRANCH, format, arenaId, coachId, at(day, 1), at(day, 2), rideTypeId],
      );
    await assert.rejects(insert('ride', null), /ride_has_type/);
    await assert.rejects(insert('group', await makeType()), /ride_has_type/);
    await assert.rejects(
      ctx.admin.query(`INSERT INTO package_types (branch_id, name, classes, price_minor, valid_days, class_formats) VALUES ($1,$2,5,0,30,ARRAY['group','ride']::class_format[])`, [BRANCH, uniq('Bad pack')]),
      /packages_never_cover_rides/,
    );
  });

  test('the schedule can show classes only, rides only, or both; customers see published rides only', async () => {
    const kday = randomDay();
    const t = await makeType({ minAge: 6 });
    const published = await rideId(t, { day: kday, hour: 9 });
    const draft = await rideId(t, { day: kday, hour: 11, status: 'draft' });
    const klass = await makeClass({ startsAt: kday + 14 * HOUR });
    const q = (extra: string) => `/schedule?from=${encodeURIComponent(at(kday, 0))}&to=${encodeURIComponent(at(kday, 24))}${extra}`;
    const ids = async (extra: string, token = R.token) => {
      const r = await get(q(extra), token);
      assert.equal(r.status, 200, r.text);
      return new Set<string>(r.body.map((o: Json) => o.id));
    };
    const rides = await ids('&kind=ride');
    assert.ok(rides.has(published) && rides.has(draft) && !rides.has(klass));
    const classes = await ids('&kind=class');
    assert.ok(classes.has(klass) && !classes.has(published));
    const both = await ids('');
    assert.ok(both.has(published) && both.has(klass));
    assert.equal((await get(q('&kind=bogus'), R.token)).status, 400);

    const row = (await get(q('&kind=ride'), R.token)).body.find((o: Json) => o.id === published);
    assert.deepEqual([row.format, row.rideTypeId, row.minAgeYears, row.priceMinor], ['ride', t, 6, 11500]);
    const c = await customer();
    const seen = await ids('&kind=ride', c.token);
    assert.ok(seen.has(published) && !seen.has(draft), 'a draft ride is hidden from customers');
  });
});

describe('booking and paying for a ride', () => {
  test('a customer books a ride and pays at the office: it is held, then confirmed with a receipt', async () => {
    const t = await makeType({ price: 11500 });
    const ride = await rideId(t);
    const c = await customer();
    const b = await book(c.token, ride, c.riderId);
    assert.equal(b.status, 201, b.text);
    assert.equal(b.body.status, 'pending_office_payment');
    assert.ok(b.body.holdExpiresAt, 'the place is held for a limited time');
    assert.deepEqual(await auditActions(b.body.id), ['booking.create']);

    const pay = await post(`/bookings/${b.body.id}/payment`, R.token, { method: 'cash', amountMinor: 11500 });
    assert.equal(pay.status, 201, pay.text);
    assert.equal(pay.body.status, 'confirmed');
    assert.equal(pay.body.receipt.vatMinor, 1500);
    assert.equal(await statusOf(b.body.id), 'confirmed');
  });

  test('a class package can never pay for a ride, and its classes are untouched', async () => {
    const t = await makeType();
    const ride = await rideId(t);
    const rider = await readyRider();
    const pack = await makePackage(rider, { balance: 5, formats: ['group', 'private', 'trial'] });
    const res = await book(R.token, ride, rider, { payWith: 'package', packageId: pack });
    assert.equal(res.status, 422);
    assert.deepEqual(codes(res), ['RIDE_NOT_IN_PACKAGE']);
    assert.equal(await balanceOf(pack), 5);
    assert.equal(await liveBookings(ride), 0);
  });

  test('reception books a ride for a walk-in child of a guardian; a sibling\'s package is neither used nor touched', async () => {
    const t = await makeType({ minAge: 3 });
    const ride = await rideId(t);
    const guardian = await makeAccount({ role: 'customer' });
    const child = await makeRider({ dob: '2034-06-01', name: 'Walk-in child' });
    const sibling = await makeRider({ dob: '2033-02-01', name: 'Sibling' });
    for (const r of [child, sibling]) { await verifyDocs(r); await guard(guardian.id, r); }
    const pack = await makePackage(sibling, { balance: 5 });

    const res = await book(R.token, ride, child);
    assert.equal(res.status, 201, res.text);
    const row = (await ctx.admin.query(`SELECT rider_id, source, created_by, pay_with, rider_package_id FROM bookings WHERE id = $1`, [res.body.id])).rows[0];
    assert.deepEqual([row.rider_id, row.source, row.created_by, row.pay_with, row.rider_package_id], [child, 'staff_portal', R.id, 'office', null]);

    const sneaky = await book(R.token, ride, child, { payWith: 'package', packageId: pack });
    assert.equal(sneaky.status, 422);
    assert.ok(codes(sneaky).includes('RIDE_NOT_IN_PACKAGE'));
    assert.equal(await balanceOf(pack), 5);
  });

  test('age, level and documents are all checked for a ride, and every reason comes back at once', async () => {
    const t = await makeType({ minLevel: 'advanced', minAge: 15 });
    const ride = await rideId(t);
    const guardian = await makeAccount({ role: 'customer' });
    const child = await makeRider({ dob: '2034-06-01', level: 'beginner' }); // at most 14 on the day of any test ride
    await guard(guardian.id, child);
    const res = await book(R.token, ride, child);
    assert.equal(res.status, 422);
    for (const code of ['LEVEL_TOO_LOW', 'RIDER_TOO_YOUNG', 'MEDICAL_MISSING', 'WAIVER_MISSING']) assert.ok(codes(res).includes(code), code);
    assert.equal(await liveBookings(ride), 0);
  });

  test('a customer cannot book an unpublished ride, or book for someone else\'s rider', async () => {
    const t = await makeType();
    const draft = await rideId(t, { status: 'draft' });
    const published = await rideId(t);
    const a = await customer();
    const b = await customer();
    assert.equal((await book(a.token, draft, a.riderId)).status, 404);
    assert.equal((await book(a.token, published, b.riderId)).status, 404);
    const staffView = await book(R.token, draft, a.riderId);
    assert.equal(staffView.status, 422);
    assert.ok(codes(staffView).includes('CLASS_NOT_BOOKABLE'));
  });

  test('the last place cannot be taken twice', async () => {
    const t = await makeType({ capacity: 1 });
    const ride = await rideId(t);
    const [a, b] = [await customer(), await customer()];
    const results = await Promise.all([book(a.token, ride, a.riderId), book(b.token, ride, b.riderId)]);
    for (const r of results) assert.ok([201, 409, 422].includes(r.status), r.text);
    assert.equal(await liveBookings(ride), 1);
  });

  test('changing the catalogue price later does not change a ride that was already booked; new rides use the new price', async () => {
    const t = await makeType({ price: 11500, duration: 60 });
    const ride = await rideId(t, { hour: 9 });
    const c = await customer();
    const b = await book(c.token, ride, c.riderId);
    assert.equal(b.status, 201);

    assert.equal((await patch(`/ride-types/${t}`, M.token, { priceMinor: 99900, durationMinutes: 90 })).status, 200);
    const old = await occurrence(ride);
    assert.deepEqual([old.price_minor, old.minutes], [11500, 60], 'the scheduled ride kept its price and length');

    const wrong = await post(`/bookings/${b.body.id}/payment`, R.token, { method: 'cash', amountMinor: 99900 });
    assert.equal(wrong.status, 422);
    assert.deepEqual(codes(wrong), ['AMOUNT_MISMATCH']);
    const right = await post(`/bookings/${b.body.id}/payment`, R.token, { method: 'cash', amountMinor: 11500 });
    assert.equal(right.status, 201, right.text);

    const later = await occurrence(await rideId(t, { hour: 12 }));
    assert.deepEqual([later.price_minor, later.minutes], [99900, 90], 'a ride scheduled after the change uses the new values');
  });

  test('a customer cancels their own ride early: the hold is released and nothing is charged', async () => {
    const t = await makeType();
    const ride = await rideId(t);
    const c = await customer();
    const b = await book(c.token, ride, c.riderId);
    const x = await post(`/bookings/${b.body.id}/cancel`, c.token, {});
    assert.equal(x.status, 201, x.text);
    assert.deepEqual([x.body.status, x.body.consumedClass], ['cancelled', false]);
    assert.equal(await liveBookings(ride), 0);
    // And the place can be taken again.
    assert.equal((await book(c.token, ride, c.riderId)).status, 201);
  });
});

describe('closing a ride for weather, and the horses on a ride', () => {
  test('horses must be approved for the ride\'s location, as for any class', async () => {
    const ride = await scheduleRide(await makeType());
    const rider = await readyRider();
    await directBooking({ occurrenceId: ride.id, riderId: rider });
    const unapproved = await makeHorse([]);
    const no = await post(`/schedule/${ride.id}/horses`, R.token, { horseId: unapproved, riderId: rider });
    assert.equal(no.status, 422);
    assert.ok(codes(no).includes('ARENA_UNSUITABLE'));
    const approved = await makeHorse([ride.arenaId]);
    const yes = await post(`/schedule/${ride.id}/horses`, R.token, { horseId: approved, riderId: rider });
    assert.equal(yes.status, 201, yes.text);
  });

  test('closing a ride for weather cancels every booking, gives the horses back and tells the truth about why', async () => {
    const t = await makeType();
    const ride = await scheduleRide(t, { hour: 8 });
    const held = await customer();
    const heldBooking = await book(held.token, ride.id, held.riderId);
    const paidRider = await readyRider();
    const paidBooking = await directBooking({ occurrenceId: ride.id, riderId: paidRider });
    const horse = await makeHorse([ride.arenaId]);
    assert.equal((await post(`/schedule/${ride.id}/horses`, R.token, { horseId: horse, riderId: paidRider })).status, 201);

    const body = { reason: 'Storm on the coast', cause: 'weather' };
    assert.equal((await post(`/schedule/${ride.id}/cancel`, undefined, body)).status, 401);
    assert.equal((await post(`/schedule/${ride.id}/cancel`, held.token, body)).status, 403);
    assert.equal((await post(`/schedule/${ride.id}/cancel`, R.token, body)).status, 403);
    assert.equal((await post(`/schedule/${ride.id}/cancel`, M.token, { cause: 'weather' })).status, 400, 'a reason is required');
    assert.equal((await occurrence(ride.id)).status, 'published', 'refused requests changed nothing');

    const done = await post(`/schedule/${ride.id}/cancel`, M.token, body);
    assert.equal(done.status, 201, done.text);
    assert.equal(done.body.bookingsCancelled, 2);
    assert.equal(await statusOf(heldBooking.body.id), 'cancelled');
    assert.equal(await statusOf(paidBooking), 'cancelled');
    const causes = (await ctx.admin.query(`SELECT DISTINCT cancel_cause, consumed_class FROM bookings WHERE occurrence_id = $1`, [ride.id])).rows;
    assert.deepEqual(causes, [{ cancel_cause: 'weather', consumed_class: false }]);
    assert.equal((await occurrence(ride.id)).status, 'cancelled');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM horse_assignments WHERE occurrence_id = $1`, [ride.id])).rows[0].n, 0);
    assert.equal((await post(`/schedule/${ride.id}/cancel`, M.token, body)).status, 409, 'a cancelled ride cannot be cancelled again');

    // The horse is free again for another ride at the same time.
    const other = await scheduleRide(t, { hour: 8 });
    await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [horse, other.arenaId]);
    const otherRider = await readyRider();
    await directBooking({ occurrenceId: other.id, riderId: otherRider });
    assert.equal((await post(`/schedule/${other.id}/horses`, R.token, { horseId: horse, riderId: otherRider })).status, 201);
  });
});

describe('the rides report', () => {
  test('counts rides, places, bookings and no-shows by type, ignores classes, and counts cancelled rides separately', async () => {
    const rday = randomDay();
    const name = uniq('Report ride');
    const t = await makeType({ name, capacity: 4, price: 11500 });
    const ride = await rideId(t, { day: rday, hour: 9 });
    const [a, b, c] = [await readyRider(), await readyRider(), await readyRider()];
    await directBooking({ occurrenceId: ride, riderId: a });
    await directBooking({ occurrenceId: ride, riderId: b });
    await directBooking({ occurrenceId: ride, riderId: c, status: 'no_show' });
    await makeClass({ startsAt: rday + 14 * HOUR }); // a class on the same day must not appear
    const storm = await rideId(t, { day: rday, hour: 12 });
    assert.equal((await post(`/schedule/${storm}/cancel`, M.token, { reason: 'Storm', cause: 'weather' })).status, 201);

    const q = `/reports/rides?from=${encodeURIComponent(at(rday, 0))}&to=${encodeURIComponent(at(rday, 24))}`;
    const r = await get(q, M.token);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.rides, r.body.cancelledRides, r.body.places, r.body.booked, r.body.noShows, r.body.utilisation], [1, 1, 4, 2, 1, 0.5]);
    assert.equal(r.body.byType.length, 1);
    assert.deepEqual([r.body.byType[0].name, r.body.byType[0].rides, r.body.byType[0].booked], [name, 1, 2]);
  });

  test('money taken for rides is counted by the day the receipt was issued', async () => {
    const t = await makeType({ price: 11500 });
    const ride = await rideId(t);
    const c = await customer();
    const b = await book(c.token, ride, c.riderId);
    const today = `/reports/rides?from=${encodeURIComponent(new Date(Date.now() - DAY).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + DAY).toISOString())}`;
    const before = (await get(today, M.token)).body;
    assert.equal((await post(`/bookings/${b.body.id}/payment`, R.token, { method: 'cash', amountMinor: 11500 })).status, 201);
    const after = (await get(today, M.token)).body;
    assert.deepEqual([after.receipts - before.receipts, after.grossMinor - before.grossMinor, after.vatMinor - before.vatMinor], [1, 11500, 1500]);
    assert.equal(after.netMinor - before.netMinor, 11500);
  });

  test('managers and owners only; own branch only; the range is checked; an empty branch reports zeros', async () => {
    const q = `/reports/rides?from=${encodeURIComponent(at(day, 0))}&to=${encodeURIComponent(at(day, 24))}`;
    assert.equal((await get(q)).status, 401);
    for (const who of [R, await staff('coach'), await customer()]) assert.equal((await get(q, who.token)).status, 403);
    assert.equal((await get(q, O.token)).status, 200);
    const ob = await makeBranch();
    const om = await staff('manager', [ob]);
    assert.equal((await get(`${q}&branchId=${BRANCH}`, om.token)).status, 403);
    const empty = await get(q, om.token);
    assert.equal(empty.status, 200);
    assert.deepEqual([empty.body.rides, empty.body.places, empty.body.utilisation, empty.body.grossMinor, empty.body.byType], [0, 0, null, 0, []]);
    assert.equal((await get(`/reports/rides?from=${encodeURIComponent(at(day, 24))}&to=${encodeURIComponent(at(day, 0))}`, M.token)).status, 400);
    assert.equal((await get(`/reports/rides?from=${encodeURIComponent(at(day, 0))}&to=${encodeURIComponent(at(day + 400 * DAY, 0))}`, M.token)).status, 400);
    assert.equal((await get('/reports/rides', M.token)).status, 400);
  });
});
