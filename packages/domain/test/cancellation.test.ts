import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCancellation, decideNoShow } from "../src/index.ts";
import { NOW, at, booking, occ, policy } from "./fixtures.ts";

test("cancelling more than 24 hours ahead returns the package class", () => {
  const d = decideCancellation(booking(), occ({ startsAt: at(3), endsAt: at(3, 17) }), NOW, "customer", policy);
  assert.deepEqual([d.allowed, d.consumesClass, d.returnsPackageClass], [true, false, true]);
});

test("cancelling inside 24 hours uses the class", () => {
  const d = decideCancellation(booking(), occ({ startsAt: NOW + 5 * 3_600_000, endsAt: NOW + 6 * 3_600_000 }), NOW, "customer", policy);
  assert.deepEqual([d.allowed, d.consumesClass, d.returnsPackageClass], [true, true, false]);
});

test("exactly 24 hours before is still free", () => {
  const d = decideCancellation(booking(), occ({ startsAt: NOW + 24 * 3_600_000, endsAt: NOW + 25 * 3_600_000 }), NOW, "customer", policy);
  assert.equal(d.consumesClass, false);
});

test("the club can make late cancellations free", () => {
  const d = decideCancellation(booking(), occ({ startsAt: NOW + 3_600_000, endsAt: NOW + 7_200_000 }), NOW, "customer", { ...policy, lateCancelConsumesClass: false });
  assert.equal(d.consumesClass, false);
});

test("club and weather cancellations never cost the rider, even at the last minute", () => {
  const o = occ({ startsAt: NOW + 600_000, endsAt: NOW + 4_200_000 });
  for (const cause of ["club", "weather"] as const) {
    const d = decideCancellation(booking(), o, NOW, cause, policy);
    assert.deepEqual([d.allowed, d.consumesClass, d.returnsPackageClass], [true, false, true]);
  }
});

test("an office-paid booking has no package class to return", () => {
  const d = decideCancellation(booking({ status: "pending_office_payment", payWith: "office", packageId: undefined }), occ(), NOW, "customer", policy);
  assert.deepEqual([d.allowed, d.returnsPackageClass], [true, false]);
});

test("a customer cannot cancel after the class has started", () => {
  const d = decideCancellation(booking(), occ({ startsAt: NOW - 600_000, endsAt: NOW + 3_000_000 }), NOW, "customer", policy);
  assert.equal(d.allowed, false);
});

test("completed, cancelled and checked-in bookings cannot be cancelled", () => {
  for (const status of ["completed", "cancelled", "checked_in", "no_show"] as const) {
    assert.equal(decideCancellation(booking({ status }), occ(), NOW, "customer", policy).allowed, false);
  }
});

test("a no-show uses the class under the default rules", () => {
  assert.equal(decideNoShow(booking(), policy).consumesClass, true);
  assert.equal(decideNoShow(booking(), { ...policy, noShowConsumesClass: false }).consumesClass, false);
});
