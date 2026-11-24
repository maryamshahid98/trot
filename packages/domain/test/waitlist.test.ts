import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccept, expireOffers, makeOffer, nextToOffer } from "../src/index.ts";
import type { WaitlistEntry } from "../src/index.ts";
import { NOW, policy } from "./fixtures.ts";

const w = (id: string, joinedAt: number, status: WaitlistEntry["status"] = "active"): WaitlistEntry => ({ id, riderId: `r-${id}`, occurrenceId: "o1", joinedAt, status });

test("the longest-waiting eligible rider is offered the place first", () => {
  const n = nextToOffer([w("b", NOW - 1000), w("a", NOW - 5000), w("c", NOW)], () => true);
  assert.equal(n?.id, "a");
});

test("a rider who is no longer eligible is skipped, not removed", () => {
  const n = nextToOffer([w("a", NOW - 5000), w("b", NOW - 1000)], (id) => id !== "r-a");
  assert.equal(n?.id, "b");
});

test("riders who already have an offer are not offered again", () => {
  assert.equal(nextToOffer([w("a", 1, "offered"), w("b", 2, "declined")], () => true), undefined);
});

test("an offer lasts two hours by default", () => {
  const o = makeOffer(w("a", 1), NOW, policy);
  assert.equal(o.offerExpiresAt, NOW + 120 * 60_000);
  assert.equal(canAccept(o, NOW + 119 * 60_000), true);
  assert.equal(canAccept(o, NOW + 120 * 60_000), false);
});

test("unanswered offers expire so the next rider can be offered", () => {
  const offered = makeOffer(w("a", 1), NOW, policy);
  const after = expireOffers([offered, w("b", 2)], NOW + 3 * 3_600_000);
  assert.equal(after[0]?.status, "expired");
  assert.equal(nextToOffer(after, () => true)?.id, "b");
});
