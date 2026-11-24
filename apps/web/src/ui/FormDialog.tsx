import { useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { Btn, Modal } from './kit';
import { errorText } from '../lib/useApi';

export type FieldDef = FieldShape & { /** Show this field only when this returns true for the answers so far. */ showIf?: (v: Values) => boolean };
type FieldShape =
  | { name: string; label: string; type: 'text' | 'password' | 'email' | 'tel' | 'date' | 'datetime'; required?: boolean; hint?: string }
  | { name: string; label: string; type: 'number' | 'money'; required?: boolean; hint?: string; min?: number; max?: number }
  | { name: string; label: string; type: 'textarea'; required?: boolean; hint?: string }
  | { name: string; label: string; type: 'checkbox'; hint?: string }
  | { name: string; label: string; type: 'select'; options: { value: string; label: string }[]; required?: boolean; hint?: string; blank?: string }
  | { name: string; label: string; type: 'checks'; options: { value: string; label: string }[]; hint?: string };

export type Values = Record<string, string | boolean | string[]>;

/** One dialog for every simple form. The caller turns the typed values into the API's body, so each screen stays small. */
export function FormDialog({ title, fields, initial = {}, submit = 'Save', onSubmit, onClose, onDone, wide, extra }: {
  title: string; fields: FieldDef[]; initial?: Values; submit?: string; wide?: boolean; extra?: ReactNode;
  onSubmit: (v: Values) => Promise<unknown>; onClose: () => void; onDone: () => void;
}) {
  const start: Values = {};
  for (const f of fields) start[f.name] = initial[f.name] ?? (f.type === 'checkbox' ? false : f.type === 'checks' ? [] : '');
  const [v, setV] = useState<Values>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const set = (n: string, x: string | boolean | string[]) => setV((o) => ({ ...o, [n]: x }));

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setProblems({});
    try { await onSubmit(v); onDone(); }
    catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError) setProblems(Object.fromEntries(err.problems.filter((p) => p.field).map((p) => [p.field, p.message])));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <form onSubmit={go} className="form" noValidate>
        {fields.filter((f) => !f.showIf || f.showIf(v)).map((f) => {
          const id = `f-${f.name}`;
          const err = problems[f.name];
          const req = 'required' in f && f.required;
          return (
            <div className="field" key={f.name}>
              {f.type !== 'checkbox' && <label htmlFor={id}>{f.label}{req ? ' *' : ''}</label>}
              {f.type === 'textarea' ? (
                <textarea id={id} rows={3} value={v[f.name] as string} onChange={(e) => set(f.name, e.target.value)} />
              ) : f.type === 'select' ? (
                <select id={id} value={v[f.name] as string} onChange={(e) => set(f.name, e.target.value)}>
                  <option value="">{f.blank ?? 'Choose…'}</option>
                  {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === 'checkbox' ? (
                <label className="check"><input id={id} type="checkbox" checked={v[f.name] as boolean} onChange={(e) => set(f.name, e.target.checked)} />{f.label}</label>
              ) : f.type === 'checks' ? (
                <div className="checks">
                  {f.options.map((o) => {
                    const on = (v[f.name] as string[]).includes(o.value);
                    return <label className="check" key={o.value}><input type="checkbox" checked={on} onChange={() => set(f.name, on ? (v[f.name] as string[]).filter((x) => x !== o.value) : [...(v[f.name] as string[]), o.value])} />{o.label}</label>;
                  })}
                </div>
              ) : (
                <input id={id} value={v[f.name] as string}
                  type={f.type === 'datetime' ? 'datetime-local' : f.type === 'money' ? 'number' : f.type}
                  step={f.type === 'money' ? '0.01' : f.type === 'number' ? '1' : undefined}
                  min={'min' in f ? f.min : undefined} max={'max' in f ? f.max : undefined}
                  onChange={(e) => set(f.name, e.target.value)} />
              )}
              {'hint' in f && f.hint && <span className="hint">{f.hint}</span>}
              {err && <span className="error">{err}</span>}
            </div>
          );
        })}
        {extra}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="form-actions">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : submit}</Btn>
        </div>
      </form>
    </Modal>
  );
}
