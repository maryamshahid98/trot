import { z } from 'zod';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, LIMITS } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');

export const IdParam = z.object({ id: uuid });
export const CreateIncident = z.object({
  branchId: uuid.optional(),
  severity: z.enum(INCIDENT_SEVERITIES as [string, ...string[]]),
  kind: z.string().trim().min(1).max(LIMITS.incidentKindMax),
  riderId: uuid.optional(),
  horseId: uuid.optional(),
  arenaId: uuid.optional(),
  occurrenceId: uuid.optional(),
  people: z.string().trim().max(LIMITS.notesMax).optional(),
  witnesses: z.string().trim().max(LIMITS.notesMax).optional(),
  immediateAction: z.string().trim().max(LIMITS.notesMax).optional(),
  description: z.string().trim().min(1).max(LIMITS.incidentDescriptionMax),
  occurredAt: isoTime,
});
export const ListIncidents = z.object({
  branchId: uuid.optional(),
  status: z.enum(INCIDENT_STATUSES as [string, ...string[]]).optional(),
  severity: z.enum(INCIDENT_SEVERITIES as [string, ...string[]]).optional(),
  from: isoTime.optional(),
  to: isoTime.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.incidentsListMax).default(LIMITS.incidentsListDefault),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const SetIncidentStatus = z.object({ status: z.enum(INCIDENT_STATUSES as [string, ...string[]]), note: z.string().trim().min(1).max(LIMITS.reasonMax).optional() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date such as 2026-12-01');
export const UpdateIncident = z
  .object({ people: z.string().trim().max(LIMITS.notesMax).nullable(), witnesses: z.string().trim().max(LIMITS.notesMax).nullable(), immediateAction: z.string().trim().max(LIMITS.notesMax).nullable(), riderId: uuid.nullable(), horseId: uuid.nullable(), arenaId: uuid.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'send at least one field to change');
export const AddAction = z.object({ action: z.string().trim().min(1).max(LIMITS.notesMax), ownerId: uuid.optional(), dueOn: day.optional() });
export const CompleteAction = z.object({ note: z.string().trim().min(1, 'say what was done').max(LIMITS.reasonMax) });
export const ActionParams = z.object({ id: uuid, actionId: uuid });
export const FileParams = z.object({ id: uuid, fileId: uuid });
