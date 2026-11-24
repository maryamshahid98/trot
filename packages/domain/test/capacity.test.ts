import { test } from "node:test";
import assert from "node:assert/strict";
import { canConfirmUnpaid, place, spotsLeft } from "../src/index.ts";
import { NOW, booking, occ, policy } from "./fixtures.ts";

const many = (n: number, o: Partial<ReturnType<typeof booking>> = {}) => Array.from({ length: n }, (_, i) => booking({ id: `b${i}`, riderId: `r${i}`, ...o }));

test("spots left = capacity minus bookings that hold a place", () => {
  assert.equal(spotsLeft(occ({ capacity: 6 }), many(5), NOW, policy), 1);
});

test("cancelled and no-show bookings free the place", () => {
  const bs = [...many(4), booking({ id: "c", status: "cancelled" }), booking({ id: "n", status: "no_show" })];
  assert.equal(spotsLeft(occ({ capacity: 6 }), bs, NOW, policy), 2);
});

test("the last place goes to the first request; the second is waitlisted", () => {
  const o = occ({ capacity: 6 });
  let bs = many(5);
  assert.equal(place(o, bs, "package", NOW, policy), "confirmed");
  bs = [...bs, booking({ id: "last", riderId: "rx" })];
  assert.equal(place(o, bs, "package", NOW, policy), "waitlisted");
});

test("a pay-at-office booking holds a place only until the hold runs out", () => {
  const o = occ({ capacity: 1 });
  const fresh = booking({ status: "pending_office_payment", payWith: "office", createdAt: NOW - 5 * 60_000 });
  const stale = booking({ status: "pending_office_payment", payWith: "office", createdAt: NOW - 11 * 60_000 });
  assert.equal(place(o, [fresh], "package", NOW, policy), "waitlisted");
  assert.equal(place(o, [stale], "package", NOW, policy), "confirmed");
});

test("office bookings start as pending until paid", () => {
  assert.equal(place(occ(), [], "office", NOW, policy), "pending_office_payment");
});

test("only managers or owners may confirm an unpaid office booking, and only if the club allows it", () => {
  assert.equal(canConfirmUnpaid("reception", policy), false);
  assert.equal(canConfirmUnpaid("manager", policy), true);
  assert.equal(canConfirmUnpaid("manager", { ...policy, allowManagerUnpaidConfirmation: false }), false);
});
