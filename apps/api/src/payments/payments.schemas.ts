import { z } from 'zod';
import { ADJUSTMENT_KINDS, CLASS_FORMATS, LEVELS, LIMITS, OFFICE_METHODS, PAYMENT_METHODS, SETTABLE_PACKAGE_STATUSES } from '../config/constants.ts';
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
  classFormats: z.array(z.enum(CLASS_FORMATS)).max(CLASS_FORMATS.length).refine((a) => new Set(a).size === a.length, 'must not repeat a format'),
};
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time such as 08:00').nullable();
/** Where else the package may or may not be used (PKG-002, PKG-006, RIDE-007). */
const packageLimits = { rideTypeIds: z.array(uuid).max(50).optional(), arenaIds: z.array(uuid).max(50).optional(), levels: z.array(z.enum(LEVELS)).optional(), fromTime: clock.optional(), toTime: clock.optional(), family: z.boolean().optional() };
export const CreatePackageType = z.object({ branchId: uuid.optional(), ...packageTypeFields, ...packageLimits })
  .refine((v) => v.classFormats.length > 0 || (v.rideTypeIds?.length ?? 0) > 0, { message: 'choose at least one', path: ['classFormats'] });
export const UpdatePackageType = z
  .object({ ...packageTypeFields, ...packageLimits, active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const ListPackageTypes = z.object({ branchId: uuid.optional(), includeInactive: z.enum(['true', 'false']).default('false') });

const terminalRef = z.string().trim().min(1).max(64).optional();
export const SellPackage = z.object({ packageTypeId: uuid, method: z.enum(OFFICE_METHODS), amountMinor: money.optional(), terminalRef });
export const AdjustPackage = z.object({
  delta: z.number().int().min(-LIMITS.adjustClassesMax).max(LIMITS.adjustClassesMax).refine((n) => n !== 0, 'must not be zero'),
  reason,
});
export const SetPackageStatus = z.object({ status: z.enum(SETTABLE_PACKAGE_STATUSES), reason });

export const RecordPayment = z.object({ method: z.enum(OFFICE_METHODS), amountMinor: money, terminalRef });
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
