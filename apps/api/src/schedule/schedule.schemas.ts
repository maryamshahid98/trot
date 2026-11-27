import { z } from 'zod';
import { CLASS_FORMATS, CREATABLE_OCCURRENCE_STATUSES, LEVELS, LIMITS, OCCURRENCE_STATUS, SCHEDULE_KINDS, UUID_RE } from '../config/constants.ts';

export const uuid = z.string().regex(UUID_RE, 'must be an id');
const isoTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');

export const ListQuery = z.object({ branchId: uuid.optional(), from: isoTime, to: isoTime, kind: z.enum(SCHEDULE_KINDS as [string, ...string[]]).optional() });

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must look like 2026-12-31');

export const CreateClass = z.object({
  branchId: uuid,
  title: z.string().trim().min(1).max(LIMITS.titleMax),
  arenaId: uuid,
  coachId: uuid,
  format: z.enum(CLASS_FORMATS),
  minLevel: z.enum(LEVELS).default(LEVELS[0]),
  status: z.enum(CREATABLE_OCCURRENCE_STATUSES).default(OCCURRENCE_STATUS.PUBLISHED),
  startsAt: isoTime,
  endsAt: isoTime,
  capacity: z.number().int(),
  priceMinor: z.number().int().min(0).default(0),
  /** The catalogue entry this class is made from: its age limits, cancellation rule and one-off flag are copied. */
  classTypeId: uuid.optional(),
  // Who is overriding is the signed-in user, never a field the caller can fill in.
  override: z.object({ reason: z.string().trim().min(1, 'a reason is required').max(LIMITS.overrideReasonMax) }).optional(),
});

/** A class that repeats. Either a number of sessions or a last date, never both. The first session is the one described by startsAt and endsAt. */
export const CreateSeries = CreateClass.extend({
  repeat: z
    .object({
      everyWeeks: z.number().int().min(1).max(4).default(1),
      count: z.number().int().min(2).max(LIMITS.seriesMaxSessions).optional(),
      until: dateOnly.optional(),
    })
    .refine((r) => (r.count === undefined) !== (r.until === undefined), 'give either count or until, not both and not neither'),
  /** Save the dates that work and report the ones that clash, instead of refusing the whole series. */
  skipConflicts: z.boolean().default(false),
  /** Check only: report what would happen without saving anything. */
  dryRun: z.boolean().default(false),
});

const override = z.object({ reason: z.string().trim().min(1, 'a reason is required').max(LIMITS.overrideReasonMax) }).optional();
export const OccurrenceId = z.object({ id: uuid });
/** Any of these may change while the session has not started. Rides keep their type's price, level and length. */
export const UpdateOccurrence = z
  .object({
    title: z.string().trim().min(1).max(LIMITS.titleMax), arenaId: uuid, coachId: uuid, minLevel: z.enum(LEVELS),
    startsAt: isoTime, endsAt: isoTime, capacity: z.number().int(), priceMinor: z.number().int().min(0).max(LIMITS.priceMaxMinor), override,
  })
  .partial()
  .refine((v) => Object.keys(v).some((k) => k !== 'override'), 'send at least one field to change');
export const PublishOccurrence = z.object({ override });
