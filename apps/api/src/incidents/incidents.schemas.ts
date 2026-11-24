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
