import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, balance } from "../src/index.ts";
import { entry } from "./fixtures.ts";

test("balance is the sum of ledger entries", () => {
  const es = [entry(), entry({ id: "e2", delta: -1, reason: "use", refKey: "use:b1" }), entry({ id: "e3", delta: -1, reason: "use", refKey: "use:b2" })];
  assert.equal(balance(es, "p1"), 18);
});

test("using a class reduces the balance", () => {
  const r = apply([entry()], entry({ id: "e2", delta: -1, reason: "use", refKey: "use:b1" }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(balance(r.entries, "p1"), 19);
});

test("the same reference applied twice only counts once (retry / double-click)", () => {
  const use = entry({ id: "e2", delta: -1, reason: "use", refKey: "use:b1" });
  const first = apply([entry()], use);
  assert.ok(first.ok);
  if (!first.ok) return;
  const second = apply(first.entries, { ...use, id: "e9" });
  assert.ok(second.ok);
  if (second.ok) {
    assert.equal(second.duplicate, true);
    assert.equal(balance(second.entries, "p1"), 19);
  }
});

test("a refund of the same booking cannot be applied twice", () => {
  const ret = entry({ id: "e3", delta: 1, reason: "return", refKey: "return:b1" });
  const a = apply([entry(), entry({ id: "e2", delta: -1, reason: "use", refKey: "use:b1" })], ret);
  assert.ok(a.ok);
  if (!a.ok) return;
  const b = apply(a.entries, { ...ret, id: "e4" });
  assert.ok(b.ok);
  if (b.ok) assert.equal(balance(b.entries, "p1"), 20);
});

test("the last class cannot be used twice", () => {
  const start = [entry({ delta: 1 })];
  const a = apply(start, entry({ id: "e2", delta: -1, reason: "use", refKey: "use:b1" }));
  assert.ok(a.ok);
  if (!a.ok) return;
  const b = apply(a.entries, entry({ id: "e3", delta: -1, reason: "use", refKey: "use:b2" }));
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.code, "INSUFFICIENT_BALANCE");
});

test("adjustments need a written reason", () => {
  const r = apply([entry()], entry({ id: "e2", delta: 2, reason: "adjustment", refKey: "adj:1" }));
  assert.equal(r.ok, false);
  const ok = apply([entry()], entry({ id: "e2", delta: 2, reason: "adjustment", refKey: "adj:1", note: "Class cancelled by club, arena closed" }));
  assert.ok(ok.ok);
});

test("entries are never edited: apply returns a new list and leaves the original untouched", () => {
  const original = [entry()];
  const r = apply(original, entry({ id: "e2", delta: -1, reason: "use", refKey: "use:b1" }));
  assert.equal(original.length, 1);
  assert.ok(r.ok && r.entries.length === 2);
});
