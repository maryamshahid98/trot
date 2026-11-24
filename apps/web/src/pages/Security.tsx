import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useApi';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Load, PageHead, useToast } from '../ui/kit';

interface MfaStatus { enabled: boolean; setupStarted: boolean; required: boolean; recoveryCodesLeft: number }
interface Setup { secret: string; otpauthUrl: string }

/** Two-step sign-in: set it up with an authenticator app, keep recovery codes, turn it off (unless the club requires it). */
export function Security() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const status = useQuery<MfaStatus>('/auth/mfa');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<'off' | 'codes' | null>(null);
  const forced = user?.mfaEnrollmentRequired === true;

  const start = async () => {
    try { setSetup(await post<Setup>('/auth/mfa/setup')); } catch (e) { toast(e instanceof Error ? e.message : 'Could not start set-up', true); }
  };
  const done = async (recovery: string[]) => {
    setSetup(null);
    setCodes(recovery);
    status.reload();
    await refreshUser(); // the club may have required this: the rest of the portal opens now
  };

  return (
    <>
      <PageHead title="Security" sub="Two-step sign-in" />
      <div className="page">
        {forced && (
          <Card title="Set this up to continue">
            <p>Your role must use two-step sign-in. Until it is set up, nothing else in the portal is available to you.</p>
          </Card>
        )}
        <Load q={status}>{(s) => (
          <>
            <Card title="Two-step sign-in with an authenticator app">
              <p>
                Status: <Badge value={s.enabled ? 'active' : 'inactive'} /> {s.required && <span className="sub"> required for your role</span>}
              </p>
              <p className="sub">
                After your password you enter a 6-digit code from an app on your phone (Google Authenticator, Microsoft Authenticator, Authy, 1Password and similar). Even if someone learns your password, they cannot sign in without your phone.
              </p>
              {!s.enabled && !setup && <div className="actions"><Btn kind="primary" onClick={() => void start()}>{s.setupStarted ? 'Continue set-up' : 'Set up'}</Btn></div>}
              {s.enabled && (
                <div className="actions">
                  <span className="sub">{s.recoveryCodesLeft} recovery code{s.recoveryCodesLeft === 1 ? '' : 's'} left</span>
                  <Btn small onClick={() => setDialog('codes')}>New recovery codes</Btn>
                  {!s.required && <Btn small kind="danger" onClick={() => setDialog('off')}>Turn off</Btn>}
                </div>
              )}
            </Card>
            {setup && <SetupCard setup={setup} onCancel={() => setSetup(null)} onDone={(r) => void done(r)} />}
          </>
        )}</Load>
        {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}
      </div>
      {dialog === 'off' && (
        <FormDialog title="Turn off two-step sign-in" submit="Turn off" onClose={() => setDialog(null)} onDone={() => { setDialog(null); status.reload(); void refreshUser(); toast('Two-step sign-in is off'); }}
          fields={[{ name: 'password', label: 'Your password', type: 'password', required: true }, { name: 'code', label: 'A code from the app (or a recovery code)', type: 'text', required: true }]}
          onSubmit={(v) => post('/auth/mfa/disable', { password: v.password, code: String(v.code).trim() })} />
      )}
      {dialog === 'codes' && (
        <FormDialog title="New recovery codes" submit="Make new codes" onClose={() => setDialog(null)} onDone={() => setDialog(null)}
          fields={[{ name: 'code', label: 'A current code from the app', type: 'text', required: true, hint: 'The old recovery codes stop working.' }]}
          onSubmit={async (v) => { const r = await post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { code: String(v.code).trim() }); setCodes(r.recoveryCodes); status.reload(); }} />
      )}
    </>
  );
}

/** The QR code to scan, the same secret as text (for typing it in), and the box for the first code. */
function SetupCard({ setup, onCancel, onDone }: { setup: Setup; onCancel: () => void; onDone: (recoveryCodes: string[]) => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(setup.otpauthUrl, { width: 220, margin: 1 }).then((url) => { if (live) setQr(url); }).catch(() => { if (live) setQr(null); });
    return () => { live = false; };
  }, [setup.otpauthUrl]);

  const confirm = async () => {
    setBusy(true); setError(null);
    try { onDone((await post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code: code.trim() })).recoveryCodes); }
    catch (e) { setError(e instanceof Error ? e.message : 'That code was not right.'); setBusy(false); }
  };

  return (
    <Card title="1. Scan, then 2. confirm">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          {qr ? <img src={qr} alt="QR code to scan with your authenticator app" width={220} height={220} style={{ borderRadius: 12, background: '#fff' }} /> : <p className="sub">Could not draw the QR code. Type the key in instead.</p>}
        </div>
        <div>
          <p>Open your authenticator app, choose <b>Add account</b>, and scan this code. Can't scan? Choose "enter a key" and type:</p>
          <p><code style={{ fontSize: 16, letterSpacing: 1, overflowWrap: 'anywhere' }}>{setup.secret.match(/.{1,4}/g)?.join(' ')}</code></p>
          <div className="field">
            <label htmlFor="mfa-code">The 6-digit code the app shows now</label>
            <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="actions" style={{ paddingTop: 10 }}>
            <Btn onClick={onCancel}>Cancel</Btn>
            <Btn kind="primary" disabled={busy || code.length !== 6} onClick={() => void confirm()}>Turn on</Btn>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Shown once. Each code works one time, for a lost phone. */
function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const toast = useToast();
  return (
    <Card title="Your recovery codes">
      <div className="print-area">
        <p><b>Save these now. They are shown only once.</b> Each works one time if you lose your phone. Keep them somewhere safe, away from your password.</p>
        <div className="row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          {codes.map((c) => <code key={c} style={{ fontSize: 16, letterSpacing: 1 }}>{c}</code>)}
        </div>
        <div className="actions no-print" style={{ paddingTop: 12 }}>
          <Btn small onClick={() => void navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Copied'))}>Copy</Btn>
          <Btn small onClick={() => window.print()}>Print</Btn>
          <Btn small kind="primary" onClick={onClose}>I have saved them</Btn>
        </div>
      </div>
    </Card>
  );
}
