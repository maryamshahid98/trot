import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { get, login as apiLogin, logout as apiLogout, restoreSession, setSignedOutHandler } from '../api/client';
import type { SessionUser } from '../api/client';
import { STAFF_ROLES, STORAGE } from '../constants';

export interface Branch { id: string; name: string; timeZone: string; currency: string; active: boolean }
interface AuthState {
  user: SessionUser | null; ready: boolean; branches: Branch[]; branchId: string | null;
  setBranchId: (id: string) => void; signIn: (identifier: string, password: string) => Promise<void>; signOut: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);
export const useAuth = (): AuthState => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
};
export class NotStaffError extends Error {}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranch] = useState<string | null>(null);

  const loadBranches = useCallback(async (u: SessionUser) => {
    const { branches: list } = await get<{ branches: Branch[] }>('/branches');
    setBranches(list);
    const saved = localStorage.getItem(STORAGE.BRANCH);
    setBranch(list.find((b) => b.id === saved)?.id ?? list.find((b) => u.branchIds.includes(b.id))?.id ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => { setUser(null); setBranches([]); setBranch(null); });
    (async () => {
      const u = await restoreSession();
      if (u && STAFF_ROLES.includes(u.role)) { setUser(u); await loadBranches(u).catch(() => {}); }
      setReady(true);
    })();
  }, [loadBranches]);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const u = await apiLogin(identifier, password);
    if (!STAFF_ROLES.includes(u.role)) { await apiLogout(); throw new NotStaffError(); }
    setUser(u);
    await loadBranches(u);
  }, [loadBranches]);

  const signOut = useCallback(async () => { await apiLogout(); setUser(null); setBranches([]); setBranch(null); }, []);
  const setBranchId = useCallback((id: string) => { localStorage.setItem(STORAGE.BRANCH, id); setBranch(id); }, []);

  const value = useMemo(() => ({ user, ready, branches, branchId, setBranchId, signIn, signOut }), [user, ready, branches, branchId, setBranchId, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
