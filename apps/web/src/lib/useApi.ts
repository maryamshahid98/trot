import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get } from '../api/client';

export interface Query<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Loads a path whenever it changes. Pass null to wait (for example until a branch is chosen). */
export function useQuery<T>(path: string | null): Query<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    if (path === null) { setData(null); setLoading(false); return; }
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    get<T>(path)
      .then((d) => { if (id === latest.current) setData(d); })
      .catch((e: unknown) => { if (id === latest.current) setError(e instanceof ApiError ? e.message : 'Cannot reach the server.'); })
      .finally(() => { if (id === latest.current) setLoading(false); });
  }, [path, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
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
