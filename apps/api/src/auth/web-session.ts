import { CLIENT_HEADER, CLIENT_WEB, REFRESH_COOKIE } from '../config/constants.ts';
import type { ApiRequest, ApiResponse } from '../common/http.ts';

/** True when the request comes from the Trot website, which keeps its refresh token in a cookie. */
export const isWebClient = (req: ApiRequest): boolean => req.headers?.[CLIENT_HEADER] === CLIENT_WEB;

/** Reads one cookie from the request without needing a cookie library. */
export function readCookie(req: ApiRequest, name: string): string | undefined {
  const header: string | undefined = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export interface CookieSettings { cookieSecure: boolean; publicApiPath: string }

// The browser sends the cookie only to the sign-in addresses, as the browser sees them (under publicApiPath if there is one).
const base = (s: CookieSettings) => ({ httpOnly: true, secure: s.cookieSecure, sameSite: REFRESH_COOKIE.sameSite, path: `${s.publicApiPath}${REFRESH_COOKIE.path}` });

export function setRefreshCookie(res: ApiResponse, token: string, ttlDays: number, s: CookieSettings): void {
  res.cookie(REFRESH_COOKIE.name, token, { ...base(s), maxAge: ttlDays * 86_400_000 });
}
export function clearRefreshCookie(res: ApiResponse, s: CookieSettings): void {
  res.clearCookie(REFRESH_COOKIE.name, base(s));
}
