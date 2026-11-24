import type { Booking, Occurrence } from "./types.ts";
import type { Policy } from "./policy.ts";
import { holdsPlace } from "./eligibility.ts";

export function spotsLeft(occ: Occurrence, bookings: readonly Booking[], now: number, policy: Policy): number {
  const taken = bookings.filter((b) => b.occurrenceId === occ.id && holdsPlace(b, now, policy)).length;
  return Math.max(0, occ.capacity - taken);
}

export type Placement = "confirmed" | "pending_office_payment" | "waitlisted";

/**
 * Decide what happens to an eligible booking request.
 * IMPORTANT: this is only correct if the caller holds a lock on the occurrence row while it counts and inserts
 * (see db/migrations). Two people asking for the last place must be decided one after the other.
 */
export function place(
  occ: Occurrence,
  bookings: readonly Booking[],
  payWith: "package" | "office",
  now: number,
  policy: Policy,
): Placement {
  if (spotsLeft(occ, bookings, now, policy) === 0) return "waitlisted";
  return payWith === "office" ? "pending_office_payment" : "confirmed";
}

/** OD-14: an unpaid office booking may only be confirmed by a manager when the club allows it. */
export function canConfirmUnpaid(role: "reception" | "manager" | "owner", policy: Policy): boolean {
  return policy.allowManagerUnpaidConfirmation && (role === "manager" || role === "owner");
}
