import { z } from 'zod';
import { CREATABLE_OCCURRENCE_STATUSES, LEVELS, LIMITS, OCCURRENCE_STATUS } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date such as 2026-12-01').refine((s) => !Number.isNaN(Date.parse(s)), 'must be a real date');

const fields = {
  name: z.string().trim().min(1).max(LIMITS.rideTypeNameMax),
  description: z.string().trim().max(LIMITS.rideDescriptionMax).nullable(),
  priceMinor: z.number().int().min(0).max(LIMITS.priceMaxMinor),
  durationMinutes: z.number().int().min(LIMITS.rideDurationMinMinutes).max(LIMITS.rideDurationMaxMinutes),
  capacity: z.number().int().min(1).max(LIMITS.arenaCapacityMax),
  minLevel: z.enum(LEVELS),
  minAgeYears: z.number().int().min(0).max(LIMITS.rideMinAgeMax).nullable(),
  activeFrom: isoDay.nullable(),
  activeTo: isoDay.nullable(),
};

export const IdParam = z.object({ id: uuid });
export const ListRideTypes = z.object({ branchId: uuid.optional(), includeInactive: z.enum(['true', 'false']).default('true') });

export const CreateRideType = z.object({
  branchId: uuid.optional(),
  name: fields.name,
  description: fields.description.optional(),
  priceMinor: fields.priceMinor,
  durationMinutes: fields.durationMinutes,
  capacity: fields.capacity,
  minLevel: fields.minLevel.default(LEVELS[0]),
  minAgeYears: fields.minAgeYears.optional(),
  activeFrom: fields.activeFrom.optional(),
  activeTo: fields.activeTo.optional(),
});

export const UpdateRideType = z
  .object({ ...fields, active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');

/** A ride is scheduled from a ride type: the type sets the price, length, level and minimum age. */
export const CreateRide = z.object({
  branchId: uuid.optional(),
  rideTypeId: uuid,
  /** The route or location. Rides use the branch's arena list for places (Beach, Desert trail, Main arena...). */
  arenaId: uuid,
  /** The guide or instructor. */
  coachId: uuid,
  startsAt: isoTime,
  /** Optional. Never more than the ride type allows. */
  capacity: z.number().int().min(1).optional(),
  status: z.enum(CREATABLE_OCCURRENCE_STATUSES).default(OCCURRENCE_STATUS.PUBLISHED),
  override: z.object({ reason: z.string().trim().min(1, 'a reason is required').max(LIMITS.overrideReasonMax) }).optional(),
});
