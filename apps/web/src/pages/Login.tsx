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
  const { user, signIn, signInWithCode } = useAuth();
  // Set when the password was right and a code from the authenticator app is still needed.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
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
      setMfaToken(await signIn(identifier.trim(), password));
    } catch (err) {
      if (err instanceof NotStaffError) setError(t.login.staffOnly);
      else if (err instanceof ApiError) setError(err.status === TOO_MANY ? t.login.tooMany : t.login.failed);
      else setError(t.login.offline);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithCode(mfaToken, useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });
    } catch (err) {
      if (err instanceof NotStaffError) { setMfaToken(null); setError(t.login.staffOnly); }
      else if (err instanceof ApiError && err.status === TOO_MANY) setError(t.login.tooMany);
      else if (err instanceof ApiError && err.message.includes('too long')) { setMfaToken(null); setCode(''); setError(t.login.expired); }
      else if (err instanceof ApiError) { setError(t.login.codeFailed); setCode(''); }
      else setError(t.login.offline);
    } finally {
      setBusy(false);
    }
  }

  if (mfaToken) {
    return (
      <main className={`login${hasPhoto ? ' has-photo' : ''}`}>
        <form className="card" onSubmit={submitCode} noValidate>
          <Logo size={34} />
          <h1 className="title" style={{ fontSize: 26 }}>{t.login.codeTitle}</h1>
          <span className="sub">{useRecovery ? 'Enter one of your recovery codes. Each works once.' : t.login.codeHelp}</span>
          <div className="field">
            <label htmlFor="code">{useRecovery ? t.login.recoveryCode : t.login.code}</label>
            <input id="code" autoFocus autoComplete="one-time-code" inputMode={useRecovery ? 'text' : 'numeric'} maxLength={useRecovery ? 20 : 6}
              value={code} onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ''))} required />
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="btn" type="submit" disabled={busy || (useRecovery ? code.trim().length < 8 : code.length !== 6)}>{busy ? t.login.working : t.login.verify}</button>
          <button type="button" className="btn2 small" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>{useRecovery ? t.login.useApp : t.login.useRecovery}</button>
          <button type="button" className="btn2 small" onClick={() => { setMfaToken(null); setCode(''); setError(null); setPassword(''); }}>{t.login.back}</button>
        </form>
      </main>
    );
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
