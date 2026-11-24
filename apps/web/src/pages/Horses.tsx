import { useState } from 'react';
import { api, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { HORSE_STATUSES, HORSE_TEAM, INCIDENT_SEVERITIES, INCIDENT_STATUSES, LEVELS, MANAGER_ROLES } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { addDays, dayEndIso, dayStartIso, fmtDateTime, label, todayLocal, zonedToIso } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import type { Horse } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Load, Modal, PageHead, Table, Tabs } from '../ui/kit';
import { opts, useArenas } from '../ui/pickers';

interface Incident { id: string; severity: string; kind: string; status: string; description: string; occurredAt: string | number; riderName?: string | null; horseName?: string | null }
interface Workload { sessionsToday?: number; sessionsThisWeek?: number; [k: string]: unknown }

export function Horses() {
  const { user } = useAuth();
  const { branchId, branch } = useBranch();
  const role = user!.role as Role;
  const manager = MANAGER_ROLES.includes(role);
  const team = HORSE_TEAM.includes(role);
  const arenas = useArenas();
  const [tab, setTab] = useState<'horses' | 'incidents'>('horses');
  const [form, setForm] = useState<null | 'new' | { edit: Horse } | { status: Horse } | { load: Horse } | 'incident' | { istatus: Incident }>(null);
  const [q, setQ] = useState('');
  const horses = useQuery<{ horses: Horse[] }>(branchId && tab === 'horses' ? `/horses${qs({ branchId, q: q.trim() })}` : null);
  const incidents = useQuery<{ total: number; incidents: Incident[] }>(branchId && tab === 'incidents' ? `/incidents${qs({ branchId })}` : null);
  const reload = () => { horses.reload(); incidents.reload(); setForm(null); };
  const arenaName = (id: string) => arenas.options.find((o) => o.value === id)?.label ?? '';

  const horseFields = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'suitableLevels', label: 'Suitable levels', type: 'checks', options: opts(LEVELS), required: true },
    { name: 'arenaIds', label: 'Arenas it may work in', type: 'checks', options: arenas.options },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ] as const;

  return (
    <>
      <PageHead title="Horses" sub={branch?.name} actions={manager && tab === 'horses' ? <Btn kind="primary" onClick={() => setForm('new')}>New horse</Btn> : <Btn kind="primary" onClick={() => setForm('incident')}>Report incident</Btn>} />
      <div className="page">
        <Tabs tabs={[{ id: 'horses', label: 'Horses' }, { id: 'incidents', label: 'Incidents' }]} value={tab} onChange={setTab} />
        {tab === 'horses' && (
          <Card flex>
            <div className="filters"><input aria-label="Search horses" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <Load q={horses}>{(d) => <Table rowKey={(h) => h.id} rows={d.horses} empty="No horses yet." cols={[
              { head: 'Horse', cell: (h) => <b>{h.name}</b> }, { head: 'Status', cell: (h) => <Badge value={h.status} /> },
              { head: 'Levels', cell: (h) => h.suitableLevels.map(label).join(', '), width: '1.4fr' }, { head: 'Arenas', cell: (h) => h.arenaIds.map(arenaName).join(', '), width: '1.4fr' },
              { head: '', width: '2.2fr', right: true, cell: (h) => (
                <span className="actions"><Btn small onClick={() => setForm({ load: h })}>Workload</Btn>{team && <Btn small onClick={() => setForm({ status: h })}>Status</Btn>}{manager && <Btn small onClick={() => setForm({ edit: h })}>Edit</Btn>}</span>
              ) },
            ]} />}</Load>
          </Card>
        )}
        {tab === 'incidents' && (
          <Card flex><Load q={incidents}>{(d) => <Table rowKey={(i) => i.id} rows={d.incidents} empty="No incidents recorded." onRow={manager ? (i) => setForm({ istatus: i }) : undefined} cols={[
            { head: 'When', cell: (i) => fmtDateTime(i.occurredAt) }, { head: 'Severity', cell: (i) => <Badge value={i.severity} />, width: '0.8fr' }, { head: 'Kind', cell: (i) => i.kind },
            { head: 'Horse', cell: (i) => i.horseName ?? '' }, { head: 'Rider', cell: (i) => i.riderName ?? '' }, { head: 'Status', cell: (i) => <Badge value={i.status} /> }, { head: 'What happened', cell: (i) => i.description, width: '2fr' },
          ]} />}</Load></Card>
        )}
      </div>

      {form === 'new' && <FormDialog title="New horse" onClose={() => setForm(null)} onDone={reload} initial={{ suitableLevels: [LEVELS[0]], arenaIds: [] }} fields={[...horseFields]} onSubmit={(v) => post('/horses', { branchId, name: v.name, suitableLevels: v.suitableLevels, arenaIds: v.arenaIds ?? [], ...(v.notes ? { notes: v.notes } : {}) })} />}
      {typeof form === 'object' && form && 'edit' in form && <FormDialog title={`Edit ${form.edit.name}`} onClose={() => setForm(null)} onDone={reload} initial={{ name: form.edit.name, suitableLevels: form.edit.suitableLevels, arenaIds: form.edit.arenaIds, notes: form.edit.notes ?? '' }} fields={[...horseFields]} onSubmit={(v) => api('PATCH', `/horses/${form.edit.id}`, { name: v.name, suitableLevels: v.suitableLevels, arenaIds: v.arenaIds ?? [], notes: v.notes || null })} />}
      {typeof form === 'object' && form && 'status' in form && <FormDialog title={`Status: ${form.status.name}`} onClose={() => setForm(null)} onDone={reload} initial={{ status: form.status.status }} fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: opts(HORSE_STATUSES) }, { name: 'reason', label: 'Reason', type: 'text', hint: 'Needed for medical hold, injury and retirement.' }]} onSubmit={(v) => post(`/horses/${form.status.id}/status`, { status: v.status, ...(v.reason ? { reason: v.reason } : {}) })} />}
      {typeof form === 'object' && form && 'load' in form && <WorkloadDialog horse={form.load} onClose={() => setForm(null)} />}
      {form === 'incident' && <FormDialog title="Report an incident" onClose={() => setForm(null)} onDone={reload} initial={{ severity: 'low', occurredAt: '' }} fields={[
        { name: 'severity', label: 'Severity', type: 'select', required: true, options: opts(INCIDENT_SEVERITIES) }, { name: 'kind', label: 'What kind', type: 'text', required: true, hint: 'For example fall, bite, equipment, near miss.' },
        { name: 'occurredAt', label: 'When it happened', type: 'datetime', required: true }, { name: 'description', label: 'What happened', type: 'textarea', required: true },
      ]} onSubmit={(v) => post('/incidents', { branchId, severity: v.severity, kind: v.kind, description: v.description, occurredAt: zonedToIso(String(v.occurredAt)) })} />}
      {typeof form === 'object' && form && 'istatus' in form && <FormDialog title="Update incident" onClose={() => setForm(null)} onDone={reload} initial={{ status: form.istatus.status }} fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: opts(INCIDENT_STATUSES) }, { name: 'note', label: 'Note', type: 'text' }]} onSubmit={(v) => post(`/incidents/${form.istatus.id}/status`, { status: v.status, ...(v.note ? { note: v.note } : {}) })} />}
    </>
  );
}

function WorkloadDialog({ horse, onClose }: { horse: Horse; onClose: () => void }) {
  const day = todayLocal();
  const q = useQuery<Workload>(`/horses/${horse.id}/workload${qs({ from: dayStartIso(day), to: dayEndIso(addDays(day, 6)) })}`);
  return (
    <Modal title={`Workload: ${horse.name}`} onClose={onClose}>
      <p className="sub">The next 7 days.</p>
      <Load q={q}>{(w) => <dl className="kv">{Object.entries(w).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => <><dt key={`k${k}`}>{label(k.replace(/([A-Z])/g, '_$1').toLowerCase())}</dt><dd key={`v${k}`}>{String(v)}</dd></>)}</dl>}</Load>
    </Modal>
  );
}
