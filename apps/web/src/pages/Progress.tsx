import { useState } from 'react';
import { post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { LEVELS, MANAGER_ROLES, ROLE } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { label } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import type { Rider } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Load, PageHead, Table } from '../ui/kit';
import { opts } from '../ui/pickers';

export function Progress() {
  const { user } = useAuth();
  const { branchId, branch } = useBranch();
  const role = user!.role as Role;
  const canSet = role === ROLE.COACH || MANAGER_ROLES.includes(role);
  const [level, setLevel] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Rider | null>(null);
  const list = useQuery<{ total: number; riders: Rider[] }>(branchId ? `/riders${qs({ branchId, q: q.trim(), status: 'active', limit: 50 })}` : null);
  const rows = (list.data?.riders ?? []).filter((r) => !level || r.level === level);
  return (
    <>
      <PageHead title="Progress" sub={`${branch?.name ?? ''} · rider levels`} />
      <div className="page">
        <Card flex>
          <div className="filters">
            <input aria-label="Search riders" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Any level</option>{LEVELS.map((l) => <option key={l} value={l}>{label(l)}</option>)}</select>
          </div>
          <Load q={list}>{() => <Table rowKey={(r) => r.id} rows={rows} empty="No riders." cols={[{ head: 'Rider', cell: (r) => <b>{r.fullName}</b> }, { head: 'Level', cell: (r) => <Badge value={r.level} /> }, { head: 'Born', cell: (r) => r.dateOfBirth }, { head: '', right: true, width: '1fr', cell: (r) => canSet ? <Btn small onClick={() => setEdit(r)}>Set level</Btn> : null }]} />}</Load>
        </Card>
      </div>
      {edit && <FormDialog title={`Level: ${edit.fullName}`} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} initial={{ level: edit.level }} fields={[{ name: 'level', label: 'Level', type: 'select', required: true, options: opts(LEVELS) }]} onSubmit={(v) => post(`/riders/${edit.id}/level`, { level: v.level })} />}
    </>
  );
}
