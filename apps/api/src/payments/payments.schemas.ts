import { z } from 'zod';
import { ADJUSTMENT_KINDS, CLASS_FORMATS, LIMITS, PAYMENT_METHODS, SETTABLE_PACKAGE_STATUSES } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const reason = z.string().trim().min(1, 'a reason is required').max(LIMITS.reasonMax);
const money = z.number().int().min(0).max(LIMITS.priceMaxMinor);
const isoDay = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date such as 2026-12-01');

export const IdParam = z.object({ id: uuid });

const packageTypeFields = {
  name: z.string().trim().min(1).max(LIMITS.packageTypeNameMax),
  classes: z.number().int().min(1).max(LIMITS.packageClassesMax),
  priceMinor: money,
  validDays: z.number().int().min(1).max(LIMITS.packageValidDaysMax),
  classFormats: z.array(z.enum(CLASS_FORMATS)).min(1).max(CLASS_FORMATS.length).refine((a) => new Set(a).size === a.length, 'must not repeat a format'),
};
export const CreatePackageType = z.object({ branchId: uuid.optional(), ...packageTypeFields });
export const UpdatePackageType = z
  .object({ ...packageTypeFields, active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const ListPackageTypes = z.object({ branchId: uuid.optional(), includeInactive: z.enum(['true', 'false']).default('false') });

export const SellPackage = z.object({ packageTypeId: uuid, method: z.enum(PAYMENT_METHODS), amountMinor: money.optional() });
export const AdjustPackage = z.object({
  delta: z.number().int().min(-LIMITS.adjustClassesMax).max(LIMITS.adjustClassesMax).refine((n) => n !== 0, 'must not be zero'),
  reason,
});
export const SetPackageStatus = z.object({ status: z.enum(SETTABLE_PACKAGE_STATUSES), reason });

export const RecordPayment = z.object({ method: z.enum(PAYMENT_METHODS), amountMinor: money });
export const ConfirmUnpaid = z.object({ reason });

export const ListReceipts = z.object({
  branchId: uuid.optional(),
  riderId: uuid.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.receiptsListMax).default(LIMITS.receiptsListDefault),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const CreateAdjustment = z.object({
  kind: z.enum(ADJUSTMENT_KINDS),
  amountMinor: z.number().int().refine((n) => n !== 0, 'must not be zero').refine((n) => Math.abs(n) <= LIMITS.priceMaxMinor, 'is too large'),
  reason,
});
