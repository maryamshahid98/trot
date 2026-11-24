import { z } from 'zod';
import { DECISIONS, HORSE_SELECTION_MODES, LIMITS, POLICY_BOUNDS, POLICY_FLAGS } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');
const reason = z.string().trim().min(1, 'a reason is required').max(LIMITS.reasonMax);
const knownZone = (z0: string) => {
  try { new Intl.DateTimeFormat('en', { timeZone: z0 }); return true; } catch { return false; }
};

export const IdParam = z.object({ id: uuid });
export const ClosureParams = z.object({ id: uuid, closureId: uuid });
export const UpdateBranch = z
  .object({ name: z.string().trim().min(1).max(LIMITS.nameMax), timeZone: z.string().trim().min(1).max(64).refine(knownZone, 'is not a known time zone, for example Asia/Riyadh') })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');

/** Each setting may be sent as a value, or as null to go back to the club default. Anything not listed is refused. */
const num = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max).nullable().optional();
const policyShape: Record<string, z.ZodTypeAny> = { horseSelection: z.enum(HORSE_SELECTION_MODES).nullable().optional() };
for (const [k, b] of Object.entries(POLICY_BOUNDS)) policyShape[k] = num(b);
for (const k of POLICY_FLAGS) policyShape[k] = z.boolean().nullable().optional();
export const UpdatePolicy = z
  .object(policyShape)
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'send at least one setting');

export const ListArenas = z.object({ branchId: uuid.optional() });
export const CreateArena = z.object({ branchId: uuid.optional(), name: z.string().trim().min(1).max(LIMITS.arenaNameMax), maxCapacity: z.number().int().min(1).max(LIMITS.arenaCapacityMax) });
export const UpdateArena = z
  .object({ name: z.string().trim().min(1).max(LIMITS.arenaNameMax), maxCapacity: z.number().int().min(1).max(LIMITS.arenaCapacityMax) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const CreateClosure = z.object({ from: isoTime, to: isoTime, reason });

export const CreateLeave = z.object({ staffId: uuid.optional(), from: isoTime, to: isoTime, reason: z.string().trim().max(LIMITS.reasonMax).optional() });
export const ListLeave = z.object({ staffId: uuid.optional(), status: z.enum(['requested', 'approved', 'rejected']).optional(), from: isoTime.optional(), to: isoTime.optional() });
export const DecideLeave = z.object({ decision: z.enum([DECISIONS.APPROVE, DECISIONS.REJECT]), reason: reason.optional() });
