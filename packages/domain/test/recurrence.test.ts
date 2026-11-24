import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateOf, MAX_SERIES_SESSIONS, RecurrenceError, weeklySlots } from '../src/index.ts';

const RIYADH = 'Asia/Riyadh'; // UTC+3 all year
const NEW_YORK = 'America/New_York'; // clocks go forward on Sun 8 Mar 2026 and back on Sun 1 Nov 2026
const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const first = (iso: string, hours = 1) => ({ startsAt: at(iso), endsAt: at(iso) + hours * HOUR });

test('every week for a count: same weekday, same clock time, same length', () => {
  const s = weeklySlots(first('2026-12-03T09:00:00+03:00'), { everyWeeks: 1, count: 4 }, RIYADH); // a Thursday
  assert.equal(s.length, 4);
  assert.deepEqual(s.map((x) => new Date(x.startsAt).toISOString()), ['2026-12-03T06:00:00.000Z', '2026-12-10T06:00:00.000Z', '2026-12-17T06:00:00.000Z', '2026-12-24T06:00:00.000Z']);
  for (const x of s) assert.equal(x.endsAt - x.startsAt, HOUR);
});

test('every other week', () => {
  const s = weeklySlots(first('2026-12-03T09:00:00+03:00'), { everyWeeks: 2, count: 3 }, RIYADH);
  assert.deepEqual(s.map((x) => localDateOf(x.startsAt, RIYADH)), ['2026-12-03', '2026-12-17', '2026-12-31']);
});

test('until a last date, which is itself allowed', () => {
  const s = weeklySlots(first('2026-12-03T09:00:00+03:00'), { everyWeeks: 1, untilDate: '2026-12-17' }, RIYADH);
  assert.deepEqual(s.map((x) => localDateOf(x.startsAt, RIYADH)), ['2026-12-03', '2026-12-10', '2026-12-17']);
  assert.equal(weeklySlots(first('2026-12-03T09:00:00+03:00'), { everyWeeks: 1, untilDate: '2026-12-16' }, RIYADH).length, 2);
});

test('the series crosses a month and a year end correctly', () => {
  const s = weeklySlots(first('2026-12-24T09:00:00+03:00'), { everyWeeks: 1, count: 3 }, RIYADH);
  assert.deepEqual(s.map((x) => localDateOf(x.startsAt, RIYADH)), ['2026-12-24', '2026-12-31', '2027-01-07']);
});

test('the clock time stays the same when the clocks go FORWARD (09:00 local every week)', () => {
  const s = weeklySlots(first('2026-03-05T09:00:00-05:00'), { everyWeeks: 1, count: 3 }, NEW_YORK); // Thu 5 Mar, then 12 Mar (after the change)
  assert.deepEqual(s.map((x) => new Date(x.startsAt).toISOString()), ['2026-03-05T14:00:00.000Z', '2026-03-12T13:00:00.000Z', '2026-03-19T13:00:00.000Z']);
  for (const x of s) assert.equal(x.endsAt - x.startsAt, HOUR);
});

test('the clock time stays the same when the clocks go BACK', () => {
  const s = weeklySlots(first('2026-10-29T09:00:00-04:00'), { everyWeeks: 1, count: 3 }, NEW_YORK); // Thu 29 Oct, then 5 Nov (after the change)
  assert.deepEqual(s.map((x) => new Date(x.startsAt).toISOString()), ['2026-10-29T13:00:00.000Z', '2026-11-05T14:00:00.000Z', '2026-11-12T14:00:00.000Z']);
});

test('a late evening session keeps its LOCAL date even though UTC is already the next day', () => {
  const s = weeklySlots(first('2026-12-03T23:30:00-05:00', 1), { everyWeeks: 1, count: 2 }, NEW_YORK);
  assert.deepEqual(s.map((x) => localDateOf(x.startsAt, NEW_YORK)), ['2026-12-03', '2026-12-10']);
});

test('bad requests are refused with a clear message', () => {
  const f = first('2026-12-03T09:00:00+03:00');
  const bad = (r: Parameters<typeof weeklySlots>[1], m: RegExp) => assert.throws(() => weeklySlots(f, r, RIYADH), (e) => e instanceof RecurrenceError && m.test(e.message));
  bad({ everyWeeks: 0, count: 3 }, /everyWeeks/);
  bad({ everyWeeks: 5, count: 3 }, /everyWeeks/);
  bad({ everyWeeks: 1.5, count: 3 }, /everyWeeks/);
  bad({ everyWeeks: 1 }, /either/);
  bad({ everyWeeks: 1, count: 3, untilDate: '2026-12-31' }, /either/);
  bad({ everyWeeks: 1, count: 1 }, /between 2 and/);
  bad({ everyWeeks: 1, count: MAX_SERIES_SESSIONS + 1 }, /between 2 and/);
  bad({ everyWeeks: 1, untilDate: '31/12/2026' }, /2026-12-31/);
  bad({ everyWeeks: 1, untilDate: '2026-12-03' }, /too early/);
  bad({ everyWeeks: 1, untilDate: '2030-12-31' }, /more than 52/);
  assert.throws(() => weeklySlots({ startsAt: 5, endsAt: 5 }, { everyWeeks: 1, count: 2 }, RIYADH), RecurrenceError);
});

test('the largest allowed series is 52 sessions', () => {
  assert.equal(weeklySlots(first('2026-12-03T09:00:00+03:00'), { everyWeeks: 1, count: MAX_SERIES_SESSIONS }, RIYADH).length, MAX_SERIES_SESSIONS);
});
