import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { errorText } from '../lib/useApi';
import { label } from '../lib/format';

// ---------- layout ----------
export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="head">
      <div className="head-text">
        <h1 className="title">{title}</h1>
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div className="actions">{actions}</div>
    </div>
  );
}
export function Card({ title, actions, children, flex }: { title?: string; actions?: ReactNode; children: ReactNode; flex?: boolean }) {
  return (
    <section className="card" style={flex ? { flex: 1, minHeight: 0, overflow: 'auto' } : undefined}>
      {(title || actions) && (
        <div className="card-head">
          <h2 className="card-title">{title}</h2>
          <div className="actions">{actions}</div>
        </div>
      )}
      {children}
    </section>
  );
}
export const Stat = ({ label: l, value, sub, hot }: { label: string; value: string; sub?: string; hot?: boolean }) => (
  <div className={`stat${hot ? ' hot' : ''}`}>
    <span className="stat-l">{l}</span>
    <span className="stat-v">{value}</span>
    {sub && <span className="stat-s">{sub}</span>}
  </div>
);
export const Row = ({ children }: { children: ReactNode }) => <div className="row">{children}</div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} className={`tab${t.id === value ? ' on' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

// ---------- buttons and badges ----------
type BtnProps = { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'plain' | 'danger'; small?: boolean; disabled?: boolean; type?: 'button' | 'submit' };
export const Btn = ({ children, onClick, kind = 'plain', small, disabled, type = 'button' }: BtnProps) => (
  <button type={type} className={`btn2 ${kind}${small ? ' small' : ''}`} onClick={onClick} disabled={disabled}>{children}</button>
);
const TONES: Record<string, string> = {
  confirmed: 'good', active: 'good', available: 'good', verified: 'good', approved: 'good', completed: 'good', published: 'good', closed: 'good', checked_in: 'good',
  pending_office_payment: 'warn', pending: 'warn', requested: 'warn', draft: 'warn', pending_review: 'warn', resting: 'warn', frozen: 'warn', submitted: 'warn', open: 'warn', medium: 'warn',
  cancelled: 'bad', no_show: 'bad', rejected: 'bad', suspended: 'bad', injured: 'bad', medical_hold: 'bad', expired: 'bad', locked: 'bad', critical: 'bad', high: 'bad', reopened: 'bad',
};
export const Badge = ({ value }: { value: string }) => <span className={`badge ${TONES[value] ?? 'neutral'}`}>{label(value)}</span>;

// ---------- tables ----------
export interface Col<R> { head: string; cell: (r: R) => ReactNode; width?: string; right?: boolean }
export function Table<R>({ cols, rows, empty = 'Nothing to show.', onRow, rowKey }: { cols: Col<R>[]; rows: R[]; empty?: string; onRow?: (r: R) => void; rowKey: (r: R) => string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  const grid = cols.map((c) => c.width ?? '1fr').join(' ');
  return (
    <div className="table" role="table">
      <div className="tr th" role="row" style={{ gridTemplateColumns: grid }}>
        {cols.map((c) => <span key={c.head} role="columnheader" style={c.right ? { textAlign: 'end' } : undefined}>{c.head}</span>)}
      </div>
      {rows.map((r) => (
        <div key={rowKey(r)} className={`tr${onRow ? ' click' : ''}`} role="row" style={{ gridTemplateColumns: grid }} onClick={onRow ? () => onRow(r) : undefined}>
          {cols.map((c) => <span key={c.head} role="cell" style={c.right ? { textAlign: 'end' } : undefined}>{c.cell(r)}</span>)}
        </div>
      ))}
    </div>
  );
}

// ---------- loading and errors ----------
export function Load<T>({ q, children }: { q: { data: T | null; error: string | null; loading: boolean }; children: (d: T) => ReactNode }) {
  if (q.error) return <div className="error" role="alert">{q.error}</div>;
  if (q.data === null) return <Empty>{q.loading ? 'Loading…' : 'Nothing to show.'}</Empty>;
  return <>{children(q.data)}</>;
}

// ---------- messages ----------
interface Toast { id: number; text: string; bad: boolean }
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setItems((a) => [...a, { id, text, bad }]);
    setTimeout(() => setItems((a) => a.filter((t) => t.id !== id)), bad ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/** Runs an action, shows success or the API's own error message. Returns true if it worked. */
export function useAct() {
  const toast = useToast();
  return useCallback(async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try { await fn(); if (ok) toast(ok); return true; } catch (e) { toast(errorText(e), true); return false; }
  }, [toast]);
}

// ---------- dialogs ----------
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2 className="card-title">{title}</h2><button className="x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Confirm({ title, text, action, onDone, onClose, danger }: { title: string; text: string; action: () => Promise<unknown>; onDone: () => void; onClose: () => void; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <p>{text}</p>
      {err && <div className="error" role="alert">{err}</div>}
      <div className="form-actions">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind={danger ? 'danger' : 'primary'} disabled={busy} onClick={async () => { setBusy(true); try { await action(); onDone(); } catch (e) { setErr(errorText(e)); setBusy(false); } }}>Confirm</Btn>
      </div>
    </Modal>
  );
}
