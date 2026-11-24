import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { NotStaffError, useAuth } from '../auth/AuthContext';
import { PATH, SIGNIN_PHOTO } from '../constants';
import { t } from '../i18n';
import { Logo } from '../ui/Logo';

const TOO_MANY = 429;

export function Login() {
  const { user, signIn } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasPhoto, setHasPhoto] = useState(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setHasPhoto(true);
    img.src = SIGNIN_PHOTO;
  }, []);
  if (user) return <Navigate to={PATH.DASHBOARD} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(identifier.trim(), password);
    } catch (err) {
      if (err instanceof NotStaffError) setError(t.login.staffOnly);
      else if (err instanceof ApiError) setError(err.status === TOO_MANY ? t.login.tooMany : t.login.failed);
      else setError(t.login.offline);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`login${hasPhoto ? ' has-photo' : ''}`}>
      <form className="card" onSubmit={submit} noValidate>
        <Logo size={34} />
        <h1 className="title" style={{ fontSize: 26 }}>{t.login.title}</h1>
        <span className="sub">{t.login.subtitle}</span>
        <div className="field">
          <label htmlFor="identifier">{t.login.identifier}</label>
          <input id="identifier" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">{t.login.password}</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn" type="submit" disabled={busy || !identifier || !password}>{busy ? t.login.working : t.login.submit}</button>
      </form>
    </main>
  );
}
