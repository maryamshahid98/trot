// Repeating classes: one series, every date checked like a single class, all inside one transaction.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, at, BRANCH, ctx, makeAccount, makeArena, makeBranch, randomDay, startApp, stopApp, tokenFor } from './helpers.ts';
import type { Json } from './helpers.ts';
import { balanceOf, DAY, HOUR, makePackage, readyRider } from './booking-helpers.ts';
import { auditActions, directBooking, statusOf } from './flow-helpers.ts';

let day = 0;
const tokens: Record<string, string> = {};
let coachId = '';
let coach2Id = '';
let arenaId = '';
let otherBranchManager = '';

before(async () => {
  await startApp();
  day = randomDay();
  coachId = (await makeAccount({ role: 'coach' })).id;
  coach2Id = (await makeAccount({ role: 'coach' })).id;
  for (const role of ['owner', 'manager', 'reception', 'coach', 'customer']) tokens[role] = await tokenFor(await makeAccount({ role }));
  otherBranchManager = await tokenFor(await makeAccount({ role: 'manager', branchIds: [await makeBranch()] }));
});
after(stopApp);

// Every test gets its own arena and a far-apart week, so tests never clash with each other or with other test files.
let weekSlot = 0;
const fresh = async () => {
  arenaId = await makeArena();
  const start = day + 7 * DAY * 10 * weekSlot++; // 10 weeks apart
  return start;
};
const body = (start: number, extra: Record<string, unknown> = {}) => ({
  branchId: BRANCH, title: 'Weekly lesson', arenaId, coachId, format: 'group', startsAt: at(start, 6), endsAt: at(start, 7), capacity: 6,
  repeat: { everyWeeks: 1, count: 4 }, ...extra,
});
const series = (token: string | undefined, b: unknown) => api('POST', '/schedule/series', { token, body: b });
const inSeries = async (id: string) => (await ctx.admin.query(`SELECT id, lower(during) AS s, status FROM occurrences WHERE series_id = $1 ORDER BY lower(during)`, [id])).rows;

describe('creating a series', () => {
  test('every week for 4 sessions: 4 dated sessions, same time of day, all linked to one series', async () => {
    const start = await fresh();
    const r = await series(tokens.reception, body(start));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.created.length, 4);
    assert.equal(r.body.skipped.length, 0);
    const rows = await inSeries(r.body.seriesId);
    assert.equal(rows.length, 4);
    for (let i = 0; i < 4; i++) assert.equal(new Date(rows[i].s).getTime(), start + 6 * HOUR + i * 7 * DAY);
    const s = (await ctx.admin.query(`SELECT session_count, every_weeks FROM schedule_series WHERE id = $1`, [r.body.seriesId])).rows[0];
    assert.deepEqual([s.session_count, s.every_weeks], [4, 1]);
    assert.ok((await auditActions(r.body.seriesId)).includes('series.create'));
  });

  test('every 2 weeks, ending on a last date', async () => {
    const start = await fresh();
    const lastDate = new Date(start + 28 * DAY).toISOString().slice(0, 10);
    const r = await series(tokens.manager, body(start, { repeat: { everyWeeks: 2, until: lastDate } }));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.created.length, 3); // weeks 0, 2 and 4
  });

  test('the sessions show up in the schedule list with their series id', async () => {
    const start = await fresh();
    const r = await series(tokens.manager, body(start, { repeat: { everyWeeks: 1, count: 2 } }));
    const list = await api('GET', `/schedule?from=${encodeURIComponent(at(start, 0))}&to=${encodeURIComponent(at(start + 8 * DAY, 23))}`, { token: tokens.manager });
    const mine = (list.body as Json[]).filter((o) => o.seriesId === r.body.seriesId);
    assert.equal(mine.length, 2);
  });

  test('only reception, manager and owner may create a series', async () => {
    const start = await fresh();
    assert.equal((await series(undefined, body(start))).status, 401);
    for (const role of ['coach', 'customer']) assert.equal((await series(tokens[role], body(start))).status, 403, role);
    for (const role of ['reception', 'manager', 'owner']) {
      const s = await fresh();
      assert.equal((await series(tokens[role], body(s))).status, 201, role);
    }
  });
});

describe('dates that clash', () => {
  const clashSetup = async () => {
    const start = await fresh();
    // another class in the same arena on the 3rd date of the series
    const clash = await api('POST', '/schedule', { token: tokens.manager, body: { branchId: BRANCH, title: 'In the way', arenaId, coachId: coach2Id, format: 'group', startsAt: at(start + 14 * DAY, 6), endsAt: at(start + 14 * DAY, 7), capacity: 4 } });
    assert.equal(clash.status, 201, clash.text);
    return start;
  };
  const count = async (title: string) => (await ctx.admin.query(`SELECT count(*)::int AS n FROM occurrences WHERE title = $1`, [title])).rows[0].n;

  test('by default one clashing date refuses the WHOLE series, names the date, and saves nothing', async () => {
    const start = await clashSetup();
    const title = `All or nothing ${Date.now()}`;
    const r = await series(tokens.manager, body(start, { title }));
    assert.equal(r.status, 422, r.text);
    assert.match(r.body.message, /1 of 4 dates cannot be scheduled, so nothing was saved/);
    assert.equal(r.body.problems.length, 1);
    assert.equal(new Date(r.body.problems[0].date).getTime(), start + 14 * DAY + 6 * HOUR);
    assert.ok(r.body.problems[0].reasons.length > 0);
    assert.equal(await count(title), 0, 'no session was left behind');
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM schedule_series WHERE title = $1`, [title])).rows[0].n, 0, 'no series row either');
  });

  test('skipConflicts saves the dates that work and reports the one that clashed', async () => {
    const start = await clashSetup();
    const r = await series(tokens.manager, body(start, { skipConflicts: true }));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.created.length, 3);
    assert.equal(r.body.skipped.length, 1);
    assert.equal(new Date(r.body.skipped[0].startsAt).getTime(), start + 14 * DAY + 6 * HOUR);
    assert.equal((await inSeries(r.body.seriesId)).length, 3);
  });

  test('a manager can override the clash with a reason, and every clashing date is saved', async () => {
    const start = await clashSetup();
    const r = await series(tokens.manager, body(start, { override: { reason: 'Double-up agreed with the coaches' } }));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.created.length, 4);
    assert.equal(r.body.created.filter((c: Json) => c.overridden).length, 1);
  });

  test('reception cannot override a clash', async () => {
    const start = await clashSetup();
    const r = await series(tokens.reception, body(start, { override: { reason: 'please' } }));
    assert.equal(r.status, 422, r.text);
  });

  test('dryRun saves nothing and says what would happen', async () => {
    const start = await clashSetup();
    const title = `Dry run ${Date.now()}`;
    const r = await series(tokens.manager, body(start, { title, dryRun: true }));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.seriesId, null);
    assert.equal(r.body.created.length, 3);
    assert.equal(r.body.skipped.length, 1);
    assert.equal(await count(title), 0);
  });
});

describe('bad requests', () => {
  const bad = async (repeat: unknown, extra: Record<string, unknown> = {}) => {
    const start = await fresh();
    return series(tokens.manager, body(start, { repeat, ...extra }));
  };
  test('a repeat rule must make sense', async () => {
    assert.equal((await bad({ everyWeeks: 1 })).status, 400, 'neither count nor until');
    assert.equal((await bad({ everyWeeks: 1, count: 3, until: '2041-01-01' })).status, 400, 'both');
    assert.equal((await bad({ everyWeeks: 1, count: 1 })).status, 400, 'a series needs at least 2');
    assert.equal((await bad({ everyWeeks: 1, count: 53 })).status, 400, 'too many');
    assert.equal((await bad({ everyWeeks: 5, count: 3 })).status, 400, 'every 5 weeks');
    assert.equal((await bad({ everyWeeks: 0, count: 3 })).status, 400);
    assert.equal((await bad({ everyWeeks: 1, until: '01/01/2041' })).status, 400, 'date format');
    assert.equal((await bad({ everyWeeks: 1, until: '2000-01-01' })).status, 400, 'a last date before the first session');
    assert.equal((await bad(undefined)).status, 400, 'no repeat at all');
  });
  test('an unknown arena or coach is refused and nothing is saved', async () => {
    const start = await fresh();
    const title = `Unknown ${Date.now()}`;
    const r = await series(tokens.manager, body(start, { title, arenaId: '00000000-0000-0000-0000-00000000dead' }));
    assert.ok([400, 422].includes(r.status), r.text);
    assert.equal((await ctx.admin.query(`SELECT count(*)::int AS n FROM occurrences WHERE title = $1`, [title])).rows[0].n, 0);
  });
});

describe('cancelling a series', () => {
  const cancel = (token: string | undefined, id: string) => api('POST', `/schedule/series/${id}/cancel`, { token, body: { reason: 'Coach is away', cause: 'club' } });

  test('every upcoming date is cancelled, riders are not charged, and package classes come back', async () => {
    const start = day + 7 * DAY * 10 * 40; // a week far from the others
    arenaId = await makeArena();
    const r = await series(tokens.manager, body(start));
    assert.equal(r.status, 201, r.text);
    const rows = await inSeries(r.body.seriesId);
    const riderId = await readyRider();
    const pack = await makePackage(riderId, { balance: 5 });
    const booking = await directBooking({ occurrenceId: rows[1].id, riderId, status: 'confirmed', payWith: 'package', packageId: pack });
    assert.equal(await balanceOf(pack), 4, 'the booking spent a class');

    const c = await cancel(tokens.manager, r.body.seriesId);
    assert.equal(c.status, 201, c.text);
    assert.equal(c.body.cancelled, 4);
    assert.deepEqual(c.body.failed, []);
    for (const row of await inSeries(r.body.seriesId)) assert.equal(row.status, 'cancelled');
    assert.equal(await statusOf(booking), 'cancelled');
    assert.equal(await balanceOf(pack), 5, 'the class came back to the package');
    assert.ok((await auditActions(r.body.seriesId)).includes('series.cancel'));
    assert.equal((await cancel(tokens.manager, r.body.seriesId)).body.cancelled, 0, 'a second call finds nothing left to cancel');
  });

  test('only managers and owners may cancel a series; another branch cannot see it', async () => {
    const start = await fresh();
    const r = await series(tokens.manager, body(start));
    assert.equal((await cancel(undefined, r.body.seriesId)).status, 401);
    for (const role of ['reception', 'coach', 'customer']) assert.equal((await cancel(tokens[role], r.body.seriesId)).status, 403, role);
    assert.equal((await cancel(otherBranchManager, r.body.seriesId)).status, 404);
    assert.equal((await cancel(tokens.owner, '00000000-0000-0000-0000-00000000dead')).status, 404);
    assert.equal((await cancel(tokens.manager, 'not-an-id')).status, 400);
  });

  test('a date that has already started is left alone', async () => {
    const past = Date.now() - 2 * DAY;
    arenaId = await makeArena();
    const sid = (await ctx.admin.query(`INSERT INTO schedule_series (branch_id, title, every_weeks, first_starts_at, session_count, created_by) VALUES ($1,'Old',1,now(),2,$2) RETURNING id`, [BRANCH, (await makeAccount({ role: 'manager' })).id])).rows[0].id;
    await ctx.admin.query(`INSERT INTO occurrences (branch_id, title, format, min_level, arena_id, coach_id, during, capacity, price_minor, status, series_id) VALUES ($1,'Old one','group','beginner',$2,$3,tstzrange($4::timestamptz,$5::timestamptz),4,0,'published',$6)`, [BRANCH, arenaId, coachId, new Date(past).toISOString(), new Date(past + HOUR).toISOString(), sid]);
    const c = await cancel(tokens.manager, sid);
    assert.equal(c.body.cancelled, 0);
  });
});
