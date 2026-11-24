import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { get, login as apiLogin, loginWithCode, logout as apiLogout, restoreSession, setSignedOutHandler } from '../api/client';
import type { SessionUser } from '../api/client';
import { STAFF_ROLES, STORAGE } from '../constants';

export interface Branch { id: string; name: string; timeZone: string; currency: string; active: boolean }
interface AuthState {
  user: SessionUser | null; ready: boolean; branches: Branch[]; branchId: string | null;
  setBranchId: (id: string) => void; signOut: () => Promise<void>;
  /** Checks the password. Resolves to the token for the second step when a code is also needed, or to null when the person is in. */
  signIn: (identifier: string, password: string) => Promise<string | null>;
  /** The second step of signing in. */
  signInWithCode: (mfaToken: string, entry: { code?: string; recoveryCode?: string }) => Promise<void>;
  /** Reads who is signed in again (for example after two-step sign-in was set up) and opens the rest of the portal. */
  refreshUser: () => Promise<void>;
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
      if (u && STAFF_ROLES.includes(u.role)) { setUser(u); if (!u.mfaEnrollmentRequired) await loadBranches(u).catch(() => {}); }
      setReady(true);
    })();
  }, [loadBranches]);

  /** Someone is signed in. Staff only; and if the club requires two-step sign-in and it is not set up, the branches are not loaded yet (the API would refuse). */
  const enter = useCallback(async (basic: SessionUser) => {
    if (!STAFF_ROLES.includes(basic.role)) { await apiLogout(); throw new NotStaffError(); }
    const u = await get<SessionUser>('/auth/me').catch(() => basic); // the sign-in answer does not say whether two-step sign-in is on
    setUser(u);
    if (!u.mfaEnrollmentRequired) await loadBranches(u);
  }, [loadBranches]);

  const signIn = useCallback(async (identifier: string, password: string): Promise<string | null> => {
    const outcome = await apiLogin(identifier, password);
    if ('mfaToken' in outcome) return outcome.mfaToken;
    await enter(outcome.user);
    return null;
  }, [enter]);

  const signInWithCode = useCallback(async (mfaToken: string, entry: { code?: string; recoveryCode?: string }) => {
    await enter(await loginWithCode(mfaToken, entry));
  }, [enter]);

  const refreshUser = useCallback(async () => {
    const u = await get<SessionUser>('/auth/me');
    setUser(u);
    if (!u.mfaEnrollmentRequired) await loadBranches(u).catch(() => {});
  }, [loadBranches]);

  const signOut = useCallback(async () => { await apiLogout(); setUser(null); setBranches([]); setBranch(null); }, []);
  const setBranchId = useCallback((id: string) => { localStorage.setItem(STORAGE.BRANCH, id); setBranch(id); }, []);

  const value = useMemo(() => ({ user, ready, branches, branchId, setBranchId, signIn, signInWithCode, refreshUser, signOut }), [user, ready, branches, branchId, setBranchId, signIn, signInWithCode, refreshUser, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
