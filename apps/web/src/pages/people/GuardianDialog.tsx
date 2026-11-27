import { useState } from 'react';
import { post } from '../../api/client';
import { useBranch } from '../../lib/branch';
import { qs, useQuery } from '../../lib/useApi';
import { FormDialog } from '../../ui/FormDialog';
import { Btn, Load, Modal, Table, useAct } from '../../ui/kit';

interface Customer { id: string; fullName: string; email: string | null; phone: string | null; riders: { fullName: string }[] }

/** Links a parent to a rider: find them first, so nobody is entered twice; create them here if they are new (CUS-009). */
export function GuardianDialog({ riderId, onClose, onDone }: { riderId: string; onClose: () => void; onDone: () => void }) {
  const { branchId } = useBranch();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const found = useQuery<{ customers: Customer[] }>(q.trim().length >= 2 ? `/accounts/customers${qs({ branchId, q: q.trim() })}` : null);
  const act = useAct();
  const link = (accountId: string) => post(`/riders/${riderId}/guardians`, { accountId });
  if (adding) {
    return (
      <FormDialog title="New parent or guardian" submit="Create and link" onClose={() => setAdding(false)} onDone={onDone}
        fields={[
          { name: 'fullName', label: 'Full name', type: 'text', required: true },
          { name: 'phone', label: 'Phone', type: 'tel', hint: 'Digits with an optional leading +. Give a phone number or an email.' },
          { name: 'email', label: 'Email', type: 'email' },
        ]}
        onSubmit={async (v) => {
          const made = await post<{ id: string }>('/accounts/customers', { branchId, fullName: v.fullName, ...(v.phone ? { phone: v.phone } : {}), ...(v.email ? { email: v.email } : {}) });
          await link(made.id);
        }} />
    );
  }
  return (
    <Modal title="Add a guardian" onClose={onClose}>
      <div className="field"><label htmlFor="gq">Find the parent by name, phone or email</label><input id="gq" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least 2 characters" /></div>
      <Load q={found}>{(d) => <Table rowKey={(a) => a.id} rows={d.customers} empty="Nobody matches. Add them as a new guardian." onRow={(a) => void act(() => link(a.id), 'Guardian added').then((ok) => ok && onDone())} cols={[
        { head: 'Name', cell: (a) => <b>{a.fullName}</b> }, { head: 'Contact', cell: (a) => a.phone ?? a.email ?? '' }, { head: 'Riders', cell: (a) => a.riders.map((r) => r.fullName).join(', ') },
      ]} />}</Load>
      <div className="form-actions"><Btn kind="primary" onClick={() => setAdding(true)}>New guardian</Btn></div>
    </Modal>
  );
}
