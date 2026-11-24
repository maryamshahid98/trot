import { z } from 'zod';
import { LIMITS } from '../config/constants.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T00:00:00+03:00');

export const RangeQuery = z.object({ branchId: uuid.optional(), from: isoTime, to: isoTime });
export const UnpaidQuery = z.object({ branchId: uuid.optional(), limit: z.coerce.number().int().min(1).max(LIMITS.reportListMax).default(LIMITS.reportListMax) });
export const AuditQuery = z.object({
  branchId: uuid.optional(),
  action: z.string().trim().min(1).max(LIMITS.actionMax).optional(),
  entity: z.string().trim().min(1).max(LIMITS.actionMax).optional(),
  entityId: z.string().trim().min(1).max(100).optional(),
  actorId: uuid.optional(),
  from: isoTime.optional(),
  to: isoTime.optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.auditListMax).default(LIMITS.auditListDefault),
});
