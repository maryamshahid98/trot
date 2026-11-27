import { API_URL, CLIENT_HEADER, HTTP } from '../constants';
import type { Role } from '../constants';

export interface Problem { field: string; message: string }
export class ApiError extends Error {
  constructor(public status: number, message: string, public problems: Problem[] = []) { super(message); }
}
export interface SessionUser { id: string; role: Role; /** The account's own role when it differs from the one its screens are built from. */ title?: Role; actsAs?: Role; fullName: string | null; locale?: string; theme?: string; branchIds: string[]; mfaEnabled?: boolean; mfaEnrollmentRequired?: boolean }
interface LoginResult { accessToken: string; expiresIn: number; user: SessionUser }

// The access token lives only in memory. The refresh token is an HttpOnly cookie the browser sends by itself,
// so no script on the page (including a malicious one) can read it.
let accessToken: string | null = null;
let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn; };
export const setAccessToken = (t: string | null) => { accessToken = t; };

async function raw(method: string, path: string, body?: unknown, token = accessToken): Promise<Response> {
  const headers: Record<string, string> = { [CLIENT_HEADER.name]: CLIENT_HEADER.value };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API_URL}${path}`, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) });
}

async function toError(res: Response): Promise<ApiError> {
  let data: { message?: string; problems?: Problem[] } = {};
  try { data = await res.json(); } catch { /* an empty or non-JSON error body */ }
  return new ApiError(res.status, data.message ?? res.statusText, data.problems ?? []);
}

/** One refresh at a time: if several requests fail together they share the same new token. */
let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await raw('POST', '/auth/refresh', {}, null);
      if (!res.ok) return false;
      accessToken = ((await res.json()) as { accessToken: string }).accessToken;
      return true;
    } catch { return false; }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await raw(method, path, body);
  if (res.status === HTTP.UNAUTHORIZED && accessToken && (await refreshSession())) res = await raw(method, path, body);
  if (res.status === HTTP.UNAUTHORIZED && accessToken) { setAccessToken(null); onSignedOut(); }
  if (!res.ok) throw await toError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function rawBinary(method: string, path: string, body?: Blob, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { [CLIENT_HEADER.name]: CLIENT_HEADER.value, ...headers };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return fetch(`${API_URL}${path}`, { method, headers: h, credentials: 'include', body });
}
async function binary(method: string, path: string, body?: Blob, headers?: Record<string, string>): Promise<Response> {
  let res = await rawBinary(method, path, body, headers);
  if (res.status === HTTP.UNAUTHORIZED && accessToken && (await refreshSession())) res = await rawBinary(method, path, body, headers);
  if (res.status === HTTP.UNAUTHORIZED && accessToken) { setAccessToken(null); onSignedOut(); }
  if (!res.ok) throw await toError(res);
  return res;
}
/** Sends a file as the request body. The server checks what it really is, whatever the name or type says. */
export const uploadFile = (path: string, file: File) => binary('PUT', path, file, { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) });
/** Fetches a file the person is allowed to see. A plain link cannot do this, because the sign-in token is not a cookie. */
export async function fetchFile(path: string): Promise<{ blob: Blob; type: string }> {
  const res = await binary('GET', path);
  const blob = await res.blob();
  return { blob, type: blob.type };
}
export const get = <T,>(path: string) => api<T>('GET', path);
export const post = <T,>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});

/** The password was right: either the person is in, or a code from their authenticator app is still needed (mfaToken carries the first step). */
export type LoginOutcome = { user: SessionUser } | { mfaToken: string };
export async function login(identifier: string, password: string): Promise<LoginOutcome> {
  const res = await raw('POST', '/auth/login', { identifier, password }, null);
  if (!res.ok) throw await toError(res);
  const d = (await res.json()) as LoginResult & { mfaRequired?: boolean; mfaToken?: string };
  if (d.mfaRequired && d.mfaToken) return { mfaToken: d.mfaToken };
  accessToken = d.accessToken;
  return { user: d.user };
}

/** The second step: a code from the app, or a recovery code. */
export async function loginWithCode(mfaToken: string, entry: { code?: string; recoveryCode?: string }): Promise<SessionUser> {
  const res = await raw('POST', '/auth/mfa/verify', { mfaToken, ...entry }, null);
  if (!res.ok) throw await toError(res);
  const d = (await res.json()) as LoginResult;
  accessToken = d.accessToken;
  return d.user;
}

/** Called when the page opens: if the browser still has a valid cookie, the person is signed in again without typing. */
export async function restoreSession(): Promise<SessionUser | null> {
  if (!(await refreshSession())) return null;
  try { return await get<SessionUser>('/auth/me'); } catch { return null; }
}

export async function logout(): Promise<void> {
  setAccessToken(null);
  try { await raw('POST', '/auth/logout', {}, null); } catch { /* signed out here either way */ }
}
