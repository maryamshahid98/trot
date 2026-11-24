import { useQuery, qs } from '../lib/useApi';
import { useBranch } from '../lib/branch';
import type { Option } from '../lib/branch';
import type { Arena, Staff } from '../lib/types';
import { label } from '../lib/format';

export const opts = (list: readonly string[]): Option[] => list.map((v) => ({ value: v, label: label(v) }));

/** Arenas, coaches and the like, loaded for the current branch as dropdown options. */
export function useArenas() {
  const { branchId } = useBranch();
  const q = useQuery<{ arenas: Arena[] }>(branchId ? `/arenas${qs({ branchId })}` : null);
  return { ...q, options: (q.data?.arenas ?? []).map((a) => ({ value: a.id, label: `${a.name} (up to ${a.maxCapacity})` })) };
}
export function useStaff(role?: string) {
  const { branchId } = useBranch();
  const q = useQuery<{ staff: Staff[] }>(branchId ? `/staff${qs({ branchId, role })}` : null);
  return { ...q, options: (q.data?.staff ?? []).map((s) => ({ value: s.id, label: `${s.fullName} · ${label(s.role)}` })) };
}
