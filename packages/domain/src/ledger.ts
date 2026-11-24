import type { LedgerEntry } from "./types.ts";

/** Package balance is always the sum of entries. There is no stored balance to drift. */
export function balance(entries: readonly LedgerEntry[], packageId: string): number {
  return entries.filter((e) => e.packageId === packageId).reduce((s, e) => s + e.delta, 0);
}

export type ApplyResult =
  | { ok: true; entries: LedgerEntry[]; duplicate: boolean }
  | { ok: false; code: "INSUFFICIENT_BALANCE" | "ZERO_DELTA" | "NOTE_REQUIRED"; message: string };

/**
 * Append an entry. The ledger is append-only: nothing is edited or deleted, mistakes are fixed with a new entry.
 * Applying the same refKey twice is a no-op (idempotent), so retries and double-clicks cannot double-charge or double-refund.
 */
export function apply(entries: readonly LedgerEntry[], next: LedgerEntry): ApplyResult {
  if (entries.some((e) => e.packageId === next.packageId && e.refKey === next.refKey)) {
    return { ok: true, entries: [...entries], duplicate: true };
  }
  if (next.delta === 0) return { ok: false, code: "ZERO_DELTA", message: "An entry must change the balance." };
  if (next.reason === "adjustment" && !next.note?.trim()) {
    return { ok: false, code: "NOTE_REQUIRED", message: "Adjustments need a written reason." };
  }
  if (balance(entries, next.packageId) + next.delta < 0) {
    return { ok: false, code: "INSUFFICIENT_BALANCE", message: "Not enough classes left in this package." };
  }
  return { ok: true, entries: [...entries, next], duplicate: false };
}
