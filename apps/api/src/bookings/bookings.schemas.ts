import { z } from 'zod';
import { CANCEL_CAUSE, CANCEL_CAUSES, CLASS_CANCEL_CAUSES, LIMITS, PAY_WITH, PAY_WITH_VALUES } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

export const IdParam = z.object({ id: uuid });

/** How a booking is paid. A package is named when paying with one, and never when paying at the office. */
const payment = { payWith: z.enum(PAY_WITH_VALUES), packageId: uuid.optional() };
const packageMatchesPayWith = (v: { payWith: string; packageId?: string }, ctx: z.RefinementCtx) => {
  if (v.payWith === PAY_WITH.PACKAGE && !v.packageId) ctx.addIssue({ code: 'custom', path: ['packageId'], message: 'is required when paying with a package' });
  if (v.payWith === PAY_WITH.OFFICE && v.packageId) ctx.addIssue({ code: 'custom', path: ['packageId'], message: 'must not be given when paying at the office' });
};

export const CreateBooking = z.object({ occurrenceId: uuid, riderId: uuid, ...payment }).superRefine(packageMatchesPayWith);
export const CancelBooking = z.object({ cause: z.enum(CANCEL_CAUSES).optional() });
export const RosterQuery = z.object({ occurrenceId: uuid });

export const AcceptOffer = z.object(payment).superRefine(packageMatchesPayWith);
export const CompleteClass = z.object({ markRemainingNoShow: z.boolean().default(false) });
export const CancelClass = z.object({
  reason: z.string().trim().min(1, 'a reason is required').max(LIMITS.reasonMax),
  cause: z.enum(CLASS_CANCEL_CAUSES).default(CANCEL_CAUSE.CLUB),
});
