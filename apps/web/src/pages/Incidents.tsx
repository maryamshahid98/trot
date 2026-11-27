import { useState } from 'react';
import { api, fetchFile, post, uploadFile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { FRONT_DESK, INCIDENT_SEVERITIES, INCIDENT_TRANSITIONS, MANAGER_ROLES } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { fmtDateTime, zonedToIso } from '../lib/format';
import { asValues, given, textOrNull } from '../lib/form';
import { qs, useQuery } from '../lib/useApi';
import type { Horse, Rider } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Load, Modal, Table, useAct } from '../ui/kit';
import { opts, useArenas, useStaff } from '../ui/pickers';

interface Row { id: string; number: string; severity: string; kind: string; status: string; description: string; occurredAt: number; riderName: string | null; horseName: string | null }
interface Detail extends Row {
  riderId: string | null; horseId: string | null; arenaId: string | null; arenaName: string | null; people: string | null; witnesses: string | null; immediateAction: string | null; reportedByName: string | null;
  actions: { id: string; action: string; ownerName: string | null; dueOn: string | null; doneAt: string | null; doneNote: string | null }[];
  files: { id: string; fileName: string }[];
}

/** The rider, horse and arena pickers shared by reporting and editing. */
function useSubjects() {
  const { branchId } = useBranch();
  const riders = useQuery<{ riders: Rider[] }>(branchId ? `/riders${qs({ branchId, limit: 200 })}` : null);
  const horses = useQuery<{ horses: Horse[] }>(branchId ? `/horses${qs({ branchId })}` : null);
  const arenas = useArenas();
  return [
    { name: 'riderId', label: 'Rider involved', type: 'select', options: (riders.data?.riders ?? []).map((r) => ({ value: r.id, label: r.fullName })), blank: 'None' },
    { name: 'horseId', label: 'Horse involved', type: 'select', options: (horses.data?.horses ?? []).map((h) => ({ value: h.id, label: h.name })), blank: 'None' },
    { name: 'arenaId', label: 'Where', type: 'select', options: arenas.options, blank: 'Elsewhere' },
    { name: 'people', label: 'Other people affected', type: 'textarea' }, { name: 'witnesses', label: 'Witnesses', type: 'textarea' },
    { name: 'immediateAction', label: 'Immediate action taken', type: 'textarea', hint: 'Required before a high or critical incident can be closed.' },
  ] as const;
}
const subjectBody = (v: Record<string, unknown>) => ({ riderId: textOrNull(v.riderId), horseId: textOrNull(v.horseId), arenaId: textOrNull(v.arenaId), people: textOrNull(v.people), witnesses: textOrNull(v.witnesses), immediateAction: textOrNull(v.immediateAction) });

export function ReportIncident({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { branchId } = useBranch();
  const subjects = useSubjects();
  return (
    <FormDialog wide title="Report an incident" submit="Report" onClose={onClose} onDone={onDone} initial={{ severity: 'low' }}
      fields={[
        { name: 'severity', label: 'Severity', type: 'select', required: true, options: opts(INCIDENT_SEVERITIES) }, { name: 'kind', label: 'What kind', type: 'text', required: true, hint: 'For example fall, bite, equipment, near miss.' },
        { name: 'occurredAt', label: 'When it happened', type: 'datetime', required: true }, { name: 'description', label: 'What happened', type: 'textarea', required: true }, ...subjects,
      ]}
      onSubmit={async (v) => {
        if (!v.occurredAt) throw new Error('Say when it happened.');
        await post('/incidents', { branchId, severity: v.severity, kind: v.kind, description: v.description, occurredAt: zonedToIso(String(v.occurredAt)), ...given(subjectBody(v)) });
      }} />
  );
}

export function IncidentList({ rows, onOpen }: { rows: Row[]; onOpen: (r: Row) => void }) {
  return (
    <Table rowKey={(i) => i.id} rows={rows} empty="No incidents recorded." onRow={onOpen} cols={[
      { head: 'Number', cell: (i) => <b>{i.number}</b>, width: '0.8fr' }, { head: 'When', cell: (i) => fmtDateTime(i.occurredAt) }, { head: 'Severity', cell: (i) => <Badge value={i.severity} />, width: '0.8fr' }, { head: 'Kind', cell: (i) => i.kind },
      { head: 'Horse', cell: (i) => i.horseName ?? '—' }, { head: 'Rider', cell: (i) => i.riderName ?? '—' }, { head: 'Status', cell: (i) => <Badge value={i.status} /> }, { head: 'What happened', cell: (i) => i.description, width: '2fr' },
    ]} />
  );
}

export function IncidentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth();
  const role = user!.role as Role;
  const manager = MANAGER_ROLES.includes(role);
  const front = FRONT_DESK.includes(role);
  const act = useAct();
  const q = useQuery<Detail>(`/incidents/${id}/detail`);
  const staff = useStaff();
  const subjects = useSubjects();
  const [dlg, setDlg] = useState<null | 'edit' | 'status' | 'action' | { done: string }>(null);
  const done = () => { setDlg(null); q.reload(); };
  const d = q.data;
  const closed = d?.status === 'closed';
  const upload = (file: File | undefined) => file && void act(async () => { await uploadFile(`/incidents/${id}/file`, file); q.reload(); }, 'File attached');
  const download = (f: { id: string; fileName: string }) => void act(async () => {
    const { blob } = await fetchFile(`/incidents/${id}/files/${f.id}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  return (
    <Modal title={d ? `Incident ${d.number}` : 'Incident'} onClose={onClose} wide>
      <Load q={q}>{(i) => (<>
        <div className="actions" style={{ paddingBottom: 12 }}>
          <Badge value={i.severity} /> <Badge value={i.status} /><span style={{ flex: 1 }} />
          {front && !closed && <Btn onClick={() => setDlg('edit')}>Edit details</Btn>}
          {manager && <Btn kind="primary" onClick={() => setDlg('status')}>Move to next stage</Btn>}
        </div>
        <dl className="kv">
          <dt>What</dt><dd>{i.kind}: {i.description}</dd><dt>When</dt><dd>{fmtDateTime(i.occurredAt)}</dd><dt>Reported by</dt><dd>{i.reportedByName ?? '—'}</dd>
          <dt>Rider</dt><dd>{i.riderName ?? '—'}</dd><dt>Horse</dt><dd>{i.horseName ?? '—'}</dd><dt>Where</dt><dd>{i.arenaName ?? '—'}</dd>
          <dt>Other people</dt><dd>{i.people ?? '—'}</dd><dt>Witnesses</dt><dd>{i.witnesses ?? '—'}</dd><dt>Immediate action</dt><dd>{i.immediateAction ?? '—'}</dd>
        </dl>
        <Card title="Corrective actions" actions={manager && !closed ? <Btn small kind="primary" onClick={() => setDlg('action')}>Add action</Btn> : undefined}>
          <Table rowKey={(a) => a.id} rows={i.actions} empty="None." cols={[
            { head: 'Action', cell: (a) => a.action, width: '2fr' }, { head: 'Owner', cell: (a) => a.ownerName ?? '' }, { head: 'Due', cell: (a) => a.dueOn ?? '' },
            { head: 'Done', cell: (a) => (a.doneAt ? `${fmtDateTime(a.doneAt)}: ${a.doneNote}` : <Badge value="open" />), width: '1.6fr' },
            { head: '', right: true, cell: (a) => (manager && !a.doneAt && !closed ? <Btn small onClick={() => setDlg({ done: a.id })}>Mark done</Btn> : null) },
          ]} />
        </Card>
        <Card title="Evidence">
          <Table rowKey={(f) => f.id} rows={i.files} empty="No files." cols={[{ head: 'File', cell: (f) => f.fileName, width: '3fr' }, { head: '', right: true, cell: (f) => <Btn small onClick={() => download(f)}>Download</Btn> }]} />
          {!closed && <div className="field"><label htmlFor="evidence">Add a photo or PDF</label><input id="evidence" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} /></div>}
        </Card>
      </>)}</Load>
      {dlg === 'edit' && d && <FormDialog wide title="Edit details" onClose={() => setDlg(null)} onDone={done} initial={asValues(d, ['riderId', 'horseId', 'arenaId', 'people', 'witnesses', 'immediateAction'])} fields={[...subjects]} onSubmit={(v) => api('PATCH', `/incidents/${id}`, subjectBody(v))} />}
      {dlg === 'status' && d && <FormDialog title="Move to next stage" onClose={() => setDlg(null)} onDone={done}
        fields={[{ name: 'status', label: 'Next stage', type: 'select', required: true, options: opts(INCIDENT_TRANSITIONS[d.status] ?? []) }, { name: 'note', label: 'Note', type: 'text', hint: 'Needed to close or reopen.' }]}
        onSubmit={(v) => post(`/incidents/${id}/status`, { status: v.status, ...(v.note ? { note: v.note } : {}) })} />}
      {dlg === 'action' && <FormDialog title="Add a corrective action" onClose={() => setDlg(null)} onDone={done}
        fields={[{ name: 'action', label: 'What must be done', type: 'textarea', required: true }, { name: 'ownerId', label: 'Who', type: 'select', options: staff.options, blank: 'Not assigned' }, { name: 'dueOn', label: 'By', type: 'date' }]}
        onSubmit={(v) => post(`/incidents/${id}/actions`, given({ action: v.action, ownerId: textOrNull(v.ownerId), dueOn: textOrNull(v.dueOn) }))} />}
      {typeof dlg === 'object' && dlg && <FormDialog title="Mark done" onClose={() => setDlg(null)} onDone={done} fields={[{ name: 'note', label: 'What was done', type: 'text', required: true }]} onSubmit={(v) => post(`/incidents/${id}/actions/${dlg.done}/done`, { note: v.note })} />}
    </Modal>
  );
}
