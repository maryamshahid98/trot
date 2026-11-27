import { z } from 'zod';
import { DECISIONS, HORSE_SELECTION_MODES, LEVELS, LIMITS, POLICY_BOUNDS, POLICY_FLAGS } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');
const reason = z.string().trim().min(1, 'a reason is required').max(LIMITS.reasonMax);
const knownZone = (z0: string) => {
  try { new Intl.DateTimeFormat('en', { timeZone: z0 }); return true; } catch { return false; }
};

export const IdParam = z.object({ id: uuid });
export const ClosureParams = z.object({ id: uuid, closureId: uuid });
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time such as 08:00');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date such as 2026-12-01').refine((s) => !Number.isNaN(Date.parse(s)), 'must be a real date');
const branchFields = {
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  timeZone: z.string().trim().min(1).max(64).refine(knownZone, 'is not a known time zone, for example Asia/Riyadh'),
  address: z.string().trim().max(300).nullable(),
  opensAt: clock.nullable(),
  closesAt: clock.nullable(),
  holidays: z.array(isoDate).max(100),
};
export const CreateBranch = z.object({ name: branchFields.name, timeZone: branchFields.timeZone, currency: z.string().regex(/^[A-Z]{3}$/, 'must be a currency code such as SAR').default('SAR'), address: branchFields.address.optional() });
const text = (max: number) => z.string().trim().max(max).nullable();
export const UpdateOrganisation = z
  .object({ name: z.string().trim().min(1).max(LIMITS.nameMax), legalName: text(200), taxNumber: text(40), address: text(300), phone: text(40), email: text(LIMITS.identifierMax), logoUrl: z.string().max(70_000).regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, 'must be a small PNG or JPEG picture').nullable(),
    defaultCurrency: z.string().regex(/^[A-Z]{3}$/, 'must be a currency code such as SAR'), defaultTimeZone: z.string().trim().max(64).refine(knownZone, 'is not a known time zone'), languages: z.array(z.enum(['en', 'ar'])).min(1) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const UpdateBranch = z
  .object(branchFields)
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
const words = z.string().trim().max(200).nullable().optional();
const metres = z.number().positive().max(1000).nullable().optional();
const arenaDetails = { kind: words, surface: words, activities: words, lengthM: metres, widthM: metres, sharedUse: z.boolean().optional(), opensAt: clock.nullable().optional(), closesAt: clock.nullable().optional() };
const supportedLevels = z.array(z.enum(LEVELS)).min(1, 'choose at least one level').max(LEVELS.length);
export const CreateArena = z.object({ ...arenaDetails, branchId: uuid.optional(), name: z.string().trim().min(1).max(LIMITS.arenaNameMax), maxCapacity: z.number().int().min(1).max(LIMITS.arenaCapacityMax), supportedLevels: supportedLevels.optional() });
export const UpdateArena = z
  .object({ name: z.string().trim().min(1).max(LIMITS.arenaNameMax), maxCapacity: z.number().int().min(1).max(LIMITS.arenaCapacityMax), supportedLevels, ...arenaDetails })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const CreateClosure = z.object({ from: isoTime, to: isoTime, reason });

export const CreateLeave = z.object({ staffId: uuid.optional(), from: isoTime, to: isoTime, reason: z.string().trim().max(LIMITS.reasonMax).optional() });
export const ListLeave = z.object({ staffId: uuid.optional(), status: z.enum(['requested', 'approved', 'rejected']).optional(), from: isoTime.optional(), to: isoTime.optional() });
export const DecideLeave = z.object({ decision: z.enum([DECISIONS.APPROVE, DECISIONS.REJECT]), reason: reason.optional() });
