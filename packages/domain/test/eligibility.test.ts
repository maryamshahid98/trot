import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEligibility } from "../src/index.ts";
import { NOW, at, booking, occ, policy, rider } from "./fixtures.ts";

const base = { now: NOW, policy, payWith: "package" as const, packageBalance: 12, riderBookings: [] };
const codes = (r: ReturnType<typeof checkEligibility>) => r.reasons.map((x) => x.code);

test("an approved rider with documents can book", () => {
  const r = checkEligibility({ ...base, rider: rider(), occurrence: occ() });
  assert.equal(r.allowed, true);
});

test("a rider who is not yet approved cannot book", () => {
  assert.ok(codes(checkEligibility({ ...base, rider: rider({ status: "pending_review" }), occurrence: occ() })).includes("RIDER_NOT_ACTIVE"));
});

test("level below the class requirement is blocked with a clear reason", () => {
  const r = checkEligibility({ ...base, rider: rider({ level: "intermediate" }), occurrence: occ({ minLevel: "advanced" }) });
  assert.deepEqual(codes(r), ["LEVEL_TOO_LOW"]);
});

test("a medical form that expires before the class date blocks booking", () => {
  const r = checkEligibility({ ...base, rider: rider({ medicalFormExpiresAt: at(3) }), occurrence: occ({ startsAt: at(8), endsAt: at(8, 17) }) });
  assert.deepEqual(codes(r), ["MEDICAL_EXPIRED"]);
});

test("a medical form still valid on the class day is fine", () => {
  const r = checkEligibility({ ...base, rider: rider({ medicalFormExpiresAt: at(8, 23) }), occurrence: occ() });
  assert.equal(r.allowed, true);
});

test("missing medical form and waiver are both reported at once", () => {
  const r = checkEligibility({ ...base, rider: rider({ medicalFormExpiresAt: undefined, waiverSignedAt: undefined }), occurrence: occ() });
  assert.deepEqual(codes(r), ["MEDICAL_MISSING", "WAIVER_MISSING"]);
});

test("a child with no linked guardian cannot book", () => {
  assert.ok(codes(checkEligibility({ ...base, rider: rider({ guardianId: undefined }), occurrence: occ() })).includes("GUARDIAN_REQUIRED"));
});

test("an adult does not need a guardian", () => {
  const r = checkEligibility({ ...base, rider: rider({ guardianId: undefined, dateOfBirth: Date.UTC(1990, 0, 1) }), occurrence: occ() });
  assert.equal(r.allowed, true);
});

test("booking the same class twice is blocked", () => {
  const r = checkEligibility({ ...base, rider: rider(), occurrence: occ(), riderBookings: [{ booking: booking(), occurrence: occ() }] });
  assert.deepEqual(codes(r), ["DUPLICATE_BOOKING"]);
});

test("a rider cannot be in two overlapping classes", () => {
  const other = occ({ id: "o2", startsAt: at(8, 16) + 30 * 60_000, endsAt: at(8, 18) });
  const r = checkEligibility({ ...base, rider: rider(), occurrence: occ(), riderBookings: [{ booking: booking({ id: "b2", occurrenceId: "o2" }), occurrence: other }] });
  assert.ok(codes(r).includes("RIDER_OVERLAP"));
});

test("an expired pay-at-office hold no longer blocks the rider", () => {
  const stale = booking({ status: "pending_office_payment", payWith: "office", createdAt: NOW - 60 * 60_000, occurrenceId: "o1" });
  const r = checkEligibility({ ...base, rider: rider(), occurrence: occ(), riderBookings: [{ booking: stale, occurrence: occ() }] });
  assert.equal(r.allowed, true);
});

test("the daily limit counts other classes on the same day", () => {
  const mk = (n: number) => ({ booking: booking({ id: `b${n}`, occurrenceId: `x${n}` }), occurrence: occ({ id: `x${n}`, startsAt: at(8, 7 + n * 2), endsAt: at(8, 8 + n * 2) }) });
  const r = checkEligibility({ ...base, rider: rider(), occurrence: occ(), riderBookings: [mk(1), mk(2)] });
  assert.ok(codes(r).includes("DAILY_LIMIT"));
});

test("paying with a package needs a positive balance; paying at the office does not", () => {
  assert.ok(codes(checkEligibility({ ...base, rider: rider(), occurrence: occ(), packageBalance: 0 })).includes("NO_PACKAGE_BALANCE"));
  assert.equal(checkEligibility({ ...base, rider: rider(), occurrence: occ(), payWith: "office", packageBalance: 0 }).allowed, true);
});

test("a class in the past or not published cannot be booked", () => {
  assert.ok(codes(checkEligibility({ ...base, rider: rider(), occurrence: occ({ startsAt: NOW - 1000, endsAt: NOW + 1000 }) })).includes("CLASS_STARTED"));
  assert.ok(codes(checkEligibility({ ...base, rider: rider(), occurrence: occ({ status: "draft" }) })).includes("CLASS_NOT_BOOKABLE"));
});

test("the club can switch off the medical form requirement", () => {
  const r = checkEligibility({ ...base, policy: { ...policy, requireMedicalForm: false }, rider: rider({ medicalFormExpiresAt: undefined }), occurrence: occ() });
  assert.equal(r.allowed, true);
});

// ---------- rides ----------
const ride = (o: Parameters<typeof occ>[0] = {}) => occ({ format: "ride", ...o });
const office = { ...base, payWith: "office" as const, packageBalance: undefined };

test("a ride can be booked and paid for at the office", () => {
  assert.equal(checkEligibility({ ...office, rider: rider(), occurrence: ride() }).allowed, true);
});

test("a class package can never pay for a ride, even with classes left", () => {
  const r = checkEligibility({ ...base, rider: rider(), occurrence: ride(), packageBalance: 12 });
  assert.deepEqual(codes(r), ["RIDE_NOT_IN_PACKAGE"]);
});

test("a rider younger than the ride's minimum age is blocked", () => {
  // The fixture rider was born in March 2016, so is 10 in November 2026.
  assert.deepEqual(codes(checkEligibility({ ...office, rider: rider({ guardianId: "g1" }), occurrence: ride({ minAgeYears: 12 }) })), ["RIDER_TOO_YOUNG"]);
  assert.equal(checkEligibility({ ...office, rider: rider(), occurrence: ride({ minAgeYears: 10 }) }).allowed, true);
});

test("minimum age is judged on the day of the ride, not today", () => {
  // Turns 11 on 14 Mar 2027. A ride in April 2027 is fine for age 11; a ride in January 2027 is not.
  const in2027 = (month: number) => Date.UTC(2027, month, 10, 9, 0);
  const aged = (startsAt: number) => checkEligibility({ ...office, rider: rider({ medicalFormExpiresAt: at(400) }), occurrence: ride({ minAgeYears: 11, startsAt, endsAt: startsAt + 3_600_000 }) });
  assert.equal(aged(in2027(3)).allowed, true);
  assert.deepEqual(codes(aged(in2027(0))), ["RIDER_TOO_YOUNG"]);
});

test("a class with no minimum age ignores age", () => {
  assert.equal(checkEligibility({ ...base, rider: rider(), occurrence: occ() }).allowed, true);
  assert.equal(checkEligibility({ ...office, rider: rider(), occurrence: ride({ minAgeYears: undefined }) }).allowed, true);
});

test("ride safety checks still apply: level, documents and guardian", () => {
  const r = checkEligibility({ ...office, rider: rider({ level: "beginner", medicalFormExpiresAt: undefined, guardianId: undefined }), occurrence: ride({ minLevel: "advanced" }) });
  assert.deepEqual(codes(r).sort(), ["GUARDIAN_REQUIRED", "LEVEL_TOO_LOW", "MEDICAL_MISSING"].sort());
});
