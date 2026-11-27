import { useState } from 'react';
import type { FormEvent } from 'react';
import { post } from '../api/client';
import { tr } from '../i18n';
import { errorText } from '../lib/useApi';
import { Logo } from '../ui/Logo';

/** Two steps: ask for a code, then use it to choose a new password. */
export function ForgotPassword({ identifier: first, onBack }: { identifier: string; onBack: (message?: string) => void }) {
  const [identifier, setIdentifier] = useState(first);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!sent) { await post('/auth/forgot', { identifier: identifier.trim() }); setSent(true); }
      else { await post('/auth/reset', { identifier: identifier.trim(), code, newPassword: password }); onBack(tr('Your password is changed. Sign in with the new one.')); }
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }
  return (
    <main className="login">
      <form className="card" onSubmit={go} noValidate>
        <Logo size={34} />
        <h1 className="title" style={{ fontSize: 26 }}>{tr('Forgot password')}</h1>
        <span className="sub">{sent ? tr('If that account exists, a 6-digit code has been sent to it. It works for 15 minutes.') : tr('Enter your email or phone and we will send you a code.')}</span>
        <div className="field"><label htmlFor="fid">{tr('Email or phone')}</label><input id="fid" autoComplete="username" value={identifier} disabled={sent} onChange={(e) => setIdentifier(e.target.value)} /></div>
        {sent && <>
          <div className="field"><label htmlFor="fcode">{tr('Code')}</label><input id="fcode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></div>
          <div className="field"><label htmlFor="fpw">{tr('New password')}</label><input id="fpw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        </>}
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn" type="submit" disabled={busy || !identifier || (sent && (code.length !== 6 || password.length < 10))}>{sent ? tr('Change password') : tr('Send code')}</button>
        <button type="button" className="btn2 small" onClick={() => onBack()}>{tr('Back to sign in')}</button>
      </form>
    </main>
  );
}
