import { useState } from 'react';
import { api, post } from '../api/client';
import { CLASS_FORMATS, LEVELS } from '../constants';
import { useBranch } from '../lib/branch';
import { asValues, given, numberOrNull, textOrNull } from '../lib/form';
import { fromMinor, label, money, toMinor, todayLocal } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import type { ClassType, RideType } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import type { FieldDef, Values } from '../ui/FormDialog';
import { Badge, Btn, Card, Load, Modal, Table } from '../ui/kit';
import { opts } from '../ui/pickers';

const FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', type: 'text', required: true }, { name: 'format', label: 'Format', type: 'select', options: opts(CLASS_FORMATS), required: true },
  { name: 'discipline', label: 'Discipline', type: 'text' }, { name: 'durationMinutes', label: 'Length (minutes)', type: 'number', required: true, min: 5 },
  { name: 'capacity', label: 'Places', type: 'number', required: true, min: 1 }, { name: 'minLevel', label: 'Minimum level', type: 'select', options: opts(LEVELS), required: true },
  { name: 'minAgeYears', label: 'Youngest age', type: 'number', min: 0 }, { name: 'maxAgeYears', label: 'Oldest age', type: 'number', min: 0 },
  { name: 'price', label: 'Price (SAR, VAT included)', type: 'money', required: true }, { name: 'prerequisites', label: 'Prerequisites', type: 'textarea' },
  { name: 'cancelHours', label: 'Free cancellation (hours before)', type: 'number', min: 0, hint: 'Empty uses the club rule.' },
  { name: 'singleVisit', label: 'One-off Trial or Single Class: one date, paid by itself, no package', type: 'checkbox' }, { name: 'active', label: 'Available to schedule', type: 'checkbox' },
];
const body = (v: Values) => ({
  name: v.name, format: v.format, discipline: textOrNull(v.discipline), durationMinutes: Number(v.durationMinutes), capacity: Number(v.capacity), minLevel: v.minLevel,
  minAgeYears: numberOrNull(v.minAgeYears), maxAgeYears: numberOrNull(v.maxAgeYears), priceMinor: toMinor(String(v.price || 0)), prerequisites: textOrNull(v.prerequisites),
  cancelHours: numberOrNull(v.cancelHours), singleVisit: v.singleVisit === true, active: v.active === true,
});

export function ClassTypesTab({ manager }: { manager: boolean }) {
  const { branchId, currency } = useBranch();
  const q = useQuery<{ classTypes: ClassType[] }>(branchId ? `/class-types${qs({ branchId })}` : null);
  const [edit, setEdit] = useState<ClassType | 'new' | null>(null);
  const done = () => { setEdit(null); q.reload(); };
  return (
    <Card flex title="Class catalogue" actions={manager ? <Btn kind="primary" onClick={() => setEdit('new')}>New class type</Btn> : undefined}>
      <Load q={q}>{(d) => <Table rowKey={(t) => t.id} rows={d.classTypes} empty="No class types yet." cols={[
        { head: 'Name', cell: (t) => <b>{t.name}</b>, width: '1.4fr' }, { head: 'Format', cell: (t) => label(t.format) }, { head: 'Minutes', cell: (t) => t.durationMinutes, width: '0.6fr' },
        { head: 'Places', cell: (t) => t.capacity, width: '0.6fr' }, { head: 'Level', cell: (t) => label(t.minLevel) }, { head: 'Price', cell: (t) => money(t.priceMinor, currency) },
        { head: 'One-off', cell: (t) => (t.singleVisit ? 'Yes' : ''), width: '0.6fr' }, { head: 'Status', cell: (t) => <Badge value={t.active ? 'active' : 'inactive'} /> },
        { head: '', right: true, width: '0.8fr', cell: (t) => (manager ? <Btn small onClick={() => setEdit(t)}>Edit</Btn> : null) },
      ]} />}</Load>
      {edit === 'new' && <FormDialog title="New class type" fields={FIELDS} initial={{ minLevel: LEVELS[0], active: true }} onClose={() => setEdit(null)} onDone={done} onSubmit={(v) => post('/class-types', { branchId, ...given(body(v)) })} />}
      {edit && edit !== 'new' && <FormDialog title={`Edit ${edit.name}`} fields={FIELDS} onClose={() => setEdit(null)} onDone={done}
        initial={{ ...asValues(edit, ['name', 'format', 'discipline', 'durationMinutes', 'capacity', 'minLevel', 'minAgeYears', 'maxAgeYears', 'prerequisites', 'cancelHours', 'singleVisit', 'active']), price: fromMinor(edit.priceMinor) }}
        onSubmit={(v) => api('PATCH', `/class-types/${edit.id}`, body(v))} />}
    </Card>
  );
}

/** Rates that start on a later day. Rides already scheduled keep the price they were scheduled with. */
export function RatesDialog({ ride, manager, onClose, onChanged }: { ride: RideType; manager: boolean; onClose: () => void; onChanged: () => void }) {
  const { currency } = useBranch();
  const [rates, setRates] = useState(ride.rates);
  const [adding, setAdding] = useState(false);
  const refresh = async () => { const t = await api<RideType>('GET', `/ride-types/${ride.id}`); setRates(t.rates); onChanged(); };
  return (
    <Modal title={`Rates: ${ride.name}`} onClose={onClose} wide>
      <p className="sub">Usual rate: {money(ride.priceMinor, currency)} for {ride.durationMinutes} minutes. A dated rate replaces it from that day.</p>
      {manager && <div className="actions" style={{ paddingBottom: 8 }}><Btn small kind="primary" onClick={() => setAdding(true)}>Add dated rate</Btn></div>}
      <Table rowKey={(r) => r.id} rows={rates} empty="No dated rates." cols={[
        { head: 'From', cell: (r) => <b>{r.fromDate}</b> }, { head: 'Price', cell: (r) => money(r.priceMinor, currency) }, { head: 'Minutes', cell: (r) => r.durationMinutes },
        { head: '', right: true, cell: (r) => (manager ? <Btn small kind="danger" onClick={() => void api('DELETE', `/ride-types/${ride.id}/rates/${r.id}`).then(refresh)}>Remove</Btn> : null) },
      ]} />
      {adding && <FormDialog title="Add dated rate" onClose={() => setAdding(false)} onDone={() => { setAdding(false); void refresh(); }} initial={{ fromDate: todayLocal(), price: fromMinor(ride.priceMinor), durationMinutes: String(ride.durationMinutes) }}
        fields={[{ name: 'fromDate', label: 'From', type: 'date', required: true }, { name: 'price', label: 'Price (SAR)', type: 'money', required: true }, { name: 'durationMinutes', label: 'Length (minutes)', type: 'number', required: true, min: 5 }]}
        onSubmit={(v) => post(`/ride-types/${ride.id}/rates`, { fromDate: v.fromDate, priceMinor: toMinor(String(v.price)), durationMinutes: Number(v.durationMinutes) })} />}
    </Modal>
  );
}
