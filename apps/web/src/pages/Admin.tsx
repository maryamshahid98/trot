import { useState } from 'react';
import { api, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { HORSE_SELECTION_MODES, OWNER_ONLY_POLICY, POLICY_FLAGS, POLICY_NUMBERS, ROLE } from '../constants';
import { POLICY_TEXT } from '../i18n/policy';
import { useBranch } from '../lib/branch';
import { fmtDateTime, label, zonedToIso } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import type { Arena } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import type { FieldDef, Values } from '../ui/FormDialog';
import { Btn, Card, Confirm, Load, Modal, PageHead, Table, Tabs } from '../ui/kit';

type Policy = Record<string, number | boolean | string | null>;
interface Closure { id: string; from: number; to: number; reason: string }
interface AuditEntry { id: string; at: number; actorName: string | null; action: string; entity: string; entityId: string | null }

export function Admin() {
  const { user } = useAuth();
  const { branchId, branch } = useBranch();
  const owner = user!.role === ROLE.OWNER;
  const [tab, setTab] = useState<'club' | 'rules' | 'arenas' | 'audit'>('club');
  const [f, setF] = useState<null | 'club' | 'rules' | 'newArena' | { edit: Arena } | { closures: Arena } | { drop: { arena: Arena; c: Closure } }>(null);
  const policy = useQuery<{ policy: Policy }>(branchId && tab === 'rules' ? `/branches/${branchId}/policy` : null);
  const arenas = useQuery<{ arenas: Arena[] }>(branchId && tab === 'arenas' ? `/arenas${qs({ branchId })}` : null);
  const audit = useQuery<{ entries: AuditEntry[]; nextBefore: number | null }>(branchId && tab === 'audit' ? `/audit-log${qs({ branchId, limit: 50 })}` : null);
  const done = () => { setF(null); policy.reload(); arenas.reload(); };

  const keys = [...POLICY_NUMBERS, ...POLICY_FLAGS].filter((k) => owner || !(OWNER_ONLY_POLICY as readonly string[]).includes(k));
  const ruleFields = (): FieldDef[] => [
    ...POLICY_NUMBERS.filter((k) => keys.includes(k)).map((k): FieldDef => ({ name: k, label: POLICY_TEXT[k].label, type: 'number', min: 0, hint: POLICY_TEXT[k].hint || undefined })),
    ...POLICY_FLAGS.filter((k) => keys.includes(k)).map((k): FieldDef => ({ name: k, label: POLICY_TEXT[k].label, type: 'checkbox', hint: POLICY_TEXT[k].hint || undefined })),
    { name: 'horseSelection', label: POLICY_TEXT.horseSelection.label, type: 'select', options: HORSE_SELECTION_MODES.map((m) => ({ value: m, label: label(m) })) },
  ];
  const ruleInitial = (p: Policy): Values => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v ?? ''])) as Values;
  const ruleBody = (v: Values) => {
    const body: Record<string, unknown> = {};
    for (const k of POLICY_NUMBERS) if (keys.includes(k) && v[k] !== undefined && v[k] !== '') body[k] = Number(v[k]);
    for (const k of POLICY_FLAGS) if (keys.includes(k)) body[k] = v[k] === true;
    if (v.horseSelection) body.horseSelection = v.horseSelection;
    return body;
  };

  return (
    <>
      <PageHead title="Admin" sub={branch?.name} actions={tab === 'club' ? <Btn kind="primary" onClick={() => setF('club')}>Edit club</Btn> : tab === 'rules' ? <Btn kind="primary" onClick={() => setF('rules')}>Edit rules</Btn> : tab === 'arenas' ? <Btn kind="primary" onClick={() => setF('newArena')}>New arena</Btn> : undefined} />
      <div className="page">
        <Tabs tabs={[{ id: 'club', label: 'Club' }, { id: 'rules', label: 'Booking rules' }, { id: 'arenas', label: 'Arenas' }, { id: 'audit', label: 'Activity log' }]} value={tab} onChange={setTab} />
        {tab === 'club' && <Card title="Club"><dl className="kv"><dt>Name</dt><dd>{branch?.name}</dd><dt>Time zone</dt><dd>{branch?.timeZone}</dd><dt>Currency</dt><dd>{branch?.currency}</dd></dl></Card>}
        {tab === 'rules' && <Card title="Booking rules for this club"><Load q={policy}>{(d) => <dl className="kv">{[...POLICY_NUMBERS, ...POLICY_FLAGS, 'horseSelection'].map((k) => <><dt key={`k${k}`}>{POLICY_TEXT[k].label}</dt><dd key={`v${k}`}>{typeof d.policy[k] === 'boolean' ? (d.policy[k] ? 'Yes' : 'No') : String(d.policy[k] ?? '')}</dd></>)}</dl>}</Load></Card>}
        {tab === 'arenas' && <Card flex><Load q={arenas}>{(d) => <Table rowKey={(a) => a.id} rows={d.arenas} empty="No arenas." cols={[{ head: 'Arena', cell: (a) => <b>{a.name}</b> }, { head: 'Most riders', cell: (a) => a.maxCapacity }, { head: '', right: true, width: '1.6fr', cell: (a) => <span className="actions"><Btn small onClick={() => setF({ closures: a })}>Closures</Btn><Btn small onClick={() => setF({ edit: a })}>Edit</Btn></span> }]} />}</Load></Card>}
        {tab === 'audit' && <Card flex title="Who did what"><Load q={audit}>{(d) => <Table rowKey={(e) => e.id} rows={d.entries} empty="Nothing recorded." cols={[{ head: 'When', cell: (e) => fmtDateTime(e.at) }, { head: 'Who', cell: (e) => e.actorName ?? 'System' }, { head: 'Action', cell: (e) => label(e.action.replace(/\./g, '_')) }, { head: 'On', cell: (e) => label(e.entity) }]} />}</Load></Card>}
      </div>

      {f === 'club' && branch && <FormDialog title="Edit club" onClose={() => setF(null)} onDone={() => window.location.reload()} initial={{ name: branch.name, timeZone: branch.timeZone }} fields={[{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'timeZone', label: 'Time zone', type: 'text', required: true, hint: 'For example Asia/Riyadh. All class times use this zone.' }]} onSubmit={(v) => api('PATCH', `/branches/${branchId}`, { name: v.name, timeZone: v.timeZone })} />}
      {f === 'rules' && <FormDialog title="Booking rules" onClose={() => setF(null)} onDone={done} initial={ruleInitial(policy.data?.policy ?? {})} fields={ruleFields()} onSubmit={(v) => api('PATCH', `/branches/${branchId}/policy`, ruleBody(v))} />}
      {f === 'newArena' && <FormDialog title="New arena" onClose={() => setF(null)} onDone={done} fields={[{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'maxCapacity', label: 'Most riders at once', type: 'number', required: true, min: 1 }]} onSubmit={(v) => post('/arenas', { branchId, name: v.name, maxCapacity: Number(v.maxCapacity) })} />}
      {typeof f === 'object' && f && 'edit' in f && <FormDialog title={`Edit ${f.edit.name}`} onClose={() => setF(null)} onDone={done} initial={{ name: f.edit.name, maxCapacity: String(f.edit.maxCapacity) }} fields={[{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'maxCapacity', label: 'Most riders at once', type: 'number', required: true, min: 1 }]} onSubmit={(v) => api('PATCH', `/arenas/${f.edit.id}`, { name: v.name, maxCapacity: Number(v.maxCapacity) })} />}
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
      {adding && <FormDialog title="Close this arena" onClose={() => setAdding(false)} onDone={() => { setAdding(false); q.reload(); }} fields={[{ name: 'from', label: 'From', type: 'datetime', required: true }, { name: 'to', label: 'To', type: 'datetime', required: true }, { name: 'reason', label: 'Reason', type: 'text', required: true, hint: 'Classes already planned in this time are flagged.' }]} onSubmit={(v) => post(`/arenas/${arena.id}/closures`, { from: zonedToIso(String(v.from)), to: zonedToIso(String(v.to)), reason: v.reason })} />}
      {drop && <Confirm title="Remove this closure?" text={drop.reason} danger onClose={() => setDrop(null)} onDone={() => { setDrop(null); q.reload(); }} action={() => api('DELETE', `/arenas/${arena.id}/closures/${drop.id}`)} />}
    </Modal>
  );
}
