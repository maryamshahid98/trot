import { useState } from 'react';
import { api, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { HORSE_SELECTION_MODES, LEVELS, OWNER_ONLY_POLICY, POLICY_FLAGS, POLICY_NUMBERS, ROLE } from '../constants';
import { POLICY_TEXT } from '../i18n/policy';
import { useBranch } from '../lib/branch';
import { fmtDateTime, fromMinor, label, toMinor, zonedToIso } from '../lib/format';
import { asValues, given, numberOrNull, textOrNull } from '../lib/form';
import { qs, useQuery } from '../lib/useApi';
import type { Arena } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import type { FieldDef, Values } from '../ui/FormDialog';
import { Btn, Card, Confirm, Load, Modal, PageHead, Table, Tabs, useAct } from '../ui/kit';

type Policy = Record<string, number | boolean | string | null>;
interface Closure { id: string; from: number; to: number; reason: string }
interface AuditEntry { id: string; at: number; actorName: string | null; action: string; entity: string; entityId: string | null; detail: Record<string, unknown> | null; source: string }
interface Organisation { logoUrl: string | null; defaultCurrency: string; defaultTimeZone: string; languages: string[]; name: string; legalName: string | null; taxNumber: string | null; address: string | null; phone: string | null; email: string | null }

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.map(show).join(', ') : typeof v === 'object' ? Object.entries(v as object).map(([k, x]) => `${words(k)}: ${show(x)}`).join('; ') : String(v));
const words = (k: string) => label(k.replace(/([A-Z])/g, '_$1').toLowerCase());
/** What changed, from what, to what, and why (AUD-001). */
function auditDetail(d: Record<string, unknown> | null): string {
  if (!d) return '';
  const out: string[] = [];
  const { from, to, changes, ...rest } = d;
  // Amounts are stored in minor units; show them as money.
  const val = (k: string, v: unknown) => (k.endsWith('Minor') && typeof v === 'number' ? fromMinor(v) : show(v));
  const name = (k: string) => words(k.replace(/Minor$/, ''));
  const pair = (k: string, a: unknown, b: unknown) => out.push(`${name(k)}: ${val(k, a)} → ${val(k, b)}`);
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) for (const [k, v] of Object.entries(changes as Record<string, { from: unknown; to: unknown }>)) pair(k, v.from, v.to);
  if (from && to && typeof from === 'object' && typeof to === 'object') { for (const [k, v] of Object.entries(to as Record<string, unknown>)) if (show((from as Record<string, unknown>)[k]) !== show(v)) pair(k, (from as Record<string, unknown>)[k], v); }
  else if (from !== undefined || to !== undefined) pair('value', from, to);
  for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined && !/Id$/.test(k)) out.push(`${name(k)}: ${val(k, v)}`);
  return out.join(' · ');
}

export function Admin() {
  const { user } = useAuth();
  const { branchId, branch } = useBranch();
  const owner = user!.role === ROLE.OWNER;
  const [tab, setTab] = useState<'club' | 'rules' | 'arenas' | 'waivers' | 'audit'>('club');
  const [f, setF] = useState<null | 'club' | 'branch' | 'newBranch' | 'rules' | 'newArena' | { edit: Arena } | { closures: Arena } | { drop: { arena: Arena; c: Closure } }>(null);
  const org = useQuery<Organisation>(tab === 'club' ? '/organisation' : null);
  const policy = useQuery<{ policy: Policy }>(branchId && tab === 'rules' ? `/branches/${branchId}/policy` : null);
  const arenas = useQuery<{ arenas: Arena[] }>(branchId && tab === 'arenas' ? `/arenas${qs({ branchId })}` : null);
  const audit = useQuery<{ entries: AuditEntry[]; nextBefore: number | null }>(branchId && tab === 'audit' ? `/audit-log${qs({ branchId, limit: 50 })}` : null);
  const done = () => { setF(null); policy.reload(); arenas.reload(); };
  const act = useAct();
  const saveLogo = (file: File) => void act(async () => {
    if (file.size > 50_000) throw new Error('Choose a picture of 50 KB or less.');
    const url = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('The file could not be read.')); r.readAsDataURL(file); });
    await api('PATCH', '/organisation', { logoUrl: url });
    org.reload();
  }, 'Logo saved');

  const keys = [...POLICY_NUMBERS, ...POLICY_FLAGS].filter((k) => owner || !(OWNER_ONLY_POLICY as readonly string[]).includes(k));
  const arenaFields: FieldDef[] = [
    { name: 'name', label: 'Name', type: 'text', required: true }, { name: 'maxCapacity', label: 'Most riders at once', type: 'number', required: true, min: 1 },
    { name: 'supportedLevels', label: 'Riding levels it is approved for', type: 'checks', options: LEVELS.map((l) => ({ value: l, label: label(l) })) },
    { name: 'kind', label: 'Type', type: 'text', hint: 'For example indoor, outdoor, round pen, beach route.' }, { name: 'surface', label: 'Surface', type: 'text' },
    { name: 'lengthM', label: 'Length (m)', type: 'number', min: 1 }, { name: 'widthM', label: 'Width (m)', type: 'number', min: 1 }, { name: 'activities', label: 'Activities', type: 'text' },
    { name: 'sharedUse', label: 'Can be shared: several sessions at once, up to the most riders', type: 'checkbox' },
    { name: 'opensAt', label: 'Opens at', type: 'text', hint: '24-hour time such as 06:00. Empty follows the branch.' }, { name: 'closesAt', label: 'Closes at', type: 'text' },
  ];
  const ruleFields = (): FieldDef[] => [
    ...POLICY_NUMBERS.filter((k) => keys.includes(k)).map((k): FieldDef => ({ name: k, label: POLICY_TEXT[k].label, type: 'number', min: 0, hint: POLICY_TEXT[k].hint || undefined })),
    ...POLICY_FLAGS.filter((k) => keys.includes(k)).map((k): FieldDef => ({ name: k, label: POLICY_TEXT[k].label, type: 'checkbox', hint: POLICY_TEXT[k].hint || undefined })),
    { name: 'horseSelection', label: POLICY_TEXT.horseSelection.label, type: 'select', options: HORSE_SELECTION_MODES.map((m) => ({ value: m, label: label(m) })) },
  ];
  const ruleInitial = (p: Policy): Values => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'number' ? (k.endsWith('Minor') ? fromMinor(v) : String(v)) : v ?? ''])) as Values;
  const ruleBody = (v: Values) => {
    const body: Record<string, unknown> = {};
    for (const k of POLICY_NUMBERS) if (keys.includes(k) && v[k] !== undefined && v[k] !== '') body[k] = k.endsWith('Minor') ? toMinor(String(v[k])) : Number(v[k]);
    for (const k of POLICY_FLAGS) if (keys.includes(k)) body[k] = v[k] === true;
    if (v.horseSelection) body.horseSelection = v.horseSelection;
    return body;
  };

  return (
    <>
      <PageHead title="Admin" sub={branch?.name} actions={tab === 'club' ? <>{owner && <Btn onClick={() => setF('newBranch')}>New branch</Btn>}{owner && <Btn onClick={() => setF('club')}>Edit club</Btn>}<Btn kind="primary" onClick={() => setF('branch')}>Edit branch</Btn></> : tab === 'rules' ? <Btn kind="primary" onClick={() => setF('rules')}>Edit rules</Btn> : tab === 'arenas' ? <Btn kind="primary" onClick={() => setF('newArena')}>New arena</Btn> : undefined} />
      <div className="page">
        <Tabs tabs={[{ id: 'club', label: 'Club' }, { id: 'rules', label: 'Booking rules' }, { id: 'arenas', label: 'Arenas' }, { id: 'waivers', label: 'Waivers' }, { id: 'audit', label: 'Activity log' }]} value={tab} onChange={setTab} />
        {tab === 'club' && <>
          <Card title="Club"><Load q={org}>{(o) => <dl className="kv"><dt>Name</dt><dd>{o.name}</dd><dt>Legal name</dt><dd>{o.legalName ?? '—'}</dd><dt>Tax number</dt><dd>{o.taxNumber ?? '—'}</dd><dt>Address</dt><dd>{o.address ?? '—'}</dd><dt>Phone</dt><dd>{o.phone ?? '—'}</dd><dt>Email</dt><dd>{o.email ?? '—'}</dd><dt>Default currency</dt><dd>{o.defaultCurrency}</dd><dt>Default time zone</dt><dd>{o.defaultTimeZone}</dd><dt>Languages</dt><dd>{o.languages.map((l) => (l === 'ar' ? 'Arabic' : 'English')).join(', ')}</dd><dt>Logo</dt><dd>{o.logoUrl ? <img className="doc-logo" src={o.logoUrl} alt="Club logo" /> : '—'}</dd></dl>}</Load>
            {owner && <div className="field"><label htmlFor="logo">Change logo (PNG or JPEG, up to 50 KB)</label><input id="logo" type="file" accept="image/png,image/jpeg" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) saveLogo(file); }} /></div>}{!owner && <p className="sub">Only an owner can change the club’s details.</p>}</Card>
          <Card title="This branch"><dl className="kv"><dt>Name</dt><dd>{branch?.name}</dd><dt>Address</dt><dd>{branch?.address ?? '—'}</dd><dt>Time zone</dt><dd>{branch?.timeZone}</dd><dt>Currency</dt><dd>{branch?.currency}</dd><dt>Opening hours</dt><dd>{branch?.opensAt ? `${branch.opensAt} to ${branch.closesAt}` : 'Not set: any time can be scheduled'}</dd><dt>Holidays</dt><dd>{branch?.holidays?.length ? branch.holidays.join(', ') : 'None'}</dd></dl></Card>
        </>}
        {tab === 'rules' && <Card title="Booking rules for this club"><Load q={policy}>{(d) => <dl className="kv">{[...POLICY_NUMBERS, ...POLICY_FLAGS, 'horseSelection'].map((k) => <><dt key={`k${k}`}>{POLICY_TEXT[k].label}</dt><dd key={`v${k}`}>{typeof d.policy[k] === 'boolean' ? (d.policy[k] ? 'Yes' : 'No') : k.endsWith('Minor') ? fromMinor(Number(d.policy[k])) : k === 'horseSelection' ? label(String(d.policy[k])) : String(d.policy[k] ?? '')}</dd></>)}</dl>}</Load></Card>}
        {tab === 'arenas' && <Card flex><Load q={arenas}>{(d) => <Table rowKey={(a) => a.id} rows={d.arenas} empty="No arenas." cols={[{ head: 'Arena', cell: (a) => <b>{a.name}</b> }, { head: 'Most riders', cell: (a) => a.maxCapacity }, { head: 'Details', cell: (a) => [a.kind, a.surface, a.lengthM && a.widthM ? `${a.lengthM} × ${a.widthM} m` : null, a.sharedUse ? 'shared' : 'exclusive', a.opensAt ? `${a.opensAt}–${a.closesAt}` : null].filter(Boolean).join(', '), width: '1.6fr' }, { head: 'Levels', cell: (a) => a.supportedLevels.map(label).join(', '), width: '1.6fr' }, { head: '', right: true, width: '1.6fr', cell: (a) => <span className="actions"><Btn small onClick={() => setF({ closures: a })}>Closures</Btn><Btn small onClick={() => setF({ edit: a })}>Edit</Btn></span> }]} />}</Load></Card>}
        {tab === 'waivers' && <Waivers />}
        {tab === 'audit' && <Card flex title="Who did what"><Load q={audit}>{(d) => <Table rowKey={(e) => e.id} rows={d.entries} empty="Nothing recorded." cols={[{ head: 'When', cell: (e) => fmtDateTime(e.at) }, { head: 'Who', cell: (e) => e.actorName ?? 'System' }, { head: 'Action', cell: (e) => label(e.action.replace(/\./g, '_')) }, { head: 'On', cell: (e) => label(e.entity) }, { head: 'From', cell: (e) => label(e.source), width: '0.8fr' }, { head: 'Details', cell: (e) => auditDetail(e.detail), width: '3fr' }]} />}</Load></Card>}
      </div>

      {f === 'club' && org.data && <FormDialog title="Edit club" onClose={() => setF(null)} onDone={() => { setF(null); org.reload(); }} initial={{ defaultCurrency: org.data.defaultCurrency, defaultTimeZone: org.data.defaultTimeZone, languages: org.data.languages, name: org.data.name, legalName: org.data.legalName ?? '', taxNumber: org.data.taxNumber ?? '', address: org.data.address ?? '', phone: org.data.phone ?? '', email: org.data.email ?? '' }}
        fields={[{ name: 'name', label: 'Club name', type: 'text', required: true }, { name: 'legalName', label: 'Legal name (on invoices)', type: 'text' }, { name: 'taxNumber', label: 'Tax number', type: 'text' }, { name: 'address', label: 'Address', type: 'textarea' }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
          { name: 'defaultCurrency', label: 'Default currency', type: 'text' }, { name: 'defaultTimeZone', label: 'Default time zone', type: 'text' }, { name: 'languages', label: 'Supported languages', type: 'checks', options: [{ value: 'en', label: 'English' }, { value: 'ar', label: 'Arabic' }] }]}
        onSubmit={(v) => api('PATCH', '/organisation', { name: v.name, legalName: v.legalName || null, taxNumber: v.taxNumber || null, address: v.address || null, phone: v.phone || null, email: v.email || null, defaultCurrency: v.defaultCurrency, defaultTimeZone: v.defaultTimeZone, languages: v.languages })} />}
      {f === 'branch' && branch && <FormDialog title="Edit branch" onClose={() => setF(null)} onDone={() => window.location.reload()} initial={{ name: branch.name, timeZone: branch.timeZone, address: branch.address ?? '', opensAt: branch.opensAt ?? '', closesAt: branch.closesAt ?? '', holidays: (branch.holidays ?? []).join(', ') }}
        fields={[{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'address', label: 'Address', type: 'textarea' }, { name: 'timeZone', label: 'Time zone', type: 'text', required: true, hint: 'For example Asia/Riyadh. All class times use this zone.' },
          { name: 'opensAt', label: 'Opens at', type: 'text', hint: '24-hour time such as 06:00. Leave both empty for no limit.' }, { name: 'closesAt', label: 'Closes at', type: 'text', hint: 'For example 22:00.' }, { name: 'holidays', label: 'Holidays', type: 'textarea', hint: 'Dates such as 2026-12-01, separated by commas.' }]}
        onSubmit={(v) => api('PATCH', `/branches/${branchId}`, { name: v.name, timeZone: v.timeZone, address: v.address || null, opensAt: v.opensAt || null, closesAt: v.closesAt || null, holidays: String(v.holidays || '').split(/[\s,]+/).filter(Boolean) })} />}
      {f === 'newBranch' && <FormDialog title="New branch" onClose={() => setF(null)} onDone={() => window.location.reload()} initial={{ timeZone: branch?.timeZone ?? 'Asia/Riyadh', currency: branch?.currency ?? 'SAR' }}
        fields={[{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'timeZone', label: 'Time zone', type: 'text', required: true }, { name: 'currency', label: 'Currency', type: 'text', required: true }, { name: 'address', label: 'Address', type: 'textarea' }]}
        onSubmit={(v) => post('/branches', { name: v.name, timeZone: v.timeZone, currency: v.currency, ...(v.address ? { address: v.address } : {}) })} />}
      {f === 'rules' && <FormDialog title="Booking rules" onClose={() => setF(null)} onDone={done} initial={ruleInitial(policy.data?.policy ?? {})} fields={ruleFields()} onSubmit={(v) => api('PATCH', `/branches/${branchId}/policy`, ruleBody(v))} />}
      {f === 'newArena' && <FormDialog title="New arena" onClose={() => setF(null)} onDone={done} initial={{ supportedLevels: [...LEVELS] }} fields={arenaFields} onSubmit={(v) => post('/arenas', { branchId, name: v.name, maxCapacity: Number(v.maxCapacity), supportedLevels: v.supportedLevels, ...given(arenaBody(v)) })} />}
      {typeof f === 'object' && f && 'edit' in f && <FormDialog title={`Edit ${f.edit.name}`} onClose={() => setF(null)} onDone={done} initial={{ ...asValues(f.edit, ['kind', 'surface', 'lengthM', 'widthM', 'activities', 'sharedUse', 'opensAt', 'closesAt']), name: f.edit.name, maxCapacity: String(f.edit.maxCapacity), supportedLevels: f.edit.supportedLevels }} fields={arenaFields} onSubmit={(v) => api('PATCH', `/arenas/${f.edit.id}`, { name: v.name, maxCapacity: Number(v.maxCapacity), supportedLevels: v.supportedLevels, ...arenaBody(v) })} />}
      {typeof f === 'object' && f && 'closures' in f && <ClosuresDialog arena={f.closures} onClose={() => setF(null)} />}
    </>
  );
}

function ClosuresDialog({ arena, onClose }: { arena: Arena; onClose: () => void }) {
  const q = useQuery<{ closures: Closure[] }>(`/arenas/${arena.id}/closures`);
  const [adding, setAdding] = useState(false);
  const [drop, setDrop] = useState<Closure | null>(null);
  return (
    <Modal title={`Closures: ${arena.name}`} onClose={onClose} wide>
      <div className="actions" style={{ paddingBottom: 8 }}><Btn small kind="primary" onClick={() => setAdding(true)}>Add closure</Btn></div>
      <Load q={q}>{(d) => <Table rowKey={(c) => c.id} rows={d.closures} empty="No closures." cols={[{ head: 'From', cell: (c) => fmtDateTime(c.from) }, { head: 'To', cell: (c) => fmtDateTime(c.to) }, { head: 'Reason', cell: (c) => c.reason }, { head: '', right: true, width: '0.8fr', cell: (c) => <Btn small kind="danger" onClick={() => setDrop(c)}>Remove</Btn> }]} />}</Load>
      {adding && <FormDialog title="Close this arena" onClose={() => setAdding(false)} onDone={() => { setAdding(false); q.reload(); }} fields={[{ name: 'from', label: 'From', type: 'datetime', required: true }, { name: 'to', label: 'To', type: 'datetime', required: true }, { name: 'reason', label: 'Reason', type: 'text', required: true, hint: 'Refused if classes are planned in this time. Move or cancel those first, from the calendar.' }]} onSubmit={(v) => post(`/arenas/${arena.id}/closures`, { from: zonedToIso(String(v.from)), to: zonedToIso(String(v.to)), reason: v.reason })} />}
      {drop && <Confirm title="Remove this closure?" text={drop.reason} danger onClose={() => setDrop(null)} onDone={() => { setDrop(null); q.reload(); }} action={() => api('DELETE', `/arenas/${arena.id}/closures/${drop.id}`)} />}
    </Modal>
  );
}

const arenaBody = (v: Values) => ({
  kind: textOrNull(v.kind), surface: textOrNull(v.surface), activities: textOrNull(v.activities), lengthM: numberOrNull(v.lengthM), widthM: numberOrNull(v.widthM),
  sharedUse: v.sharedUse === true, opensAt: textOrNull(v.opensAt), closesAt: textOrNull(v.closesAt),
});

interface Waiver { id: string; version: string; body: string; requiresResign: boolean; publishedAt: string }
/** The waiver wording over time. A rider's record shows the version they accepted. */
function Waivers() {
  const { branchId } = useBranch();
  const q = useQuery<{ versions: Waiver[] }>(branchId ? `/waiver-versions${qs({ branchId })}` : null);
  const [adding, setAdding] = useState(false);
  const [read, setRead] = useState<Waiver | null>(null);
  return (
    <Card title="Waiver versions" actions={<Btn kind="primary" onClick={() => setAdding(true)}>Publish new version</Btn>}>
      <Load q={q}>{(d) => <Table rowKey={(w) => w.id} rows={d.versions} empty="No version published. Any signed waiver is accepted." onRow={setRead} cols={[
        { head: 'Version', cell: (w) => <b>{w.version}</b> }, { head: 'Published', cell: (w) => fmtDateTime(w.publishedAt) }, { head: 'Everyone signs again', cell: (w) => (w.requiresResign ? 'Yes' : 'No') },
      ]} />}</Load>
      {adding && <FormDialog wide title="New waiver version" submit="Publish" onClose={() => setAdding(false)} onDone={() => { setAdding(false); q.reload(); }} initial={{ requiresResign: true }}
        fields={[{ name: 'version', label: 'Version number', type: 'text', required: true }, { name: 'body', label: 'Wording', type: 'textarea', required: true }, { name: 'requiresResign', label: 'Riders must sign this version before riding again', type: 'checkbox' }]}
        onSubmit={(v) => post('/waiver-versions', { branchId, version: v.version, body: v.body, requiresResign: v.requiresResign === true })} />}
      {read && <Modal title={`Waiver ${read.version}`} onClose={() => setRead(null)} wide><p style={{ whiteSpace: 'pre-wrap' }}>{read.body}</p></Modal>}
    </Card>
  );
}
