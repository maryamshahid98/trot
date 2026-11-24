import { useCallback, useEffect, useState } from 'react';
import { ApiError, get } from '../api/client';

export interface Query<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Loads a path whenever it changes. Pass null to wait (for example until a branch is chosen). */
export function useQuery<T>(path: string | null): Query<T> {
  const [tick, setTick] = useState(0);
  // The latest answer, and which request it answers. While a newer request is running the older data stays on screen.
  const [result, setResult] = useState<{ key: string; data: T | null; error: string | null } | null>(null);
  const key = path === null ? null : `${path}#${tick}`;
  useEffect(() => {
    if (key === null || path === null) return;
    let current = true; // a slower, older request must not overwrite a newer one
    get<T>(path)
      .then((data) => { if (current) setResult({ key, data, error: null }); })
      .catch((e: unknown) => { if (current) setResult((r) => ({ key, data: r?.data ?? null, error: e instanceof ApiError ? e.message : 'Cannot reach the server.' })); });
    return () => { current = false; };
  }, [key, path]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const answered = key !== null && result?.key === key;
  return {
    data: key === null ? null : (result?.data ?? null),
    error: answered ? result.error : null,
    loading: key !== null && !answered,
    reload,
  };
}

export const qs = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const errorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    const extra = e.problems.length ? ` ${e.problems.map((p) => (p.field ? `${p.field} ${p.message}` : p.message)).join('; ')}` : '';
    return `${e.message}${extra}`;
  }
  return 'Cannot reach the server.';
};
