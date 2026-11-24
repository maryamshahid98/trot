import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post } from '../../api/client';
import { RIDER_FILTER_STATUSES } from '../../constants';
import { useBranch } from '../../lib/branch';
import { label } from '../../lib/format';
import { qs, useQuery } from '../../lib/useApi';
import type { Rider } from '../../lib/types';
import { FormDialog } from '../../ui/FormDialog';
import { Badge, Btn, Card, Load, PageHead, Table } from '../../ui/kit';
import { RiderDialog } from './RiderDialog';

const PAGE = 25;
export function People() {
  const { branchId, branch } = useBranch();
  const [params] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const [q, setQ] = useState(urlQ);
  const [seenUrlQ, setSeenUrlQ] = useState(urlQ);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  // The top search box can send a new search while this screen is already open.
  if (seenUrlQ !== urlQ) { setSeenUrlQ(urlQ); setQ(urlQ); setOffset(0); }
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useQuery<{ total: number; riders: Rider[] }>(branchId ? `/riders${qs({ branchId, q: q.trim(), status, limit: PAGE, offset })}` : null);
  return (
    <>
      <PageHead title="People" sub={`${branch?.name ?? ''} · riders`} actions={<Btn kind="primary" onClick={() => setAdding(true)}>New rider</Btn>} />
      <div className="page">
        <Card flex>
          <div className="filters">
            <input aria-label="Search riders" placeholder="Search by name" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
            <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
              <option value="">Any status</option>{RIDER_FILTER_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </div>
          <Load q={list}>{(d) => (
            <>
              <Table rowKey={(r) => r.id} rows={d.riders} empty="No riders found." onRow={(r) => setOpen(r.id)} cols={[
                { head: 'Rider', cell: (r) => <b>{r.fullName}</b>, width: '1.6fr' }, { head: 'Born', cell: (r) => r.dateOfBirth },
                { head: 'Level', cell: (r) => label(r.level) }, { head: 'Status', cell: (r) => <Badge value={r.status} /> }, { head: 'Walk-in', cell: (r) => (r.isWalkIn ? 'Yes' : ''), width: '0.6fr' },
              ]} />
              <div className="actions" style={{ paddingTop: 12 }}>
                <Btn small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ Previous</Btn>
                <span className="sub">{d.total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</span>
                <Btn small disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Next ›</Btn>
              </div>
            </>
          )}</Load>
        </Card>
      </div>
      {open && <RiderDialog riderId={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
      {adding && (
        <FormDialog title="New rider" submit="Create rider" onClose={() => setAdding(false)} onDone={() => { setAdding(false); list.reload(); }}
          initial={{ isWalkIn: true }}
          fields={[
            { name: 'fullName', label: 'Full name', type: 'text', required: true }, { name: 'dateOfBirth', label: 'Date of birth', type: 'date', required: true, hint: 'Riders under 18 need a guardian account linked afterwards.' },
            { name: 'ecName', label: 'Emergency contact name', type: 'text' }, { name: 'ecPhone', label: 'Emergency contact phone', type: 'tel' },
            { name: 'medicalNotes', label: 'Medical notes', type: 'textarea' }, { name: 'allergies', label: 'Allergies', type: 'textarea' },
            { name: 'isWalkIn', label: 'Walk-in rider (no app account)', type: 'checkbox' },
          ]}
          onSubmit={(v) => post('/riders', {
            branchId, fullName: v.fullName, dateOfBirth: v.dateOfBirth, isWalkIn: v.isWalkIn === true,
            ...(v.ecName && v.ecPhone ? { emergencyContact: { name: v.ecName, phone: v.ecPhone } } : {}),
            ...(v.medicalNotes ? { medicalNotes: v.medicalNotes } : {}), ...(v.allergies ? { allergies: v.allergies } : {}),
          })} />
      )}
    </>
  );
}
