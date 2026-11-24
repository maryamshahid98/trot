import { useState } from 'react';
import { api, ApiError, get, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { LEVELS, MANAGER_ROLES, ROLE } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { fmtDate, label } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import type { Rider } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Load, PageHead, Table, Tabs, useAct, useToast } from '../ui/kit';
import { opts } from '../ui/pickers';
import { AssessmentDialog } from './AssessmentDialog';
import type { AssessmentRow, Skill } from './AssessmentDialog';

type Tab = 'riders' | 'assessments' | 'skills';
const STATUSES = ['submitted', 'draft', 'needs_more', 'approved', 'rejected'];

export function Progress() {
  const { user } = useAuth();
  const role = user!.role as Role;
  const manager = MANAGER_ROLES.includes(role);
  const [tab, setTab] = useState<Tab>('riders');
  const tabs: { id: Tab; label: string }[] = [{ id: 'riders', label: 'Riders' }, { id: 'assessments', label: 'Assessments' }, ...(manager ? [{ id: 'skills' as Tab, label: 'Skills' }] : [])];
  const { branch } = useBranch();
  return (
    <>
      <PageHead title="Progress" sub={`${branch?.name ?? ''} · levels, skills and assessments`} />
      <div className="page">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        {tab === 'riders' && <RidersTab />}
        {tab === 'assessments' && <AssessmentsTab />}
        {tab === 'skills' && manager && <SkillsTab />}
      </div>
    </>
  );
}

function RidersTab() {
  const { user } = useAuth();
  const role = user!.role as Role;
  const { branchId } = useBranch();
  const act = useAct();
  const toast = useToast();
  const [level, setLevel] = useState('');
  const [q, setQ] = useState('');
  const [correct, setCorrect] = useState<Rider | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery<{ total: number; riders: Rider[] }>(branchId ? `/riders${qs({ branchId, q: q.trim(), status: 'active', limit: 50 })}` : null);
  const rows = (list.data?.riders ?? []).filter((r) => !level || r.level === level);
  const manager = MANAGER_ROLES.includes(role);

  const assess = (r: Rider) => void act(async () => {
    try {
      const made = await post<{ id: string }>('/assessments', { riderId: r.id });
      setOpen(made.id);
    } catch (e) {
      // This rider may already have one open: open that one instead of leaving the person stuck.
      if (e instanceof ApiError && e.status === 409) {
        const found = await get<{ assessments: { id: string; status: string }[] }>(`/assessments${qs({ branchId, riderId: r.id, limit: 10 })}`);
        const current = found.assessments.find((a) => ['draft', 'needs_more', 'submitted'].includes(a.status));
        if (current) { setOpen(current.id); return; }
      }
      throw e;
    }
  });

  return (
    <Card flex>
      <p className="sub" style={{ marginTop: 0 }}>A level changes only when an assessment is approved by a manager or owner other than the assessor. {manager ? 'To fix a mistake, use "Correct level" and say why.' : ''}</p>
      <div className="filters">
        <input aria-label="Search riders" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Any level</option>{LEVELS.map((l) => <option key={l} value={l}>{label(l)}</option>)}</select>
      </div>
      <Load q={list}>{() => (
        <Table rowKey={(r) => r.id} rows={rows} empty="No riders." cols={[
          { head: 'Rider', cell: (r) => <b>{r.fullName}</b> }, { head: 'Level', cell: (r) => <Badge value={r.level} /> },
          { head: '', right: true, width: '1.6fr', cell: (r) => (
            <span className="actions">
              {(role === ROLE.COACH || manager) && <Btn small kind="primary" onClick={() => assess(r)}>Assess</Btn>}
              {manager && <Btn small onClick={() => setCorrect(r)}>Correct level</Btn>}
            </span>
          ) },
        ]} />
      )}</Load>
      {correct && (
        <FormDialog title={`Correct level: ${correct.fullName}`} submit="Correct level" onClose={() => setCorrect(null)} onDone={() => { setCorrect(null); list.reload(); toast('Level corrected and recorded in the history'); }} initial={{ level: correct.level }}
          fields={[{ name: 'level', label: 'Level', type: 'select', required: true, options: opts(LEVELS) }, { name: 'reason', label: 'Reason', type: 'text', required: true, hint: 'For fixing a mistake. A promotion should go through an assessment.' }]}
          onSubmit={(v) => post(`/riders/${correct.id}/level`, { level: v.level, reason: v.reason })} />
      )}
      {open && <AssessmentDialog id={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </Card>
  );
}

function AssessmentsTab() {
  const { branchId } = useBranch();
  const [status, setStatus] = useState('submitted');
  const [open, setOpen] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const PAGE = 20;
  const list = useQuery<{ total: number; assessments: AssessmentRow[] }>(branchId ? `/assessments${qs({ branchId, status, limit: PAGE, offset })}` : null);
  return (
    <Card flex>
      <div className="filters">
        <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      <Load q={list}>{(d) => (
        <>
          <Table rowKey={(a) => a.id} rows={d.assessments} empty="No assessments here." onRow={(a) => setOpen(a.id)} cols={[
            { head: 'Rider', cell: (a) => <b>{a.riderName}</b> },
            { head: 'Level', cell: (a) => `${label(a.fromLevel)} → ${label(a.targetLevel)}` },
            { head: 'Recommendation', cell: (a) => label(a.recommendation) },
            { head: 'Assessor', cell: (a) => a.assessorName },
            { head: 'Status', cell: (a) => <Badge value={a.status} /> },
            { head: 'Started', cell: (a) => fmtDate(a.createdAt) },
          ]} />
          <div className="actions" style={{ paddingTop: 12 }}>
            <Btn small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ Previous</Btn>
            <span className="sub">{d.total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</span>
            <Btn small disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Next ›</Btn>
          </div>
        </>
      )}</Load>
      {open && <AssessmentDialog id={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </Card>
  );
}

function SkillsTab() {
  const { branchId } = useBranch();
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Skill | null>(null);
  const list = useQuery<{ skills: Skill[] }>(branchId ? `/skills${qs({ branchId, includeInactive: true })}` : null);
  return (
    <Card flex title="Skills a rider must show to reach each level" actions={<Btn small kind="primary" onClick={() => setAdding(true)}>Add a skill</Btn>}>
      <p className="sub" style={{ marginTop: 0 }}>A promotion to a level needs every skill listed for that level rated at 3 ("Competent") or better. If a level has no skills, the assessor's written notes are required instead.</p>
      <Load q={list}>{(d) => (
        <Table rowKey={(s) => s.id} rows={d.skills} empty="No skills yet." cols={[
          { head: 'Needed to reach', cell: (s) => <Badge value={s.forLevel} /> },
          { head: 'Skill', cell: (s) => <span><b>{s.name}</b>{s.description && <><br /><span className="sub">{s.description}</span></>}</span>, width: '2fr' },
          { head: 'Status', cell: (s) => <Badge value={s.active ? 'active' : 'inactive'} /> },
          { head: '', right: true, cell: (s) => (
            <Btn small onClick={() => setEdit(s)}>Edit</Btn>
          ) },
        ]} />
      )}</Load>
      {adding && (
        <FormDialog title="Add a skill" onClose={() => setAdding(false)} onDone={() => { setAdding(false); list.reload(); }}
          fields={[{ name: 'name', label: 'Skill', type: 'text', required: true }, { name: 'forLevel', label: 'Needed to reach level', type: 'select', required: true, options: opts(LEVELS) }, { name: 'description', label: 'What it means', type: 'text' }]}
          onSubmit={(v) => post('/skills', { branchId, name: v.name, forLevel: v.forLevel, ...(v.description ? { description: v.description } : {}) })} />
      )}
      {edit && (
        <FormDialog title={`Edit: ${edit.name}`} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} initial={{ name: edit.name, description: edit.description ?? '', active: edit.active }}
          fields={[{ name: 'name', label: 'Skill', type: 'text', required: true }, { name: 'description', label: 'What it means', type: 'text' }, { name: 'active', label: 'In use (switched-off skills are no longer required)', type: 'checkbox' }]}
          onSubmit={(v) => api('PATCH', `/skills/${edit.id}`, { name: v.name, description: v.description ? v.description : null, active: v.active === true })} />
      )}
    </Card>
  );
}
