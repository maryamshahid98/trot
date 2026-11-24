import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHorse } from "../src/index.ts";
import type { HorseAssignment } from "../src/index.ts";
import { at, horse, occ, policy } from "./fixtures.ts";

const asg = (id: string, day: number, hStart: number, hEnd: number): HorseAssignment => ({ horseId: "h1", occurrenceId: id, startsAt: at(day, hStart), endsAt: at(day, hEnd) });
const o = occ({ startsAt: at(8, 16), endsAt: at(8, 17) });
const run = (assignments: HorseAssignment[], extra: Partial<Parameters<typeof checkHorse>[0]> = {}) =>
  checkHorse({ horse: horse(), occurrence: o, riderLevels: ["beginner"], assignments, policy, ...extra });
const codes = (r: ReturnType<typeof run>) => r.reasons.map((x) => x.code);

test("a rested, suitable horse can be assigned", () => assert.equal(run([]).allowed, true));

test("a horse that is resting, injured or on medical hold cannot be assigned", () => {
  for (const status of ["resting", "injured", "medical_hold", "retired"] as const) {
    assert.ok(codes(run([], { horse: horse({ status }) })).includes("HORSE_UNAVAILABLE"));
  }
});

test("a horse is only used in arenas and for levels it is approved for", () => {
  assert.ok(codes(run([], { horse: horse({ suitableArenaIds: ["a1"] }) })).includes("ARENA_UNSUITABLE"));
  assert.ok(codes(run([], { riderLevels: ["advanced"] })).includes("LEVEL_UNSUITABLE"));
});

test("a horse cannot be in two classes at once", () => {
  assert.ok(codes(run([asg("x", 8, 16, 17)])).includes("HORSE_OVERLAP"));
});

test("a horse needs the minimum rest gap between sessions", () => {
  const thirtyMinutesBefore: HorseAssignment = { horseId: "h1", occurrenceId: "x", startsAt: at(8, 15), endsAt: at(8, 15) + 30 * 60_000 };
  assert.ok(codes(run([thirtyMinutesBefore])).includes("HORSE_REST_GAP"));
  const twoHoursBefore: HorseAssignment = { horseId: "h1", occurrenceId: "y", startsAt: at(8, 13), endsAt: at(8, 14) };
  assert.equal(run([twoHoursBefore]).allowed, true);
});

test("the daily limit stops a fourth session in one day", () => {
  const three = [asg("a", 8, 8, 9), asg("b", 8, 10, 11), asg("c", 8, 13, 14)];
  assert.ok(codes(run(three)).includes("HORSE_DAILY_LIMIT"));
  assert.equal(run(three.slice(0, 2)).allowed, true);
});

test("the weekly limit counts sessions in the same club week", () => {
  const sessions: HorseAssignment[] = [];
  for (let d = 5; d <= 11; d++) { sessions.push(asg(`m${d}`, d, 8, 9)); sessions.push(asg(`n${d}`, d, 11, 12)); }
  const weekly = run(sessions, { policy: { ...policy, horseMaxSessionsPerWeek: 5 }, weekKeyOf: () => "same", dayKeyOf: (ms) => String(ms) });
  assert.ok(codes(weekly).includes("HORSE_WEEKLY_LIMIT"));
});

test("the club can change the limits", () => {
  const three = [asg("a", 8, 8, 9), asg("b", 8, 10, 11), asg("c", 8, 13, 14)];
  assert.equal(run(three, { policy: { ...policy, horseMaxSessionsPerDay: 4 } }).allowed, true);
});
