import { useState } from 'react';
import { post } from '../api/client';
import { fmtDate, fmtDateTime, label, todayLocal } from '../lib/format';
import { given, textOrNull } from '../lib/form';
import { useQuery } from '../lib/useApi';
import { FormDialog } from '../ui/FormDialog';
import { Btn, Card, Load, Modal, Table } from '../ui/kit';
import { opts } from '../ui/pickers';

interface Care { id: string; kind: string; happenedOn: string; dueOn: string | null; notes: string | null; recordedBy: string | null }
interface Move { id: string; stable: string | null; stall: string | null; movedAt: string; movedBy: string | null }
interface Status { id: string; at: string; actorName: string | null; detail: { from: string; to: string; reason: string | null } }
const CARE = ['health', 'vaccination', 'farrier', 'medication', 'care'] as const;

/** A horse's welfare timeline: care given and due, status changes and moves (HOR-005, HOR-006). */
export function HorseRecord({ horse, canAdd, onClose }: { horse: { id: string; name: string }; canAdd: boolean; onClose: () => void }) {
  const q = useQuery<{ care: Care[]; moves: Move[]; statuses: Status[] }>(`/horses/${horse.id}/record`);
  const [adding, setAdding] = useState(false);
  const today = todayLocal();
  return (
    <Modal title={`Record: ${horse.name}`} onClose={onClose} wide>
      <Load q={q}>{(d) => (<>
        <Card title="Care" actions={canAdd ? <Btn small kind="primary" onClick={() => setAdding(true)}>Add care event</Btn> : undefined}>
          <Table rowKey={(c) => c.id} rows={d.care} empty="No care recorded." cols={[
            { head: 'Date', cell: (c) => c.happenedOn }, { head: 'Kind', cell: (c) => <b>{label(c.kind)}</b> },
            { head: 'Next due', cell: (c) => (c.dueOn ? <span className={c.dueOn <= today ? 'error' : undefined}>{c.dueOn}</span> : '') },
            { head: 'Notes', cell: (c) => c.notes ?? '', width: '2fr' }, { head: 'By', cell: (c) => c.recordedBy ?? '' },
          ]} />
        </Card>
        <Card title="Status history"><Table rowKey={(s) => s.id} rows={d.statuses} empty="No status changes." cols={[
          { head: 'When', cell: (s) => fmtDateTime(s.at) }, { head: 'Change', cell: (s) => `${label(s.detail.from)} → ${label(s.detail.to)}` }, { head: 'Reason', cell: (s) => s.detail.reason ?? '', width: '2fr' }, { head: 'By', cell: (s) => s.actorName ?? '' },
        ]} /></Card>
        <Card title="Stabling history"><Table rowKey={(m) => m.id} rows={d.moves} empty="No moves recorded." cols={[
          { head: 'When', cell: (m) => fmtDate(m.movedAt) }, { head: 'Stable', cell: (m) => m.stable ?? '' }, { head: 'Stall', cell: (m) => m.stall ?? '' }, { head: 'By', cell: (m) => m.movedBy ?? '' },
        ]} /></Card>
      </>)}</Load>
      {adding && <FormDialog title="Add care event" onClose={() => setAdding(false)} onDone={() => { setAdding(false); q.reload(); }} initial={{ happenedOn: today }}
        fields={[{ name: 'kind', label: 'Kind', type: 'select', required: true, options: opts(CARE) }, { name: 'happenedOn', label: 'Date', type: 'date', required: true }, { name: 'dueOn', label: 'Next due', type: 'date', hint: 'The reminder shown in the horse list and reports.' }, { name: 'notes', label: 'Notes', type: 'textarea' }]}
        onSubmit={(v) => post(`/horses/${horse.id}/care`, given({ kind: v.kind, happenedOn: v.happenedOn, dueOn: textOrNull(v.dueOn), notes: textOrNull(v.notes) }))} />}
    </Modal>
  );
}
