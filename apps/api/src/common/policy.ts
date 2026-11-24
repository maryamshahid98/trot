import { DEFAULT_POLICY } from '@trot/domain';
import type { Policy } from '@trot/domain';
import type { Tx } from '../bookings/core.ts';
import { HORSE_SELECTION_MODES, POLICY_BOUNDS, POLICY_FLAGS } from '../config/constants.ts';

/**
 * The rules in force for one branch: its saved settings laid over the club defaults.
 * Anything missing or not valid in the saved data is ignored, so a bad row can never switch a rule off by accident.
 */
export function effectivePolicy(stored: unknown): Policy {
  const out: Record<string, unknown> = { ...DEFAULT_POLICY };
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const s = stored as Record<string, unknown>;
    for (const [key, b] of Object.entries(POLICY_BOUNDS)) {
      const v = s[key];
      if (typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max) out[key] = v;
    }
    for (const key of POLICY_FLAGS) if (typeof s[key] === 'boolean') out[key] = s[key];
    if ((HORSE_SELECTION_MODES as readonly string[]).includes(s.horseSelection as string)) out.horseSelection = s.horseSelection;
  }
  return out as unknown as Policy;
}

export async function loadPolicy(c: Tx, branchId: string): Promise<Policy> {
  const r = await c.query(`SELECT policy FROM branches WHERE id = $1`, [branchId]);
  return effectivePolicy(r.rows[0]?.policy);
}
