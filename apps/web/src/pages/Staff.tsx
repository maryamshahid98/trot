import { useState } from 'react';
import { api, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ASSIGNABLE_ROLES, LOCALE, MANAGER_ROLES } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { fmtDateTime, label, zonedToIso } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Confirm, Load, PageHead, Table, Tabs, useAct } from '../ui/kit';
import { opts } from '../ui/pickers';

interface Account { id: string; fullName: string; email: string; phone: string | null; role: string; status: string; branchIds?: string[] }
interface Leave { id: string; staffId: string; staffName?: string; status: string; from: number; to: number; reason?: string | null }
type F = null | 'new' | 'leave' | { role: Account } | { status: Account } | { reset: Account } | { branches: Account } | { decide: Leave } | { cancel: Leave };

export function Staff() {
  const { user, branches } = useAuth();
  const { branchId, branch } = useBranch();
  const role = user!.role as Role;
  const manager = MANAGER_ROLES.includes(role);
  const act = useAct();
  const [tab, setTab] = useState<'accounts' | 'leave'>(manager ? 'accounts' : 'leave');
  const [f, setF] = useState<F>(null);
  const [q, setQ] = useState('');
  const accounts = useQuery<{ total: number; accounts: Account[] }>(manager && tab === 'accounts' && branchId ? `/accounts${qs({ branchId, q: q.trim(), limit: 50 })}` : null);
  const leave = useQuery<{ leave: Leave[] }>(tab === 'leave' ? `/staff-leave` : null);
  const reload = () => { accounts.reload(); leave.reload(); setF(null); };
  const branchOpts = branches.map((b) => ({ value: b.id, label: b.name }));

  return (
    <>
      <PageHead title="Staff" sub={branch?.name} actions={tab === 'accounts' && manager ? <Btn kind="primary" onClick={() => setF('new')}>New account</Btn> : tab === 'leave' ? <Btn kind="primary" onClick={() => setF('leave')}>Request leave</Btn> : undefined} />
      <div className="page">
        <Tabs tabs={[...(manager ? [{ id: 'accounts' as const, label: 'Accounts' }] : []), { id: 'leave', label: 'Leave' }]} value={tab} onChange={setTab} />
        {tab === 'accounts' && manager && (
          <Card flex>
            <div className="filters"><input aria-label="Search accounts" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <Load q={accounts}>{(d) => <Table rowKey={(a) => a.id} rows={d.accounts} empty="No accounts." cols={[
              { head: 'Name', cell: (a) => <b>{a.fullName}</b>, width: '1.4fr' }, { head: 'Email', cell: (a) => a.email, width: '1.6fr' }, { head: 'Role', cell: (a) => label(a.role), width: '0.8fr' }, { head: 'Status', cell: (a) => <Badge value={a.status} />, width: '0.8fr' },
              { head: '', width: '3.4fr', right: true, cell: (a) => a.role === 'customer' ? null : (
                <span className="actions"><Btn small onClick={() => setF({ role: a })}>Role</Btn><Btn small onClick={() => setF({ status: a })}>Status</Btn><Btn small onClick={() => setF({ branches: a })}>Branches</Btn>
                  <Btn small onClick={() => void act(() => post(`/accounts/${a.id}/unlock`), 'Unlocked').then((ok) => ok && reload())}>Unlock</Btn><Btn small onClick={() => setF({ reset: a })}>Reset password</Btn></span>
              ) },
            ]} />}</Load>
          </Card>
        )}
        {tab === 'leave' && (
          <Card flex><Load q={leave}>{(d) => <Table rowKey={(l) => l.id} rows={d.leave} empty="No leave requests." cols={[
            { head: 'Who', cell: (l) => <b>{l.staffName ?? l.staffId}</b> }, { head: 'From', cell: (l) => fmtDateTime(l.from) }, { head: 'To', cell: (l) => fmtDateTime(l.to) }, { head: 'Status', cell: (l) => <Badge value={l.status} /> }, { head: 'Reason', cell: (l) => l.reason ?? '' },
            { head: '', right: true, width: '1.6fr', cell: (l) => (
              <span className="actions">{manager && l.status === 'requested' && <Btn small kind="primary" onClick={() => setF({ decide: l })}>Decide</Btn>}{(l.staffId === user!.id || manager) && l.status !== 'rejected' && <Btn small kind="danger" onClick={() => setF({ cancel: l })}>Cancel</Btn>}</span>
            ) },
          ]} />}</Load></Card>
        )}
      </div>

      {f === 'new' && <FormDialog title="New staff account" onClose={() => setF(null)} onDone={reload} initial={{ role: 'coach', locale: LOCALE.EN, branchIds: branchId ? [branchId] : [] }} fields={[
        { name: 'fullName', label: 'Full name', type: 'text', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'phone', label: 'Phone', type: 'tel', hint: 'Digits, with an optional leading +' },
        { name: 'role', label: 'Role', type: 'select', required: true, options: opts(ASSIGNABLE_ROLES) }, { name: 'branchIds', label: 'Branches', type: 'checks', options: branchOpts },
        { name: 'password', label: 'Starting password', type: 'password', required: true, hint: 'At least 12 characters. They should change it after first sign-in.' },
      ]} onSubmit={(v) => post('/accounts', { fullName: v.fullName, email: v.email, ...(v.phone ? { phone: v.phone } : {}), role: v.role, branchIds: v.branchIds, password: v.password, locale: v.locale })} />}
      {typeof f === 'object' && f && 'role' in f && <FormDialog title={`Role: ${f.role.fullName}`} onClose={() => setF(null)} onDone={reload} initial={{ role: f.role.role }} fields={[{ name: 'role', label: 'Role', type: 'select', required: true, options: opts(ASSIGNABLE_ROLES) }, { name: 'reason', label: 'Reason', type: 'text' }]} onSubmit={(v) => post(`/accounts/${f.role.id}/role`, { role: v.role, ...(v.reason ? { reason: v.reason } : {}) })} />}
      {typeof f === 'object' && f && 'status' in f && <FormDialog title={`Status: ${f.status.fullName}`} onClose={() => setF(null)} onDone={reload} initial={{ status: f.status.status }} fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: opts(['active', 'locked']) }, { name: 'reason', label: 'Reason', type: 'text' }]} onSubmit={(v) => post(`/accounts/${f.status.id}/status`, { status: v.status, ...(v.reason ? { reason: v.reason } : {}) })} />}
      {typeof f === 'object' && f && 'reset' in f && <FormDialog title={`New password: ${f.reset.fullName}`} onClose={() => setF(null)} onDone={reload} fields={[{ name: 'newPassword', label: 'New password', type: 'password', required: true, hint: 'At least 12 characters. All their sessions are signed out.' }]} onSubmit={(v) => post(`/accounts/${f.reset.id}/reset-password`, { newPassword: v.newPassword })} />}
      {typeof f === 'object' && f && 'branches' in f && <FormDialog title={`Branches: ${f.branches.fullName}`} onClose={() => setF(null)} onDone={reload} initial={{ branchIds: f.branches.branchIds ?? [] }} fields={[{ name: 'branchIds', label: 'Branches', type: 'checks', options: branchOpts }]} onSubmit={(v) => api('PUT', `/accounts/${f.branches.id}/branches`, { branchIds: v.branchIds })} />}
      {f === 'leave' && <FormDialog title="Request leave" onClose={() => setF(null)} onDone={reload} fields={[{ name: 'from', label: 'From', type: 'datetime', required: true }, { name: 'to', label: 'To', type: 'datetime', required: true }, { name: 'reason', label: 'Reason', type: 'text' }]} onSubmit={(v) => post('/staff-leave', { from: zonedToIso(String(v.from)), to: zonedToIso(String(v.to)), ...(v.reason ? { reason: v.reason } : {}) })} />}
      {typeof f === 'object' && f && 'decide' in f && <FormDialog title="Decide leave" onClose={() => setF(null)} onDone={reload} initial={{ decision: 'approve' }} fields={[{ name: 'decision', label: 'Decision', type: 'select', required: true, options: [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject' }] }, { name: 'reason', label: 'Reason', type: 'text' }]} onSubmit={(v) => post(`/staff-leave/${f.decide.id}/decision`, { decision: v.decision, ...(v.reason ? { reason: v.reason } : {}) })} />}
      {typeof f === 'object' && f && 'cancel' in f && <Confirm title="Cancel this leave?" text="" danger onClose={() => setF(null)} onDone={reload} action={() => api('DELETE', `/staff-leave/${f.cancel.id}`)} />}
    </>
  );
}
