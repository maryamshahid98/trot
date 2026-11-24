import { useAuth } from '../auth/AuthContext';
import type { Branch } from '../auth/AuthContext';
import { setZone } from './format';

/** The branch the person is working in. Sets the club's time zone so every time on screen is club time. */
export function useBranch(): { branchId: string | null; branch: Branch | null; currency: string } {
  const { branches, branchId } = useAuth();
  const branch = branches.find((b) => b.id === branchId) ?? null;
  if (branch) setZone(branch.timeZone);
  return { branchId, branch, currency: branch?.currency ?? 'SAR' };
}

export interface Option { value: string; label: string }
