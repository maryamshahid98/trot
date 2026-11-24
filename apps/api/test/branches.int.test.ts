import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, BRANCH, ctx, makeAccount, makeArena, makeBranch, randomDay, startApp, stopApp, tokenFor } from './helpers.ts';
import { codes, DAY, HOUR, makeClass } from './booking-helpers.ts';
import { auditActions, customer, post, staff } from './flow-helpers.ts';
import type { Json } from './helpers.ts';

before(startApp);
after(stopApp);

const get = (path: string, token?: string) => api('GET', path, { token });
const patch = (path: string, token: string | undefined, body: unknown) => api('PATCH', path, { token, body });
const del = (path: string, token?: string) => api('DELETE', path, { token });
let n = 0;
const uniq = (p: string) => `${p} ${Date.now()}-${n++}`;
const iso = (ms: number) => new Date(ms).toISOString();
const policyOf = async (branchId: string) => (await ctx.admin.query(`SELECT policy FROM branches WHERE id = $1`, [branchId])).rows[0].policy;

describe('branches', () => {
  test('no token is refused; a signed-in person sees only their own branches', async () => {
    assert.equal((await get('/branches')).status, 401);
    const other = await makeBranch();
    const coach = await staff('coach');
    const res = await get('/branches', coach.token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.branches.map((b: Json) => b.id), [BRANCH]);
    assert.equal((await get(`/branches/${other}`, coach.token)).status, 404);
    assert.equal((await get(`/branches/${BRANCH}`, coach.token)).status, 200);
    assert.equal((await get('/branches/not-an-id', coach.token)).status, 400);
    const cust = await customer();
    assert.equal((await get('/branches', cust.token)).status, 200);
  });

  test('a manager renames the branch and sets its time zone; others cannot', async () => {
    const branch = await makeBranch();
    const manager = await staff('manager', [branch]);
    const res = await patch(`/branches/${branch}`, manager.token, { name: 'Riyadh North', timeZone: 'Asia/Dubai' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Riyadh North');
    assert.equal(res.body.timeZone, 'Asia/Dubai');
    assert.deepEqual(await auditActions(branch), ['branch.update']);
    for (const bad of [{}, { name: '' }, { timeZone: 'Mars/Olympus' }, { name: 'x'.repeat(500) }]) assert.equal((await patch(`/branches/${branch}`, manager.token, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await patch(`/branches/${branch}`, (await staff('reception', [branch])).token, { name: 'X' })).status, 403);
    assert.equal((await patch(`/branches/${branch}`, (await staff('manager')).token, { name: 'X' })).status, 404);
  });
});

describe('branch rules (policy)', () => {
  test('a branch starts on the club defaults; changes show up, null puts one back', async () => {
    const branch = await makeBranch();
    const manager = await staff('manager', [branch]);
    const start = await get(`/branches/${branch}/policy`, manager.token);
    assert.equal(start.status, 200);
    assert.equal(start.body.policy.officeHoldMinutes, 10);
    const res = await patch(`/branches/${branch}/policy`, manager.token, { officeHoldMinutes: 30, requireWaiver: false, horseSelection: 'customer_chooses_with_approval' });
    assert.equal(res.status, 200);
    assert.equal(res.body.policy.officeHoldMinutes, 30);
    assert.equal(res.body.policy.requireWaiver, false);
    assert.equal(res.body.policy.freeCancelHoursBefore, 24);
    assert.equal((await get(`/branches/${branch}/policy`, manager.token)).body.policy.officeHoldMinutes, 30);
    const reset = await patch(`/branches/${branch}/policy`, manager.token, { officeHoldMinutes: null });
    assert.equal(reset.body.policy.officeHoldMinutes, 10);
    assert.equal((await policyOf(branch)).officeHoldMinutes, undefined);
    const detail = (await ctx.admin.query(`SELECT detail FROM audit_log WHERE entity_id = $1 AND action = 'branch.policy_update' ORDER BY id`, [branch])).rows;
    assert.deepEqual(detail[0].detail.changes.officeHoldMinutes, { from: 10, to: 30 });
  });

  test('unknown settings, out-of-range values and wrong types are refused', async () => {
    const branch = await makeBranch();
    const manager = await staff('manager', [branch]);
    for (const bad of [
      {}, { nonsense: 1 }, { officeHoldMinutes: 0 }, { officeHoldMinutes: 99999 }, { officeHoldMinutes: 1.5 }, { officeHoldMinutes: '30' }, { requireWaiver: 'yes' },
      { horseSelection: 'random' }, { freeCancelHoursBefore: -1 }, { maxBookingsPerRiderPerDay: 0 },
    ]) assert.equal((await patch(`/branches/${branch}/policy`, manager.token, bad)).status, 400, JSON.stringify(bad));
    assert.deepEqual(await policyOf(branch), {});
  });

  test('a weekly horse limit below the daily limit is refused', async () => {
    const branch = await makeBranch();
    const manager = await staff('manager', [branch]);
    const res = await patch(`/branches/${branch}/policy`, manager.token, { horseMaxSessionsPerDay: 5, horseMaxSessionsPerWeek: 3 });
    assert.equal(res.status, 422);
    assert.ok(codes(res).includes('POLICY_INCONSISTENT'));
    assert.deepEqual(await policyOf(branch), {});
  });

  test('only an owner may change the approval limit or the unpaid-confirmation rule', async () => {
    const branch = await makeBranch();
    const manager = await staff('manager', [branch]);
    const owner = await staff('owner', [branch]);
    for (const body of [{ adjustmentManagerThresholdMinor: 999999 }, { allowManagerUnpaidConfirmation: false }]) {
      const res = await patch(`/branches/${branch}/policy`, manager.token, body);
      assert.equal(res.status, 403);
      assert.ok(codes(res).includes('OWNER_ONLY_SETTING'));
      assert.equal((await patch(`/branches/${branch}/policy`, owner.token, body)).status, 200);
    }
  });

  test('roles and branches: coaches read, customers cannot, other branches are hidden', async () => {
    const branch = await makeBranch();
    assert.equal((await get(`/branches/${branch}/policy`)).status, 401);
    assert.equal((await get(`/branches/${branch}/policy`, (await staff('coach', [branch])).token)).status, 200);
    assert.equal((await patch(`/branches/${branch}/policy`, (await staff('coach', [branch])).token, { officeHoldMinutes: 5 })).status, 403);
    assert.equal((await get(`/branches/${branch}/policy`, (await customer({ branchId: branch })).token)).status, 403);
    assert.equal((await get(`/branches/${branch}/policy`, (await staff('manager')).token)).status, 404);
    assert.equal((await patch(`/branches/${branch}/policy`, (await staff('manager')).token, { officeHoldMinutes: 5 })).status, 404);
  });

  test('damaged saved data is ignored, so a rule can never switch off by accident', async () => {
    const branch = await makeBranch();
    await ctx.admin.query(`UPDATE branches SET policy = $2::jsonb WHERE id = $1`, [branch, JSON.stringify({ officeHoldMinutes: 'abc', requireWaiver: 'no', horseMaxSessionsPerDay: -4, freeCancelHoursBefore: 48, bogus: 1 })]);
    const res = await get(`/branches/${branch}/policy`, (await staff('manager', [branch])).token);
    assert.equal(res.body.policy.officeHoldMinutes, 10);
    assert.equal(res.body.policy.requireWaiver, true);
    assert.equal(res.body.policy.horseMaxSessionsPerDay, 3);
    assert.equal(res.body.policy.freeCancelHoursBefore, 48);
    assert.ok(!('bogus' in res.body.policy));
  });

  test('the booking rules really use the branch policy', async () => {
    const branch = await makeBranch();
    await ctx.admin.query(`UPDATE branches SET policy = $2::jsonb WHERE id = $1`, [branch, JSON.stringify({ maxBookingsPerRiderPerDay: 1 })]);
    const c = await customer({ branchId: branch });
    const day = randomDay();
    const book = async (h: number) => post('/bookings', c.token, { occurrenceId: await makeClass({ branchId: branch, startsAt: day + h * HOUR }), riderId: c.riderId, payWith: 'office' });
    assert.equal((await book(8)).status, 201);
    assert.deepEqual(codes(await book(11)), ['DAILY_LIMIT']);
  });
});

describe('arenas', () => {
  test('no token, customers and stable hands are refused; managers create; names are unique per branch', async () => {
    assert.equal((await get('/arenas')).status, 401);
    assert.equal((await get('/arenas', (await customer()).token)).status, 403);
    const manager = await staff('manager');
    const name = uniq('Arena');
    const res = await post('/arenas', manager.token, { name, maxCapacity: 8 });
    assert.equal(res.status, 201);
    assert.equal((await post('/arenas', manager.token, { name: name.toUpperCase(), maxCapacity: 4 })).status, 409);
    assert.equal((await post('/arenas', (await staff('reception')).token, { name: uniq('A'), maxCapacity: 4 })).status, 403);
    const list = await get('/arenas', (await staff('stable_hand')).token);
    assert.ok(list.body.arenas.some((a: Json) => a.id === res.body.id && a.maxCapacity === 8));
    for (const bad of [{}, { name: '', maxCapacity: 4 }, { name: 'A', maxCapacity: 0 }, { name: 'A', maxCapacity: 1000 }, { name: 'A', maxCapacity: 2.5 }, { name: 'A'.repeat(300), maxCapacity: 4 }]) {
      assert.equal((await post('/arenas', manager.token, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal((await post('/arenas', manager.token, { name: uniq('A'), maxCapacity: 4, branchId: await makeBranch() })).status, 403);
    assert.deepEqual(await auditActions(res.body.id), ['arena.create']);
  });

  test('another branch cannot see or change this arena', async () => {
    const arena = await makeArena();
    const other = await staff('manager', [await makeBranch()]);
    assert.ok(!(await get('/arenas', other.token)).body.arenas.some((a: Json) => a.id === arena));
    assert.equal((await patch(`/arenas/${arena}`, other.token, { name: 'X' })).status, 404);
    assert.equal((await get(`/arenas/${arena}/closures`, other.token)).status, 404);
    assert.equal((await post(`/arenas/${arena}/closures`, other.token, { from: iso(Date.now() + DAY), to: iso(Date.now() + 2 * DAY), reason: 'x' })).status, 404);
  });

  test('renaming and resizing work; shrinking below a class ahead is refused', async () => {
    const manager = await staff('manager');
    const classId = await makeClass({ startsAt: randomDay() + 8 * HOUR, capacity: 6 });
    const arena = (await ctx.admin.query(`SELECT arena_id FROM occurrences WHERE id = $1`, [classId])).rows[0].arena_id;
    assert.equal((await patch(`/arenas/${arena}`, manager.token, {})).status, 400);
    const blocked = await patch(`/arenas/${arena}`, manager.token, { maxCapacity: 4 });
    assert.equal(blocked.status, 409);
    assert.ok(codes(blocked).includes('ARENA_HAS_CLASSES'));
    assert.equal((await patch(`/arenas/${arena}`, manager.token, { maxCapacity: 12, name: uniq('Main') })).status, 200);
    const taken = await ctx.admin.query(`SELECT name FROM arenas WHERE id <> $1 AND branch_id = $2 LIMIT 1`, [arena, BRANCH]);
    assert.equal((await patch(`/arenas/${arena}`, manager.token, { name: taken.rows[0].name.toUpperCase() })).status, 409);
  });

  test('closures: created, listed, removed; overlapping classes, bad ranges and past dates are refused', async () => {
    const manager = await staff('manager');
    const arena = await makeArena();
    const day = randomDay();
    const created = await post(`/arenas/${arena}/closures`, manager.token, { from: iso(day), to: iso(day + 2 * DAY), reason: 'Resurfacing' });
    assert.equal(created.status, 201);
    const list = await get(`/arenas/${arena}/closures`, (await staff('reception')).token);
    assert.deepEqual(list.body.closures.map((c: Json) => [c.id, c.reason]), [[created.body.id, 'Resurfacing']]);
    const classId = await makeClass({ startsAt: day + 5 * DAY, arenaId: arena });
    const clash = await post(`/arenas/${arena}/closures`, manager.token, { from: iso(day + 5 * DAY), to: iso(day + 6 * DAY), reason: 'Painting' });
    assert.equal(clash.status, 409);
    assert.ok(codes(clash).includes('ARENA_HAS_CLASSES'));
    assert.deepEqual(clash.body.classes.map((c: Json) => c.id), [classId]);
    const noReason = await post(`/arenas/${arena}/closures`, manager.token, { from: iso(day + 9 * DAY), to: iso(day + 10 * DAY) });
    assert.equal(noReason.status, 400);
    assert.equal((await post(`/arenas/${arena}/closures`, manager.token, { from: iso(day + 3 * DAY), to: iso(day + 2 * DAY), reason: 'x' })).status, 400);
    assert.equal((await post(`/arenas/${arena}/closures`, manager.token, { from: iso(day), to: iso(day + 500 * DAY), reason: 'x' })).status, 400);
    assert.equal((await post(`/arenas/${arena}/closures`, manager.token, { from: 'nope', to: 'nope', reason: 'x' })).status, 400);
    const past = await post(`/arenas/${arena}/closures`, manager.token, { from: iso(Date.now() - 3 * DAY), to: iso(Date.now() - DAY), reason: 'x' });
    assert.equal(past.status, 422);
    assert.equal((await post(`/arenas/${arena}/closures`, (await staff('reception')).token, { from: iso(day), to: iso(day + DAY), reason: 'x' })).status, 403);
    assert.equal((await del(`/arenas/${arena}/closures/${created.body.id}`, manager.token)).status, 200);
    assert.equal((await del(`/arenas/${arena}/closures/${created.body.id}`, manager.token)).status, 404);
    assert.deepEqual((await auditActions(created.body.id)), ['arena.closure_create', 'arena.closure_delete']);
  });

  test('a cancelled class does not stop a closure', async () => {
    const manager = await staff('manager');
    const arena = await makeArena();
    const day = randomDay();
    await makeClass({ startsAt: day + 8 * HOUR, arenaId: arena, status: 'cancelled' });
    assert.equal((await post(`/arenas/${arena}/closures`, manager.token, { from: iso(day), to: iso(day + DAY), reason: 'Repairs' })).status, 201);
  });
});

describe('staff leave', () => {
  const window = () => { const day = randomDay(); return { day, from: iso(day), to: iso(day + 2 * DAY) }; };

  test('no token, customers refused; a coach asks for leave for themselves and it waits for approval', async () => {
    assert.equal((await post('/staff-leave', undefined, window())).status, 401);
    assert.equal((await post('/staff-leave', (await customer()).token, window())).status, 403);
    const coach = await staff('coach');
    const manager = await staff('manager');
    const w = window();
    const asked = await post('/staff-leave', coach.token, { from: w.from, to: w.to, reason: 'Family' });
    assert.equal(asked.status, 201);
    assert.equal(asked.body.status, 'requested');
    assert.equal((await post(`/staff-leave/${asked.body.id}/decision`, coach.token, { decision: 'approve' })).status, 403);
    assert.equal((await post(`/staff-leave/${asked.body.id}/decision`, manager.token, { decision: 'reject' })).status, 400);
    assert.equal((await post(`/staff-leave/${asked.body.id}/decision`, manager.token, { decision: 'approve' })).status, 201);
    assert.equal((await post(`/staff-leave/${asked.body.id}/decision`, manager.token, { decision: 'approve' })).status, 409);
    const row = (await ctx.admin.query(`SELECT status FROM staff_unavailability WHERE id = $1`, [asked.body.id])).rows[0];
    assert.equal(row.status, 'approved');
    assert.deepEqual(await auditActions(asked.body.id), ['leave.create', 'leave.decide']);
  });

  test('rejecting needs a reason and records it', async () => {
    const coach = await staff('coach');
    const manager = await staff('manager');
    const w = window();
    const asked = await post('/staff-leave', coach.token, { from: w.from, to: w.to });
    const res = await post(`/staff-leave/${asked.body.id}/decision`, manager.token, { decision: 'reject', reason: 'Camp week' });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'rejected');
    assert.equal((await post(`/staff-leave/${asked.body.id}/decision`, manager.token, { decision: 'nope' })).status, 400);
  });

  test('a manager records leave for a coach (approved at once), but not for a peer; coaches cannot record for others', async () => {
    const manager = await staff('manager');
    const coach = await staff('coach');
    const other = await staff('coach');
    const w = window();
    const rec = await post('/staff-leave', manager.token, { staffId: coach.id, from: w.from, to: w.to, reason: 'Course' });
    assert.equal(rec.status, 201);
    assert.equal(rec.body.status, 'approved');
    assert.equal((await post('/staff-leave', manager.token, { staffId: (await staff('manager')).id, from: w.from, to: w.to })).status, 403);
    assert.equal((await post('/staff-leave', coach.token, { staffId: other.id, from: w.from, to: w.to })).status, 403);
    assert.equal((await post('/staff-leave', manager.token, { staffId: (await makeAccount({ role: 'coach', branchIds: [await makeBranch()] })).id, from: w.from, to: w.to })).status, 404);
    assert.equal((await post('/staff-leave', manager.token, { staffId: (await customer()).id, from: w.from, to: w.to })).status, 422);
  });

  test('a manager asking for their own leave needs an owner; an owner needs nobody', async () => {
    const manager = await staff('manager');
    const owner = await staff('owner');
    const w = window();
    const mine = await post('/staff-leave', manager.token, { from: w.from, to: w.to });
    assert.equal(mine.body.status, 'requested');
    assert.equal((await post(`/staff-leave/${mine.body.id}/decision`, manager.token, { decision: 'approve' })).status, 403);
    assert.equal((await post(`/staff-leave/${mine.body.id}/decision`, owner.token, { decision: 'approve' })).status, 201);
    assert.equal((await post('/staff-leave', owner.token, { from: w.from, to: w.to })).body.status, 'approved');
  });

  test('leave is refused while the coach still has classes in that time', async () => {
    const manager = await staff('manager');
    const coach = await makeAccount({ role: 'coach' });
    const coachToken = await tokenFor(coach);
    const w = window();
    const classId = await makeClass({ startsAt: w.day + 8 * HOUR, coachId: coach.id });
    const direct = await post('/staff-leave', manager.token, { staffId: coach.id, from: w.from, to: w.to });
    assert.equal(direct.status, 409);
    assert.ok(codes(direct).includes('LEAVE_HAS_CLASSES'));
    assert.deepEqual(direct.body.classes.map((c: Json) => c.id), [classId]);
    const asked = await post('/staff-leave', coachToken, { from: w.from, to: w.to });
    assert.equal(asked.status, 201);
    const approve = await post(`/staff-leave/${asked.body.id}/decision`, manager.token, { decision: 'approve' });
    assert.equal(approve.status, 409);
    assert.equal((await ctx.admin.query(`SELECT status FROM staff_unavailability WHERE id = $1`, [asked.body.id])).rows[0].status, 'requested');
  });

  test('bad ranges and past dates are refused', async () => {
    const coach = await staff('coach');
    const day = randomDay();
    for (const [from, to] of [[iso(day + DAY), iso(day)], [iso(day), iso(day)], ['nope', 'nope'], [iso(day), iso(day + 500 * DAY)]]) {
      assert.equal((await post('/staff-leave', coach.token, { from, to })).status, 400, `${from} ${to}`);
    }
    const past = await post('/staff-leave', coach.token, { from: iso(Date.now() - 3 * DAY), to: iso(Date.now() - DAY) });
    assert.equal(past.status, 422);
    assert.ok(codes(past).includes('LEAVE_IN_PAST'));
    assert.equal((await post('/staff-leave', coach.token, { from: iso(day), to: iso(day + DAY), reason: 'x'.repeat(2000) })).status, 400);
  });

  test('you can withdraw your own leave; a manager can cancel a lower-ranked person; finished leave stays', async () => {
    const coach = await staff('coach');
    const peer = await staff('coach');
    const manager = await staff('manager');
    const w = window();
    const mine = await post('/staff-leave', coach.token, { from: w.from, to: w.to });
    assert.equal((await del(`/staff-leave/${mine.body.id}`, peer.token)).status, 403);
    assert.equal((await del(`/staff-leave/${mine.body.id}`, coach.token)).status, 200);
    assert.equal((await del(`/staff-leave/${mine.body.id}`, coach.token)).status, 404);
    const theirs = await post('/staff-leave', coach.token, { from: w.from, to: w.to });
    assert.equal((await del(`/staff-leave/${theirs.body.id}`, manager.token)).status, 200);
    const old = (await ctx.admin.query(`INSERT INTO staff_unavailability (staff_account_id, during, status) VALUES ($1, tstzrange(now() - interval '5 days', now() - interval '3 days'), 'approved') RETURNING id`, [coach.id])).rows[0].id;
    assert.equal((await del(`/staff-leave/${old}`, coach.token)).status, 409);
  });

  test('listing: staff see their own; managers see everyone in their branches, not other branches', async () => {
    const coach = await staff('coach');
    const peer = await staff('coach');
    const manager = await staff('manager');
    const w = window();
    const mine = await post('/staff-leave', coach.token, { from: w.from, to: w.to });
    const theirs = await post('/staff-leave', peer.token, { from: w.from, to: w.to });
    const foreignCoach = await makeAccount({ role: 'coach', branchIds: [await makeBranch()] });
    const foreign = (await ctx.admin.query(`INSERT INTO staff_unavailability (staff_account_id, during, status) VALUES ($1, tstzrange($2::timestamptz,$3::timestamptz), 'requested') RETURNING id`, [foreignCoach.id, w.from, w.to])).rows[0].id;
    const own = (await get(`/staff-leave?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`, coach.token)).body.leave.map((l: Json) => l.id);
    assert.ok(own.includes(mine.body.id) && !own.includes(theirs.body.id));
    assert.equal((await get(`/staff-leave?staffId=${peer.id}`, coach.token)).status, 403);
    const all = (await get(`/staff-leave?status=requested&from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`, manager.token)).body.leave.map((l: Json) => l.id);
    assert.ok(all.includes(mine.body.id) && all.includes(theirs.body.id) && !all.includes(foreign));
    assert.equal((await get('/staff-leave?status=zzz', manager.token)).status, 400);
    assert.equal((await get('/staff-leave', (await customer()).token)).status, 403);
    assert.equal((await post(`/staff-leave/${foreign}/decision`, manager.token, { decision: 'approve' })).status, 404);
  });
});
