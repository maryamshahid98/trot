import { useState } from 'react';
import { api, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { HORSE_STATUSES, HORSE_TEAM, LEVELS, MANAGER_ROLES } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { addDays, dayEndIso, dayStartIso, fmtDateTime, label, todayLocal } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import type { Horse } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Load, Modal, PageHead, Table, Tabs } from '../ui/kit';
import { opts, useArenas } from '../ui/pickers';
import { CLASS_FORMATS } from '../constants';
import { asValues, given, numberOrNull, textOrNull } from '../lib/form';
import type { Values } from '../ui/FormDialog';
import { HorseRecord } from './HorseRecord';
import { IncidentDialog, IncidentList, ReportIncident } from './Incidents';

const PROFILE_KEYS = ['owner', 'stable', 'stall', 'maxRiderWeightKg', 'minRiderAge', 'maxSessionsPerDay', 'maxSessionsPerWeek'] as const;
const horseBody = (v: Values) => ({
  owner: textOrNull(v.owner), stable: textOrNull(v.stable), stall: textOrNull(v.stall), maxRiderWeightKg: numberOrNull(v.maxRiderWeightKg), minRiderAge: numberOrNull(v.minRiderAge),
  maxSessionsPerDay: numberOrNull(v.maxSessionsPerDay), maxSessionsPerWeek: numberOrNull(v.maxSessionsPerWeek), formats: v.formats ?? [],
});


export function Horses() {
  const { user } = useAuth();
  const { branchId, branch } = useBranch();
  const role = user!.role as Role;
  const manager = MANAGER_ROLES.includes(role);
  const team = HORSE_TEAM.includes(role);
  const arenas = useArenas();
  const [tab, setTab] = useState<'horses' | 'incidents'>('horses');
  const [form, setForm] = useState<null | 'new' | { edit: Horse } | { status: Horse } | { load: Horse } | { record: Horse } | 'incident' | { incidentId: string }>(null);
  const [q, setQ] = useState('');
  const horses = useQuery<{ horses: Horse[] }>(branchId && tab === 'horses' ? `/horses${qs({ branchId, q: q.trim() })}` : null);
  const incidents = useQuery<{ total: number; incidents: Parameters<typeof IncidentList>[0]['rows'] }>(branchId && tab === 'incidents' ? `/incidents${qs({ branchId })}` : null);
  const reload = () => { horses.reload(); incidents.reload(); setForm(null); };
  const arenaName = (id: string) => arenas.options.find((o) => o.value === id)?.label ?? '';

  const horseFields = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'suitableLevels', label: 'Suitable levels', type: 'checks', options: opts(LEVELS), required: true },
    { name: 'arenaIds', label: 'Arenas it may work in', type: 'checks', options: arenas.options },
    { name: 'owner', label: 'Owner', type: 'text' }, { name: 'stable', label: 'Stable', type: 'text' }, { name: 'stall', label: 'Stall', type: 'text' },
    { name: 'maxRiderWeightKg', label: 'Heaviest rider (kg)', type: 'number', min: 10 }, { name: 'minRiderAge', label: 'Youngest rider (years)', type: 'number', min: 0 },
    { name: 'formats', label: 'Kinds of work (none ticked means any)', type: 'checks', options: opts([...CLASS_FORMATS, 'ride']) },
    { name: 'maxSessionsPerDay', label: 'Most sessions a day', type: 'number', min: 1, hint: 'Empty uses the club rule.' }, { name: 'maxSessionsPerWeek', label: 'Most sessions a week', type: 'number', min: 1, hint: 'Empty uses the club rule.' },
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
              { head: 'Horse', cell: (h) => <span><b>{h.name}</b>{h.stable || h.stall ? <><br /><span className="sub">{[h.stable, h.stall].filter(Boolean).join(' · ')}</span></> : null}</span> }, { head: 'Status', cell: (h) => <Badge value={h.status} /> },
              { head: 'Limits', cell: (h) => [h.maxRiderWeightKg ? `≤ ${h.maxRiderWeightKg} kg` : null, h.minRiderAge ? `${h.minRiderAge}+ years` : null, h.nextCareDue ? `care due ${h.nextCareDue}` : null].filter(Boolean).join(', ') },
              { head: 'Levels', cell: (h) => h.suitableLevels.map(label).join(', '), width: '1.4fr' }, { head: 'Arenas', cell: (h) => h.arenaIds.map(arenaName).join(', '), width: '1.4fr' },
              { head: '', width: '2.2fr', right: true, cell: (h) => (
                <span className="actions"><Btn small onClick={() => setForm({ record: h })}>Record</Btn><Btn small onClick={() => setForm({ load: h })}>Workload</Btn>{team && <Btn small onClick={() => setForm({ status: h })}>Status</Btn>}{manager && <Btn small onClick={() => setForm({ edit: h })}>Edit</Btn>}</span>
              ) },
            ]} />}</Load>
          </Card>
        )}
        {tab === 'incidents' && (
          <Card flex><Load q={incidents}>{(d) => <IncidentList rows={d.incidents} onOpen={(i) => setForm({ incidentId: i.id })} />}</Load></Card>
        )}
      </div>

      {form === 'new' && <FormDialog title="New horse" onClose={() => setForm(null)} onDone={reload} initial={{ suitableLevels: [LEVELS[0]], arenaIds: [] }} fields={[...horseFields]} onSubmit={(v) => post('/horses', { branchId, name: v.name, suitableLevels: v.suitableLevels, arenaIds: v.arenaIds ?? [], ...given(horseBody(v)), ...(v.notes ? { notes: v.notes } : {}) })} />}
      {typeof form === 'object' && form && 'record' in form && <HorseRecord horse={form.record} canAdd={team} onClose={() => { setForm(null); horses.reload(); }} />}
      {typeof form === 'object' && form && 'edit' in form && <FormDialog title={`Edit ${form.edit.name}`} onClose={() => setForm(null)} onDone={reload} initial={{ ...asValues(form.edit, PROFILE_KEYS), formats: form.edit.formats, name: form.edit.name, suitableLevels: form.edit.suitableLevels, arenaIds: form.edit.arenaIds, notes: form.edit.notes ?? '' }} fields={[...horseFields]} onSubmit={(v) => api('PATCH', `/horses/${form.edit.id}`, { ...horseBody(v), name: v.name, suitableLevels: v.suitableLevels, arenaIds: v.arenaIds ?? [], notes: v.notes || null })} />}
      {typeof form === 'object' && form && 'status' in form && <FormDialog title={`Status: ${form.status.name}`} onClose={() => setForm(null)} onDone={reload} initial={{ status: form.status.status }} fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: opts(HORSE_STATUSES) }, { name: 'reason', label: 'Reason', type: 'text', hint: 'Needed for medical hold, injury and retirement.' }]} onSubmit={(v) => post(`/horses/${form.status.id}/status`, { status: v.status, ...(v.reason ? { reason: v.reason } : {}) })} />}
      {form === 'incident' && <ReportIncident onClose={() => setForm(null)} onDone={reload} />}
      {typeof form === 'object' && form && 'incidentId' in form && <IncidentDialog id={form.incidentId} onClose={reload} />}
      {typeof form === 'object' && form && 'load' in form && <WorkloadDialog horse={form.load} onClose={() => setForm(null)} />}
    </>
  );
}

interface Session { assignmentId: string; title: string; startsAt: number; endsAt: number; riderName: string | null }
function WorkloadDialog({ horse, onClose }: { horse: Horse; onClose: () => void }) {
  const day = todayLocal();
  const q = useQuery<{ total: number; sessions: Session[] }>(`/horses/${horse.id}/workload${qs({ from: dayStartIso(addDays(day, -30)), to: dayEndIso(addDays(day, 30)) })}`);
  return (
    <Modal title={`Workload: ${horse.name}`} onClose={onClose} wide>
      <Load q={q}>{(w) => (<>
        <p className="sub">{w.total} sessions from 30 days ago to 30 days ahead. {Math.round(w.sessions.reduce((n, x) => n + (x.endsAt - x.startsAt), 0) / 360_000) / 10} hours.</p>
        <Table rowKey={(x) => x.assignmentId} rows={w.sessions} empty="No sessions." cols={[
          { head: 'When', cell: (x) => fmtDateTime(x.startsAt) }, { head: 'Class or ride', cell: (x) => <b>{x.title}</b> }, { head: 'Rider', cell: (x) => x.riderName ?? 'Everyone' },
          { head: 'Minutes', cell: (x) => Math.round((x.endsAt - x.startsAt) / 60_000) },
        ]} />
      </>)}</Load>
    </Modal>
  );
}
