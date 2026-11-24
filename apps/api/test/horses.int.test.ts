import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BRANCH, ctx, makeArena, makeBranch, randomDay, startApp, stopApp, tokenFor, makeAccount } from './helpers.ts';
import { codes, DAY, HOUR, makeClass, readyRider } from './booking-helpers.ts';
import { auditActions, directBooking, post, staff } from './flow-helpers.ts';

before(startApp);
after(stopApp);

const get = (path: string, token?: string) => api('GET', path, { token });
const patch = (path: string, token: string | undefined, body: unknown) => api('PATCH', path, { token, body });
const del = (path: string, token?: string) => api('DELETE', path, { token });
let n = 0;
const uniq = (p: string) => `${p} ${Date.now()}-${n++}`;

/** A horse written straight to the database, approved for the given arenas. */
async function makeHorse(o: { branchId?: string; status?: string; levels?: string[]; arenaIds?: string[]; name?: string } = {}): Promise<string> {
  const id: string = (
    await ctx.admin.query(`INSERT INTO horses (branch_id, name, status, suitable_levels) VALUES ($1,$2,$3,$4::level[]) RETURNING id`, [
      o.branchId ?? BRANCH, o.name ?? uniq('Horse'), o.status ?? 'available', o.levels ?? ['beginner', 'intermediate', 'advanced'],
    ])
  ).rows[0].id;
  for (const a of o.arenaIds ?? []) await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [id, a]);
  return id;
}
const arenaOf = async (occurrenceId: string): Promise<string> => (await ctx.admin.query(`SELECT arena_id FROM occurrences WHERE id = $1`, [occurrenceId])).rows[0].arena_id;
/** A class and a rider booked into it, so a horse can be given to that rider. */
async function classWithRider(startsAt: number, o: { level?: string; hours?: number } = {}) {
  const occurrenceId = await makeClass({ startsAt, hours: o.hours });
  const riderId = await readyRider({ level: o.level });
  await directBooking({ occurrenceId, riderId });
  return { occurrenceId, riderId, arenaId: await arenaOf(occurrenceId) };
}
async function approvedHorse(arenaId: string, o: { status?: string; levels?: string[] } = {}) {
  return makeHorse({ arenaIds: [arenaId], status: o.status, levels: o.levels });
}
const assignmentCount = async (horseId: string): Promise<number> => Number((await ctx.admin.query(`SELECT count(*)::int AS n FROM horse_assignments WHERE horse_id = $1`, [horseId])).rows[0].n);

describe('horse list, create and edit', () => {
  test('no token is refused; customers cannot see horses; only managers create or edit', async () => {
    assert.equal((await get('/horses')).status, 401);
    assert.equal((await post('/horses', undefined, {})).status, 401);
    const customerAcct = await makeAccount({ role: 'customer', branchIds: [BRANCH] });
    assert.equal((await get('/horses', await tokenFor(customerAcct))).status, 403);
    const hand = await staff('stable_hand');
    const reception = await staff('reception');
    assert.equal((await get('/horses', hand.token)).status, 200);
    assert.equal((await post('/horses', hand.token, { name: uniq('H'), suitableLevels: ['beginner'] })).status, 403);
    assert.equal((await post('/horses', reception.token, { name: uniq('H'), suitableLevels: ['beginner'] })).status, 403);
    const id = await makeHorse();
    assert.equal((await patch(`/horses/${id}`, hand.token, { notes: 'x' })).status, 403);
  });

  test('a manager creates a horse with arenas; the same name is refused whatever the capital letters', async () => {
    const manager = await staff('manager');
    const arena = await makeArena();
    const name = uniq('Sultan');
    const res = await post('/horses', manager.token, { name, suitableLevels: ['beginner', 'advanced'], arenaIds: [arena], notes: 'Calm' });
    assert.equal(res.status, 201);
    const got = await get(`/horses/${res.body.id}`, manager.token);
    assert.equal(got.status, 200);
    assert.equal(got.body.name, name);
    assert.deepEqual(got.body.arenaIds, [arena]);
    assert.deepEqual([...got.body.suitableLevels].sort(), ['advanced', 'beginner']);
    assert.equal(got.body.status, 'available');
    assert.equal((await post('/horses', manager.token, { name: name.toUpperCase(), suitableLevels: ['beginner'] })).status, 409);
    assert.deepEqual(await auditActions(res.body.id), ['horse.create']);
  });

  test('bad input is refused with 400', async () => {
    const manager = await staff('manager');
    for (const body of [
      {}, { name: '', suitableLevels: ['beginner'] }, { name: 'X', suitableLevels: [] }, { name: 'X', suitableLevels: ['wizard'] },
      { name: 'X', suitableLevels: ['beginner', 'beginner'] }, { name: 'X'.repeat(500), suitableLevels: ['beginner'] },
      { name: 'X', suitableLevels: ['beginner'], arenaIds: ['nope'] },
    ]) assert.equal((await post('/horses', manager.token, body)).status, 400, JSON.stringify(body).slice(0, 80));
  });

  test('an arena from another branch is refused', async () => {
    const manager = await staff('manager');
    const foreignArena = await makeArena(await makeBranch());
    const res = await post('/horses', manager.token, { name: uniq('H'), suitableLevels: ['beginner'], arenaIds: [foreignArena] });
    assert.equal(res.status, 422);
    assert.ok(codes(res).includes('ARENA_NOT_IN_BRANCH'));
  });

  test('another branch cannot see or change a horse; its list is its own', async () => {
    const id = await makeHorse({ name: uniq('Private') });
    const otherBranch = await makeBranch();
    const other = await staff('manager', [otherBranch]);
    assert.equal((await get(`/horses/${id}`, other.token)).status, 404);
    assert.equal((await patch(`/horses/${id}`, other.token, { notes: 'x' })).status, 404);
    assert.equal((await post(`/horses/${id}/status`, other.token, { status: 'resting', reason: 'x' })).status, 404);
    const mine = await get('/horses', other.token);
    assert.equal(mine.status, 200);
    assert.ok(!mine.body.horses.some((h: any) => h.id === id));
  });

  test('list filters by status and by name, and treats % as a letter', async () => {
    const manager = await staff('manager');
    const marker = uniq('Zq');
    const a = await makeHorse({ name: `${marker} one` });
    const b = await makeHorse({ name: `${marker} two`, status: 'resting' });
    const byName = await get(`/horses?q=${encodeURIComponent(marker)}`, manager.token);
    assert.deepEqual(byName.body.horses.map((h: any) => h.id).sort(), [a, b].sort());
    const resting = await get(`/horses?q=${encodeURIComponent(marker)}&status=resting`, manager.token);
    assert.deepEqual(resting.body.horses.map((h: any) => h.id), [b]);
    assert.equal((await get('/horses?q=%25', manager.token)).body.horses.length, 0);
    assert.equal((await get('/horses?status=flying', manager.token)).status, 400);
  });

  test('editing changes only what is sent, replaces arenas, and refuses an empty change', async () => {
    const manager = await staff('manager');
    const a1 = await makeArena();
    const a2 = await makeArena();
    const id = await makeHorse({ arenaIds: [a1], levels: ['beginner'] });
    assert.equal((await patch(`/horses/${id}`, manager.token, {})).status, 400);
    const res = await patch(`/horses/${id}`, manager.token, { arenaIds: [a2], notes: 'Sensitive to noise' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.arenaIds, [a2]);
    assert.equal(res.body.notes, 'Sensitive to noise');
    assert.deepEqual(res.body.suitableLevels, ['beginner']);
    const dup = await makeHorse({ name: uniq('Taken') });
    const name = (await ctx.admin.query(`SELECT name FROM horses WHERE id = $1`, [dup])).rows[0].name;
    assert.equal((await patch(`/horses/${id}`, manager.token, { name })).status, 409);
    assert.equal((await patch(`/horses/${id}`, manager.token, { arenaIds: [await makeArena(await makeBranch())] })).status, 422);
  });
});

describe('horse status', () => {
  test('the stable hand sets a status with a reason; the same status twice is refused; a reason is needed', async () => {
    const hand = await staff('stable_hand');
    const id = await makeHorse();
    assert.equal((await post(`/horses/${id}/status`, hand.token, { status: 'injured' })).status, 400);
    const ok = await post(`/horses/${id}/status`, hand.token, { status: 'injured', reason: 'Lame in the near fore' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.status, 'injured');
    assert.equal((await post(`/horses/${id}/status`, hand.token, { status: 'injured', reason: 'again' })).status, 409);
    assert.equal((await post(`/horses/${id}/status`, hand.token, { status: 'available' })).status, 201);
    assert.equal((await post(`/horses/${id}/status`, hand.token, { status: 'flying', reason: 'x' })).status, 400);
    assert.deepEqual(await auditActions(id), ['horse.status', 'horse.status']);
  });

  test('coaches and reception cannot change status; only managers retire, and a retired horse is final', async () => {
    const id = await makeHorse();
    for (const role of ['coach', 'reception']) assert.equal((await post(`/horses/${id}/status`, (await staff(role)).token, { status: 'resting', reason: 'x' })).status, 403);
    assert.equal((await post(`/horses/${id}/status`, (await staff('stable_hand')).token, { status: 'retired', reason: 'old' })).status, 403);
    const manager = await staff('manager');
    assert.equal((await post(`/horses/${id}/status`, manager.token, { status: 'retired', reason: 'Retired after 20 years' })).status, 201);
    const again = await post(`/horses/${id}/status`, manager.token, { status: 'available' });
    assert.equal(again.status, 409);
    assert.ok(codes(again).includes('HORSE_RETIRED'));
    assert.equal((await patch(`/horses/${id}`, manager.token, { notes: 'x' })).status, 409);
  });

  test('making a horse unfit lists the classes it was planned for, and does not remove them', async () => {
    const hand = await staff('stable_hand');
    const manager = await staff('manager');
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR);
    const horse = await approvedHorse(arenaId);
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, manager.token, { horseId: horse, riderId })).status, 201);
    const res = await post(`/horses/${horse}/status`, hand.token, { status: 'medical_hold', reason: 'Vet check' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.affectedClasses.map((c: any) => c.occurrenceId), [occurrenceId]);
    assert.equal(await assignmentCount(horse), 1);
    const back = await post(`/horses/${horse}/status`, hand.token, { status: 'available' });
    assert.deepEqual(back.body.affectedClasses, []);
  });
});

describe('workload view', () => {
  test('shows a horse sessions per day; bad ranges are refused', async () => {
    const manager = await staff('manager');
    const day = randomDay();
    const first = await classWithRider(day + 8 * HOUR);
    const horse = await approvedHorse(first.arenaId);
    const second = await classWithRider(day + 11 * HOUR);
    await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [horse, second.arenaId]);
    for (const c of [first, second]) assert.equal((await post(`/schedule/${c.occurrenceId}/horses`, manager.token, { horseId: horse, riderId: c.riderId })).status, 201);
    const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
    const res = await get(`/horses/${horse}/workload?from=${iso(day)}&to=${iso(day + DAY)}`, manager.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.deepEqual(Object.values(res.body.perDay), [2]);
    assert.equal((await get(`/horses/${horse}/workload?from=${iso(day + DAY)}&to=${iso(day)}`, manager.token)).status, 400);
    assert.equal((await get(`/horses/${horse}/workload?from=${iso(day)}&to=${iso(day + 400 * DAY)}`, manager.token)).status, 400);
    assert.equal((await get(`/horses/${horse}/workload?from=nope&to=nope`, manager.token)).status, 400);
    assert.equal((await get(`/horses/${horse}/workload?from=${iso(day)}&to=${iso(day + DAY)}`, (await staff('manager', [await makeBranch()])).token)).status, 404);
  });
});

describe('giving a horse to a class', () => {
  test('no token, customers, and stable hands cannot plan; a coach sees only their own class', async () => {
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR);
    const horse = await approvedHorse(arenaId);
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, undefined, { horseId: horse, riderId })).status, 401);
    const customerAcct = await makeAccount({ role: 'customer', branchIds: [BRANCH] });
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, await tokenFor(customerAcct), { horseId: horse, riderId })).status, 403);
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, (await staff('stable_hand')).token, { horseId: horse, riderId })).status, 403);
    const strangerCoach = await staff('coach');
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, strangerCoach.token, { horseId: horse, riderId })).status, 404);
    const ownerCoachId = (await ctx.admin.query(`SELECT coach_id FROM occurrences WHERE id = $1`, [occurrenceId])).rows[0].coach_id;
    const ownerCoachAcct = (await ctx.admin.query(`SELECT email FROM accounts WHERE id = $1`, [ownerCoachId])).rows[0];
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, await tokenFor(ownerCoachAcct), { horseId: horse, riderId })).status, 201);
  });

  test('another branch cannot plan this class', async () => {
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR);
    const horse = await approvedHorse(arenaId);
    const other = await staff('manager', [await makeBranch()]);
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, other.token, { horseId: horse, riderId })).status, 404);
    assert.equal((await get(`/schedule/${occurrenceId}/horses`, other.token)).status, 404);
  });

  test('a suitable horse is assigned, listed, audited and can be removed', async () => {
    const reception = await staff('reception');
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR);
    const horse = await approvedHorse(arenaId);
    const res = await post(`/schedule/${occurrenceId}/horses`, reception.token, { horseId: horse, riderId });
    assert.equal(res.status, 201);
    assert.equal(res.body.overridden, false);
    const list = await get(`/schedule/${occurrenceId}/horses`, reception.token);
    assert.deepEqual(list.body.assignments.map((a: any) => [a.horseId, a.riderId]), [[horse, riderId]]);
    assert.deepEqual(await auditActions(res.body.id), ['horse.assign']);
    const gone = await del(`/schedule/${occurrenceId}/horses/${res.body.id}`, reception.token);
    assert.equal(gone.status, 200);
    assert.equal(await assignmentCount(horse), 0);
    assert.equal((await del(`/schedule/${occurrenceId}/horses/${res.body.id}`, reception.token)).status, 404);
    assert.deepEqual(await auditActions(res.body.id), ['horse.assign', 'horse.unassign']);
  });

  test('bad input and unknown things are refused', async () => {
    const reception = await staff('reception');
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR);
    const horse = await approvedHorse(arenaId);
    const path = `/schedule/${occurrenceId}/horses`;
    assert.equal((await post(path, reception.token, {})).status, 400);
    assert.equal((await post(path, reception.token, { horseId: 'nope' })).status, 400);
    assert.equal((await post(path, reception.token, { horseId: horse, override: { reason: '' } })).status, 400);
    assert.equal((await post('/schedule/not-an-id/horses', reception.token, { horseId: horse })).status, 400);
    assert.equal((await post(`/schedule/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/horses`, reception.token, { horseId: horse })).status, 404);
    assert.equal((await post(path, reception.token, { horseId: `${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, riderId })).status, 404);
  });

  test('the rider must be booked into the class, and a booking that was cancelled does not count', async () => {
    const reception = await staff('reception');
    const { occurrenceId, arenaId } = await classWithRider(randomDay() + 8 * HOUR);
    const horse = await approvedHorse(arenaId);
    const stranger = await readyRider();
    const res = await post(`/schedule/${occurrenceId}/horses`, reception.token, { horseId: horse, riderId: stranger });
    assert.equal(res.status, 422);
    assert.ok(codes(res).includes('RIDER_NOT_IN_CLASS'));
    const cancelled = await readyRider();
    await directBooking({ occurrenceId, riderId: cancelled, status: 'cancelled' });
    assert.ok(codes(await post(`/schedule/${occurrenceId}/horses`, reception.token, { horseId: horse, riderId: cancelled })).includes('RIDER_NOT_IN_CLASS'));
  });

  test('a rider has one horse; a horse carries one rider at a time', async () => {
    const reception = await staff('reception');
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR);
    const h1 = await approvedHorse(arenaId);
    const h2 = await approvedHorse(arenaId);
    const path = `/schedule/${occurrenceId}/horses`;
    assert.equal((await post(path, reception.token, { horseId: h1, riderId })).status, 201);
    const second = await post(path, reception.token, { horseId: h2, riderId });
    assert.equal(second.status, 409);
    assert.ok(codes(second).includes('RIDER_HAS_HORSE'));
    const other = await readyRider();
    await directBooking({ occurrenceId, riderId: other });
    const busy = await post(path, reception.token, { horseId: h1, riderId: other });
    assert.equal(busy.status, 409);
    assert.ok(codes(busy).includes('HORSE_BUSY'));
  });

  test('two people giving the same horse at the same moment: exactly one wins', async () => {
    const reception = await staff('reception');
    const a = await classWithRider(randomDay() + 8 * HOUR);
    const horse = await approvedHorse(a.arenaId);
    const b = await classWithRider(Date.parse(new Date(randomDay() + 8 * HOUR).toISOString()));
    await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [horse, b.arenaId]);
    // Move class b onto exactly the same hours as class a.
    await ctx.admin.query(`UPDATE occurrences SET during = (SELECT during FROM occurrences WHERE id = $1) WHERE id = $2`, [a.occurrenceId, b.occurrenceId]);
    const results = await Promise.all([
      post(`/schedule/${a.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: a.riderId }),
      post(`/schedule/${b.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: b.riderId }),
    ]);
    // The horse row is locked, so the second request waits, then sees the first and is refused by the rules (422); the database exclusion is only the backstop (409).
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses[0], 201);
    assert.ok([409, 422].includes(statuses[1]), `second request got ${statuses[1]}`);
    assert.equal(await assignmentCount(horse), 1);
  });

  test('safety rules: unavailable horse, wrong arena, wrong level are refused and cannot be overridden', async () => {
    const manager = await staff('manager');
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR, { level: 'beginner' });
    const path = `/schedule/${occurrenceId}/horses`;
    const injured = await approvedHorse(arenaId, { status: 'injured' });
    const wrongArena = await makeHorse({ arenaIds: [await makeArena()] });
    const wrongLevel = await approvedHorse(arenaId, { levels: ['advanced'] });
    for (const [horse, code] of [[injured, 'HORSE_UNAVAILABLE'], [wrongArena, 'ARENA_UNSUITABLE'], [wrongLevel, 'LEVEL_UNSUITABLE']] as const) {
      const plain = await post(path, manager.token, { horseId: horse, riderId });
      assert.equal(plain.status, 422);
      assert.ok(codes(plain).includes(code), code);
      const forced = await post(path, manager.token, { horseId: horse, riderId, override: { reason: 'I know best' } });
      assert.equal(forced.status, 422, `${code} must not be overridable`);
      assert.ok(forced.body.problems.every((p: any) => p.notOverridable));
      assert.equal(await assignmentCount(horse), 0);
    }
  });

  test('rest gap, daily limit and weekly limit refuse; a manager may override them with a reason, nobody else', async () => {
    const reception = await staff('reception');
    const manager = await staff('manager');
    // Day with 3 sessions already, a 4th the same day breaks the daily limit.
    const day = randomDay();
    const first = await classWithRider(day + 5 * HOUR);
    const horse = await approvedHorse(first.arenaId);
    const planned = [first];
    for (const hour of [7, 9]) {
      const c = await classWithRider(day + hour * HOUR);
      await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [horse, c.arenaId]);
      planned.push(c);
    }
    for (const c of planned) assert.equal((await post(`/schedule/${c.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: c.riderId })).status, 201);
    const fourth = await classWithRider(day + 11 * HOUR);
    await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [horse, fourth.arenaId]);
    const refused = await post(`/schedule/${fourth.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: fourth.riderId });
    assert.equal(refused.status, 422);
    assert.ok(codes(refused).includes('HORSE_DAILY_LIMIT'));
    const noReason = await post(`/schedule/${fourth.occurrenceId}/horses`, manager.token, { horseId: horse, riderId: fourth.riderId, override: {} });
    assert.equal(noReason.status, 400);
    const byReception = await post(`/schedule/${fourth.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: fourth.riderId, override: { reason: 'busy day' } });
    assert.equal(byReception.status, 403);
    assert.equal(await assignmentCount(horse), 3);
    const forced = await post(`/schedule/${fourth.occurrenceId}/horses`, manager.token, { horseId: horse, riderId: fourth.riderId, override: { reason: 'Show preparation' } });
    assert.equal(forced.status, 201);
    assert.equal(forced.body.overridden, true);
    assert.ok(forced.body.problems.some((p: any) => p.code === 'HORSE_DAILY_LIMIT'));
    assert.deepEqual(await auditActions(forced.body.id), ['horse.assign_override']);
    const detail = (await ctx.admin.query(`SELECT detail FROM audit_log WHERE entity_id = $1`, [forced.body.id])).rows[0].detail;
    assert.equal(detail.reason, 'Show preparation');
  });

  test('a class that starts less than an hour after the horse finishes breaks the rest gap', async () => {
    const reception = await staff('reception');
    const day = randomDay();
    const early = await classWithRider(day + 8 * HOUR);
    const horse = await approvedHorse(early.arenaId);
    assert.equal((await post(`/schedule/${early.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: early.riderId })).status, 201);
    const tight = await classWithRider(day + 9.5 * HOUR);
    await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [horse, tight.arenaId]);
    const res = await post(`/schedule/${tight.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: tight.riderId });
    assert.equal(res.status, 422);
    assert.deepEqual(codes(res), ['HORSE_REST_GAP']);
    const fine = await classWithRider(day + 11 * HOUR);
    await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [horse, fine.arenaId]);
    assert.equal((await post(`/schedule/${fine.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: fine.riderId })).status, 201);
  });

  test('the weekly limit refuses a 16th session in a club week', async () => {
    const reception = await staff('reception');
    const week = 7 * DAY;
    const weekStart = Math.floor((randomDay() - 2 * DAY) / week) * week + 2 * DAY;
    const horse = await makeHorse();
    const make = async (dayOffset: number, hour: number) => {
      const c = await classWithRider(weekStart + dayOffset * DAY + hour * HOUR);
      await ctx.admin.query(`INSERT INTO horse_arenas (horse_id, arena_id) VALUES ($1,$2)`, [horse, c.arenaId]);
      return c;
    };
    for (let d = 0; d < 5; d++) for (const h of [5, 7, 9]) {
      const c = await make(d, h);
      await ctx.admin.query(`INSERT INTO horse_assignments (occurrence_id, horse_id, rider_id, during) SELECT id, $2, $3, during FROM occurrences WHERE id = $1`, [c.occurrenceId, horse, c.riderId]);
    }
    const sixteenth = await make(5, 8);
    const res = await post(`/schedule/${sixteenth.occurrenceId}/horses`, reception.token, { horseId: horse, riderId: sixteenth.riderId });
    assert.equal(res.status, 422);
    assert.deepEqual(codes(res), ['HORSE_WEEKLY_LIMIT']);
  });

  test('a finished, cancelled or already started class cannot be changed', async () => {
    const reception = await staff('reception');
    for (const status of ['completed', 'cancelled', 'draft']) {
      const occurrenceId = await makeClass({ startsAt: randomDay() + 8 * HOUR, status });
      const riderId = await readyRider();
      await directBooking({ occurrenceId, riderId });
      const horse = await approvedHorse(await arenaOf(occurrenceId));
      const res = await post(`/schedule/${occurrenceId}/horses`, reception.token, { horseId: horse, riderId });
      assert.equal(res.status, 409, status);
      assert.ok(codes(res).includes('CLASS_CLOSED'));
    }
    const started = await makeClass({ startsAt: Date.now() - 2 * HOUR, hours: 1 });
    const riderId = await readyRider();
    await directBooking({ occurrenceId: started, riderId });
    const horse = await approvedHorse(await arenaOf(started));
    assert.ok(codes(await post(`/schedule/${started}/horses`, reception.token, { horseId: horse, riderId })).includes('CLASS_CLOSED'));
  });

  test('a horse can be given to the class without naming a rider (checked against every rider in it)', async () => {
    const reception = await staff('reception');
    const { occurrenceId, arenaId } = await classWithRider(randomDay() + 8 * HOUR, { level: 'beginner' });
    const strong = await approvedHorse(arenaId, { levels: ['advanced'] });
    assert.ok(codes(await post(`/schedule/${occurrenceId}/horses`, reception.token, { horseId: strong })).includes('LEVEL_UNSUITABLE'));
    const ok = await approvedHorse(arenaId);
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, reception.token, { horseId: ok })).status, 201);
  });

  test('cancelling the class frees its horses', async () => {
    const manager = await staff('manager');
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR);
    const horse = await approvedHorse(arenaId);
    assert.equal((await post(`/schedule/${occurrenceId}/horses`, manager.token, { horseId: horse, riderId })).status, 201);
    const cancelled = await post(`/schedule/${occurrenceId}/cancel`, manager.token, { reason: 'Storm' });
    assert.equal(cancelled.status, 201);
    assert.equal(await assignmentCount(horse), 0);
  });

  test('suggestions split horses into suitable and unsuitable, with reasons', async () => {
    const reception = await staff('reception');
    const { occurrenceId, riderId, arenaId } = await classWithRider(randomDay() + 8 * HOUR, { level: 'beginner' });
    const good = await approvedHorse(arenaId);
    const resting = await approvedHorse(arenaId, { status: 'resting' });
    const retired = await approvedHorse(arenaId, { status: 'retired' });
    const res = await get(`/schedule/${occurrenceId}/horses/suggestions?riderId=${riderId}`, reception.token);
    assert.equal(res.status, 200);
    assert.ok(res.body.suitable.some((h: any) => h.id === good));
    const rest = res.body.unsuitable.find((h: any) => h.id === resting);
    assert.ok(rest.problems.some((p: any) => p.code === 'HORSE_UNAVAILABLE'));
    assert.ok(![...res.body.suitable, ...res.body.unsuitable].some((h: any) => h.id === retired));
    assert.equal((await get(`/schedule/${occurrenceId}/horses/suggestions?riderId=${await readyRider()}`, reception.token)).status, 422);
    assert.equal((await get(`/schedule/${occurrenceId}/horses/suggestions`, undefined)).status, 401);
    assert.equal((await get(`/schedule/${occurrenceId}/horses/suggestions`, (await staff('stable_hand')).token)).status, 403);
  });
});
