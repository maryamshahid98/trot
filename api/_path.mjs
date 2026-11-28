// The website serves the API under /api. This gives the API back the address it knows, whether the host passes the original
// address ("/api/auth/login") or the rewritten one ("/api/index?__path=auth/login").
import { URL } from 'node:url';

export function restorePath(url = '/') {
  const u = new URL(url, 'http://local');
  const rewritten = u.searchParams.get('__path');
  u.searchParams.delete('__path');
  const path = rewritten === null ? u.pathname.replace(/^\/api(?=\/|$)/, '') : `/${rewritten.replace(/^\/+/, '')}`;
  return `${path || '/'}${u.search}`;
}
