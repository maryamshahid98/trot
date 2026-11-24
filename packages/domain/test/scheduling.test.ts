import { test } from "node:test";
import assert from "node:assert/strict";
import { canOverride, validateOccurrence } from "../src/index.ts";
import { at, occ } from "./fixtures.ts";

const cand = { id: "new", startsAt: at(8, 16), endsAt: at(8, 17), capacity: 6, arenaId: "a3", coachId: "c1" };
const codes = (r: ReturnType<typeof validateOccurrence>) => r.map((x) => x.code);

test("a free arena and coach pass", () => assert.deepEqual(validateOccurrence(cand, [], []), []));

test("the same arena cannot host two classes at once", () => {
  assert.deepEqual(codes(validateOccurrence(cand, [occ({ id: "x", coachId: "c9", startsAt: at(8, 16) + 1_800_000, endsAt: at(8, 18) })], [])), ["ARENA_OVERLAP"]);
});

test("the same coach cannot teach two classes at once", () => {
  assert.deepEqual(codes(validateOccurrence(cand, [occ({ id: "x", arenaId: "a1" })], [])), ["COACH_OVERLAP"]);
});

test("back-to-back classes in the same arena are fine", () => {
  assert.deepEqual(validateOccurrence(cand, [occ({ id: "x", startsAt: at(8, 15), endsAt: at(8, 16) })], []), []);
});

test("cancelled classes do not block the slot", () => {
  assert.deepEqual(validateOccurrence(cand, [occ({ id: "x", status: "cancelled" })], []), []);
});

test("arena closures and coach time off block the slot", () => {
  const bl = [
    { id: "1", kind: "arena_closure" as const, targetId: "a3", from: at(8, 0), to: at(9, 0) },
    { id: "2", kind: "coach_unavailable" as const, targetId: "c1", from: at(8, 0), to: at(9, 0) },
  ];
  assert.deepEqual(codes(validateOccurrence(cand, [], bl)), ["ARENA_CLOSED", "COACH_UNAVAILABLE"]);
});

test("end before start and zero capacity are always rejected", () => {
  const r = validateOccurrence({ ...cand, endsAt: cand.startsAt, capacity: 0 }, [], []);
  assert.deepEqual(codes(r), ["BAD_TIME", "BAD_CAPACITY"]);
  assert.equal(canOverride(r, { reason: "x", byRole: "owner", byUserId: "u" }).ok, false);
});

test("only a manager or owner with a reason can override an overlap", () => {
  const r = validateOccurrence(cand, [occ({ id: "x", arenaId: "a1" })], []);
  assert.equal(canOverride(r).ok, false);
  assert.equal(canOverride(r, { reason: "Joint clinic", byRole: "reception", byUserId: "u" }).ok, false);
  assert.equal(canOverride(r, { reason: "  ", byRole: "manager", byUserId: "u" }).ok, false);
  assert.equal(canOverride(r, { reason: "Joint clinic with two coaches", byRole: "manager", byUserId: "u" }).ok, true);
});
