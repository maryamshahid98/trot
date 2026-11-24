import type { Booking, Occurrence } from "./types.ts";
import type { Policy } from "./policy.ts";
import { MS } from "./policy.ts";

export type CancelCause = "customer" | "club" | "weather";

export interface CancelDecision {
  allowed: boolean;
  /** True when the class is used up even though the booking is cancelled. */
  consumesClass: boolean;
  /** True when one package class goes back to the rider. */
  returnsPackageClass: boolean;
  reason: string;
}

export function decideCancellation(b: Booking, occ: Occurrence, now: number, cause: CancelCause, policy: Policy): CancelDecision {
  const no = (reason: string): CancelDecision => ({ allowed: false, consumesClass: false, returnsPackageClass: false, reason });
  if (b.status !== "pending_office_payment" && b.status !== "confirmed") return no("Only upcoming bookings can be cancelled.");

  const fromPackage = b.payWith === "package" && b.status === "confirmed";

  // Club and weather cancellations never cost the rider anything, even after the class has started.
  if (cause !== "customer") {
    return { allowed: true, consumesClass: false, returnsPackageClass: fromPackage, reason: cause === "weather" ? "Cancelled by the club (weather)." : "Cancelled by the club." };
  }

  if (occ.startsAt <= now) return no("The class has started. It will be marked as attended or a no-show.");

  const free = now <= occ.startsAt - policy.freeCancelHoursBefore * MS.hour;
  if (free || !policy.lateCancelConsumesClass) {
    return { allowed: true, consumesClass: false, returnsPackageClass: fromPackage, reason: free ? "Cancelled in time." : "Late cancellation (no charge under current rules)." };
  }
  return { allowed: true, consumesClass: true, returnsPackageClass: false, reason: "Late cancellation: the class is used." };
}

export function decideNoShow(b: Booking, policy: Policy): { consumesClass: boolean } {
  return { consumesClass: policy.noShowConsumesClass && (b.payWith === "package" || b.payWith === "office") };
}
