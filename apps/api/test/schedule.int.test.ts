// Schedule: who may do what, which branch, bad input, clashes, overrides, races.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DbService } from '../src/db/db.service.ts';
import { api, at, BRANCH, ctx, makeAccount, makeArena, makeBranch, randomDay, startApp, stopApp, tokenFor } from './helpers.ts';

let day = 0;
let arenaId = '';
let coach: { id: string; email: string };
let coach2: { id: string; email: string };
const tokens: Record<string, string> = {};
let otherBranch = '';
let otherBranchManagerToken = '';

before(async () => {
  await startApp();
  day = randomDay();
  arenaId = await makeArena();
  coach = await makeAccount({ role: 'coach' });
  coach2 = await makeAccount({ role: 'coach' });
  for (const role of ['owner', 'manager', 'reception', 'coach', 'stable_hand', 'customer']) {
    tokens[role] = await tokenFor(await makeAccount({ role }));
  }
  otherBranch = await makeBranch();
  otherBranchManagerToken = await tokenFor(await makeAccount({ role: 'manager', branchIds: [otherBranch] }));
});
after(stopApp);

const cls = (extra: Record<string, unknown> = {}) => ({
  branchId: BRANCH, title: 'Test class', arenaId, coachId: coach.id, format: 'group', startsAt: at(day, 10), endsAt: at(day, 11), capacity: 6, ...extra,
});
const post = (token: string | undefined, body: unknown) => api('POST', '/schedule', { token, body });
const list = (token: string | undefined, extra = '') => api('GET', `/schedule?from=${encodeURIComponent(at(day, 0))}&to=${encodeURIComponent(at(day, 23))}${extra}`, { token });
// Every call gets its own 5-minute slot, 10 minutes apart, so tests never collide with each other.
let slot = 0;
const fresh = (extra: Record<string, unknown> = {}) => {
  const h = 1 + slot++ / 6;
  return cls({ startsAt: at(day, h), endsAt: at(day, h + 1 / 12), ...extra });
};

// ---------- who may do what ----------
test('nobody signed in: 401 on read and write', async () => {
  assert.equal((await list(undefined)).status, 401);
  assert.equal((await post(undefined, cls())).status, 401);
});

test('only reception, manager and owner may create; coach, stable hand and customer get 403', async () => {
  for (const role of ['coach', 'stable_hand', 'customer']) {
    assert.equal((await post(tokens[role], fresh())).status, 403, role);
  }
  for (const role of ['reception', 'manager', 'owner']) {
    const r = await post(tokens[role], fresh());
    assert.equal(r.status, 201, `${role}: ${r.text}`);
  }
});

test('a refused request writes nothing', async () => {
  // Count only this test's own title: other test files create classes at the same time, so a table-wide count would race.
  const title = `Refused ${Date.now()}`;
  const count = async () => (await ctx.admin.query(`SELECT count(*)::int AS n FROM occurrences WHERE title = $1`, [title])).rows[0].n;
  await post(tokens.customer, fresh({ title }));
  await post(undefined, fresh({ title }));
  await post(tokens.manager, { branchId: BRANCH, title });
  assert.equal(await count(), 0);
});

test('every signed-in role can read the schedule', async () => {
  for (const role of Object.keys(tokens)) assert.equal((await list(tokens[role])).status, 200, role);
});

test('customers see published classes only; staff see drafts too', async () => {
  const draft = await post(tokens.manager, fresh({ title: 'Secret draft', status: 'draft' }));
  const pub = await post(tokens.manager, fresh({ title: 'Public class', status: 'published' }));
  assert.equal(draft.status, 201);
  assert.equal(pub.status, 201);
  const asCustomer = (await list(tokens.customer)).body as any[];
  assert.ok(asCustomer.some((c) => c.title === 'Public class'));
  assert.ok(!asCustomer.some((c) => c.title === 'Secret draft'));
  const asManager = (await list(tokens.manager)).body as any[];
  assert.ok(asManager.some((c) => c.title === 'Secret draft'));
});

// ---------- branches ----------
test('a manager cannot read or write in a branch they do not work in', async () => {
  assert.equal((await list(tokens.manager, `&branchId=${otherBranch}`)).status, 403);
  assert.equal((await post(tokens.manager, fresh({ branchId: otherBranch }))).status, 403);
  assert.equal((await post(otherBranchManagerToken, fresh())).status, 403, 'and the other branch manager cannot use ours');
});

test('the branch is optional for someone with one branch, and required for someone with several', async () => {
  assert.equal((await list(tokens.manager)).status, 200);
  const two = await tokenFor(await makeAccount({ role: 'manager', branchIds: [BRANCH, otherBranch] }));
  assert.equal((await list(two)).status, 400);
  assert.equal((await list(two, `&branchId=${BRANCH}`)).status, 200);
  assert.equal((await list(two, `&branchId=${otherBranch}`)).status, 200);
});

test('an account linked to no branch is refused', async () => {
  const none = await tokenFor(await makeAccount({ role: 'manager', branchIds: [] }));
  assert.equal((await list(none)).status, 403);
});

test('an arena or a coach from another branch cannot be used', async () => {
  const foreignArena = await makeArena(otherBranch);
  assert.equal((await post(tokens.manager, fresh({ arenaId: foreignArena }))).status, 400);
  const foreignCoach = await makeAccount({ role: 'coach', branchIds: [otherBranch] });
  assert.equal((await post(tokens.manager, fresh({ coachId: foreignCoach.id }))).status, 400);
});

test('the coach must really be a coach: a customer id is refused', async () => {
  const notCoach = await makeAccount({ role: 'customer' });
  assert.equal((await post(tokens.manager, fresh({ coachId: notCoach.id }))).status, 400);
});

test('unknown arena and unknown coach are 400', async () => {
  const ghost = '00000000-0000-0000-0000-00000000dead';
  assert.equal((await post(tokens.manager, fresh({ arenaId: ghost }))).status, 400);
  assert.equal((await post(tokens.manager, fresh({ coachId: ghost }))).status, 400);
});

// ---------- input checks ----------
test('missing, wrongly typed and malformed fields are 400 with field names', async () => {
  const missing = await post(tokens.manager, { branchId: BRANCH });
  assert.equal(missing.status, 400);
  assert.ok(missing.body.problems.some((p: any) => p.field === 'title'));
  for (const bad of [
    fresh({ title: '' }), fresh({ title: '   ' }), fresh({ title: 'x'.repeat(121) }), fresh({ title: 42 }),
    fresh({ arenaId: 'not-an-id' }), fresh({ coachId: `1' OR '1'='1` }),
    fresh({ format: 'rodeo' }), fresh({ minLevel: 'expert' }), fresh({ status: 'cancelled' }),
    fresh({ startsAt: 'tomorrow' }), fresh({ endsAt: '' }),
    fresh({ capacity: 2.5 }), fresh({ capacity: '6' }), fresh({ capacity: null }),
    fresh({ priceMinor: -1 }), fresh({ priceMinor: 10.5 }),
  ]) {
    assert.equal((await post(tokens.manager, bad)).status, 400, JSON.stringify(bad).slice(0, 120));
  }
});

test('impossible values reach the rules and are refused with a reason: capacity 0, negative capacity, end before start, zero length', async () => {
  const s = fresh();
  const cap0 = await post(tokens.manager, { ...s, capacity: 0 });
  assert.equal(cap0.status, 422);
  assert.ok(cap0.body.problems.some((p: any) => p.code === 'BAD_CAPACITY'));
  assert.equal((await post(tokens.manager, { ...s, capacity: -3 })).status, 422);
  const back = await post(tokens.manager, { ...s, startsAt: s.endsAt, endsAt: s.startsAt });
  assert.equal(back.status, 422);
  assert.ok(back.body.problems.some((p: any) => p.code === 'BAD_TIME'));
  assert.equal((await post(tokens.manager, { ...s, endsAt: s.startsAt })).status, 422);
});

test('an unknown field is ignored: a caller cannot switch on the overlap permission themselves', async () => {
  const base = fresh();
  assert.equal((await post(tokens.manager, base)).status, 201);
  const sneaky = await post(tokens.manager, { ...base, coachId: coach2.id, allow_overlap: true, allowOverlap: true, id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(sneaky.status, 422, 'extra fields must not unlock an overlap');
});

test('text is stored exactly as typed: quotes and SQL-looking text are just text', async () => {
  const title = `Robert'); DROP TABLE occurrences;--`;
  const r = await post(tokens.manager, fresh({ title }));
  assert.equal(r.status, 201);
  const rows = (await list(tokens.manager)).body as any[];
  assert.ok(rows.some((c) => c.title === title));
  assert.equal((await ctx.admin.query(`SELECT to_regclass('public.occurrences') AS t`)).rows[0].t, 'occurrences');
});

test('listing: bad dates, backwards range, a range over 62 days, and a bad branch id are all 400', async () => {
  assert.equal((await api('GET', '/schedule', { token: tokens.manager })).status, 400);
  assert.equal((await api('GET', `/schedule?from=yesterday&to=today`, { token: tokens.manager })).status, 400);
  assert.equal((await api('GET', `/schedule?from=${encodeURIComponent(at(day, 5))}&to=${encodeURIComponent(at(day, 1))}`, { token: tokens.manager })).status, 400);
  assert.equal((await api('GET', `/schedule?from=${encodeURIComponent(at(day, 0))}&to=${encodeURIComponent(at(day + 63 * 86_400_000, 0))}`, { token: tokens.manager })).status, 400);
  assert.equal((await list(tokens.manager, `&branchId=nope`)).status, 400);
});

test('listing shows arena and coach names, in time order', async () => {
  const rows = (await list(tokens.manager)).body as any[];
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.arenaName && r.coachName));
  const starts = rows.map((r) => Date.parse(r.startsAt));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
});

// ---------- clashes and overrides ----------
test('the same arena at an overlapping time is refused with a plain reason; touching times are fine', async () => {
  const s = fresh();
  assert.equal((await post(tokens.manager, s)).status, 201);
  const clash = await post(tokens.manager, { ...s, coachId: coach2.id });
  assert.equal(clash.status, 422);
  assert.ok(clash.body.problems.some((p: any) => p.code === 'ARENA_OVERLAP'));
  // a class that starts exactly when the first one ends does not clash (it uses another arena, so only the time edge is tested)
  const touching = await post(tokens.manager, { ...s, arenaId: await makeArena(), coachId: coach2.id, startsAt: s.endsAt, endsAt: new Date(Date.parse(s.endsAt) + 300_000).toISOString() });
  assert.equal(touching.status, 201, touching.text);
});

test('the same coach at an overlapping time is refused', async () => {
  const s = fresh();
  assert.equal((await post(tokens.manager, s)).status, 201);
  const clash = await post(tokens.manager, { ...s, arenaId: await makeArena() });
  assert.equal(clash.status, 422);
  assert.ok(clash.body.problems.some((p: any) => p.code === 'COACH_OVERLAP'));
});

test('a cancelled class no longer blocks its slot', async () => {
  const s = fresh();
  const first = await post(tokens.manager, s);
  await ctx.admin.query(`UPDATE occurrences SET status = 'cancelled' WHERE id = $1`, [first.body.id]);
  assert.equal((await post(tokens.manager, { ...s, coachId: coach2.id })).status, 201);
});

test('overrides: reception is refused, manager and owner may with a reason, and the override is recorded and audited', async () => {
  const s = fresh();
  assert.equal((await post(tokens.manager, s)).status, 201);
  const clash = { ...s, coachId: coach2.id };
  const reason = 'Shared warm-up, agreed with the head coach';

  const asReception = await post(tokens.reception, { ...clash, override: { reason } });
  assert.equal(asReception.status, 422, 'reception cannot override');

  assert.equal((await post(tokens.manager, { ...clash, override: { reason: '   ' } })).status, 400, 'a blank reason is not a reason');
  assert.equal((await post(tokens.manager, { ...clash, override: {} })).status, 400);

  const ok = await post(tokens.manager, { ...clash, override: { reason } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.overridden, true);
  const rec = (await ctx.admin.query(`SELECT reason, codes, approved_by FROM occurrence_overrides WHERE occurrence_id = $1`, [ok.body.id])).rows[0];
  assert.equal(rec.reason, reason);
  assert.ok(rec.codes.includes('ARENA_OVERLAP'));
  const me = (await api('GET', '/auth/me', { token: tokens.manager })).body.id;
  assert.equal(rec.approved_by, me, 'the approver is the signed-in user, not a name sent in the request');
  const audit = await ctx.admin.query(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'occurrence.create_override' AND actor_account_id = $2`, [ok.body.id, me]);
  assert.equal(audit.rowCount, 1);

  const owner = await post(tokens.owner, { ...s, coachId: (await makeAccount({ role: 'coach' })).id, override: { reason } });
  assert.equal(owner.status, 201, owner.text);
});

test('an override on a request with no clash is not recorded as an override', async () => {
  const r = await post(tokens.manager, fresh({ override: { reason: 'just in case' } }));
  assert.equal(r.status, 201);
  assert.equal(r.body.overridden, false);
  assert.equal((await ctx.admin.query(`SELECT 1 FROM occurrence_overrides WHERE occurrence_id = $1`, [r.body.id])).rowCount, 0);
});

test('impossible times and capacities can never be overridden', async () => {
  const s = fresh();
  const r = await post(tokens.owner, { ...s, startsAt: s.endsAt, endsAt: s.startsAt, override: { reason: 'please' } });
  assert.equal(r.status, 422);
});

test('a coach on approved leave cannot be scheduled; leave that is only requested does not block', async () => {
  const away = await makeAccount({ role: 'coach' });
  await ctx.admin.query(`INSERT INTO staff_unavailability (staff_account_id, during, reason, status) VALUES ($1, tstzrange($2::timestamptz,$3::timestamptz), 'leave', 'approved')`, [away.id, at(day, 14), at(day, 18)]);
  const blocked = await post(tokens.manager, cls({ coachId: away.id, startsAt: at(day, 15), endsAt: at(day, 16) }));
  assert.equal(blocked.status, 422);
  assert.ok(blocked.body.problems.some((p: any) => p.code === 'COACH_UNAVAILABLE'));

  const pending = await makeAccount({ role: 'coach' });
  await ctx.admin.query(`INSERT INTO staff_unavailability (staff_account_id, during, reason, status) VALUES ($1, tstzrange($2::timestamptz,$3::timestamptz), 'leave', 'requested')`, [pending.id, at(day, 14), at(day, 18)]);
  assert.equal((await post(tokens.manager, cls({ coachId: pending.id, startsAt: at(day, 15), endsAt: at(day, 16) }))).status, 201);
});

test('an arena closure blocks scheduling', async () => {
  const closedArena = await makeArena();
  await ctx.admin.query(`INSERT INTO arena_closures (arena_id, during, reason) VALUES ($1, tstzrange($2::timestamptz,$3::timestamptz), 'repairs')`, [closedArena, at(day, 20), at(day, 22)]);
  const r = await post(tokens.manager, cls({ arenaId: closedArena, startsAt: at(day, 20.5), endsAt: at(day, 21.5) }));
  assert.equal(r.status, 422);
  assert.ok(r.body.problems.some((p: any) => p.code === 'ARENA_CLOSED'));
});

test('several problems at once are all reported', async () => {
  const a2 = await makeArena();
  await ctx.admin.query(`INSERT INTO arena_closures (arena_id, during, reason) VALUES ($1, tstzrange($2::timestamptz,$3::timestamptz), 'repairs')`, [a2, at(day, 22), at(day, 23)]);
  const first = await post(tokens.manager, cls({ arenaId: await makeArena(), startsAt: at(day, 22.2), endsAt: at(day, 22.8) }));
  assert.equal(first.status, 201);
  const r = await post(tokens.manager, cls({ arenaId: a2, startsAt: at(day, 22.3), endsAt: at(day, 22.6) }));
  assert.equal(r.status, 422);
  const codes = r.body.problems.map((p: any) => p.code);
  assert.ok(codes.includes('COACH_OVERLAP') && codes.includes('ARENA_CLOSED'), codes.join(','));
});

// ---------- races ----------
test('two people scheduling the same arena at the same moment: exactly one succeeds', async () => {
  const s = fresh();
  const [a, b] = await Promise.all([post(tokens.manager, { ...s, coachId: coach.id }), post(tokens.reception, { ...s, coachId: coach2.id })]);
  const codes = [a.status, b.status].sort();
  assert.equal(codes[0], 201, `${a.text} / ${b.text}`);
  assert.ok(codes[1] === 409 || codes[1] === 422, `second request got ${codes[1]}`);
  const rows = await ctx.admin.query(`SELECT count(*)::int AS n FROM occurrences WHERE arena_id = $1 AND during = tstzrange($2::timestamptz,$3::timestamptz) AND status <> 'cancelled'`, [arenaId, s.startsAt, s.endsAt]);
  assert.equal(rows.rows[0].n, 1);
});

// ---------- the database enforces the branch rule even if the code forgot ----------
test('with no branch set, the API database role sees no classes at all', async () => {
  const db = ctx.app.get(DbService);
  const unscoped = await db.query('SELECT count(*)::int AS n FROM occurrences');
  const real = await ctx.admin.query('SELECT count(*)::int AS n FROM occurrences');
  assert.ok(real.rows[0].n > 0);
  assert.equal(unscoped.rows[0].n, 0, 'row-level security is not being applied to the API role');
});

test('a scope for another branch sees none of this branch\'s classes, and cannot write into this branch', async () => {
  const db = ctx.app.get(DbService);
  const n = await db.scoped({ branchIds: [otherBranch], role: 'manager' }, async (c: any) => (await c.query('SELECT count(*)::int AS n FROM occurrences WHERE branch_id = $1', [BRANCH])).rows[0].n);
  assert.equal(n, 0);
  await assert.rejects(
    db.scoped({ branchIds: [otherBranch], role: 'manager' }, (c: any) =>
      c.query(`INSERT INTO occurrences (branch_id, title, format, arena_id, coach_id, during, capacity) VALUES ($1,'x','group',$2,$3,tstzrange(now(), now() + interval '1 hour'),4)`, [BRANCH, arenaId, coach.id])),
    /row-level security/,
  );
});

test('the scope setting ends with the request: the next request starts with no scope', async () => {
  const db = ctx.app.get(DbService);
  await db.scoped({ branchIds: [BRANCH], role: 'manager' }, async () => {});
  const r = await db.query(`SELECT current_setting('app.branch_ids', true) AS v`);
  assert.ok(!r.rows[0].v, 'the branch list must not leak to the next user of the connection');
});
