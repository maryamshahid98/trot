import type { Policy } from "./policy.ts";
import { MS } from "./policy.ts";

export type WaitlistStatus = "active" | "offered" | "converted" | "expired" | "declined" | "removed";

export interface WaitlistEntry {
  id: string;
  riderId: string;
  occurrenceId: string;
  joinedAt: number;
  status: WaitlistStatus;
  offeredAt?: number;
  offerExpiresAt?: number;
}

/** Offers that were not answered in time go back to "expired" so the next person can be offered the place. */
export function expireOffers(entries: readonly WaitlistEntry[], now: number): WaitlistEntry[] {
  return entries.map((e) => (e.status === "offered" && e.offerExpiresAt !== undefined && e.offerExpiresAt <= now ? { ...e, status: "expired" as const } : e));
}

/** First in line who is still eligible. `isEligible` re-checks rules now (documents may have expired while waiting). */
export function nextToOffer(entries: readonly WaitlistEntry[], isEligible: (riderId: string) => boolean): WaitlistEntry | undefined {
  return [...entries]
    .filter((e) => e.status === "active")
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
    .find((e) => isEligible(e.riderId));
}

export function makeOffer(e: WaitlistEntry, now: number, policy: Policy): WaitlistEntry {
  return { ...e, status: "offered", offeredAt: now, offerExpiresAt: now + policy.waitlistOfferMinutes * MS.minute };
}

/** Accepting an offer works only before it expires. */
export function canAccept(e: WaitlistEntry, now: number): boolean {
  return e.status === "offered" && e.offerExpiresAt !== undefined && e.offerExpiresAt > now;
}
