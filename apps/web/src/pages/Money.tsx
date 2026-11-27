import { useState } from 'react';
import { api, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ADJUSTMENT_KINDS, CLASS_FORMATS, LEVELS, MANAGER_ROLES, PAYMENT_METHODS } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { fmtDateTime, label, money, toMinor, fromMinor } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import type { PackageType, Receipt, RideType } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Load, Modal, PageHead, Table, Tabs, useAct } from '../ui/kit';
import { PaidReceipt, TakePayment } from './ClassDialog';
import { ReceiptSheet } from './ReceiptSheet';
import { opts, useArenas } from '../ui/pickers';
import { asValues, numberOrNull, textOrNull } from '../lib/form';
import type { Values } from '../ui/FormDialog';
import { ClassTypesTab, RatesDialog } from './Catalogue';
import { InvoicesTab } from './Invoices';

interface Adj { id: string; kind: string; amountMinor: number; reason: string; approvedBy: string | null; createdAt?: string }
type F = null | 'newPkg' | 'newRide' | { editPkg: PackageType } | { editRide: RideType } | { receipt: Receipt } | { ratesFor: RideType } | { pay: { id: string; riderName: string }; amountMinor: number } | { paid: string };

export function Money() {
  const { user } = useAuth();
  const { branchId, branch, currency } = useBranch();
  const manager = MANAGER_ROLES.includes(user!.role as Role);
  const [tab, setTab] = useState<'receipts' | 'invoices' | 'packages' | 'classes' | 'rides' | 'unpaid'>('receipts');
  const [method, setMethod] = useState('');
  const [offset, setOffset] = useState(0);
  const [f, setF] = useState<F>(null);
  const receipts = useQuery<{ total: number; receipts: Receipt[] }>(branchId && tab === 'receipts' ? `/receipts${qs({ branchId, method, limit: 25, offset })}` : null);
  const pkgs = useQuery<{ packageTypes: PackageType[] }>(branchId && tab === 'packages' ? `/package-types${qs({ branchId, includeInactive: 'true' })}` : null);
  const rides = useQuery<{ rideTypes: RideType[] }>(branchId && tab === 'rides' ? `/ride-types${qs({ branchId, includeInactive: 'true' })}` : null);
  const unpaid = useQuery<{ unpaid: { bookingId: string; riderName: string; title: string; priceMinor: number; startsAt: number; reason: string | null }[]; owedMinor: number }>(branchId && manager && tab === 'unpaid' ? `/reports/unpaid${qs({ branchId })}` : null);
  const reload = () => { receipts.reload(); pkgs.reload(); rides.reload(); setF(null); };

  const arenas = useArenas();
  const allRides = useQuery<{ rideTypes: RideType[] }>(branchId && tab === 'packages' ? `/ride-types${qs({ branchId })}` : null);
  const pkgLimits = (v: Values) => ({ rideTypeIds: v.rideTypeIds ?? [], arenaIds: v.arenaIds ?? [], levels: v.levels ?? [], fromTime: textOrNull(v.fromTime), toTime: textOrNull(v.toTime), family: v.family === true });
  const rideRules = (v: Values) => ({ arenaId: textOrNull(v.arenaId), maxRiderWeightKg: numberOrNull(v.maxRiderWeightKg), bookUntilHours: numberOrNull(v.bookUntilHours), cancelHours: numberOrNull(v.cancelHours), horseRequired: v.horseRequired === true, activeFrom: textOrNull(v.activeFrom), activeTo: textOrNull(v.activeTo) });
  const pkgFields = [
    { name: 'name', label: 'Name', type: 'text', required: true }, { name: 'classes', label: 'Number of classes', type: 'number', required: true, min: 1 }, { name: 'price', label: 'Price (SAR, VAT included)', type: 'money', required: true },
    { name: 'validDays', label: 'Valid for (days)', type: 'number', required: true, min: 1 }, { name: 'classFormats', label: 'Class types it covers', type: 'checks', options: opts(CLASS_FORMATS) },
    { name: 'rideTypeIds', label: 'Rides it covers (none unless ticked)', type: 'checks', options: (allRides.data?.rideTypes ?? []).map((t) => ({ value: t.id, label: t.name })) },
    { name: 'arenaIds', label: 'Only at these arenas (none ticked means any)', type: 'checks', options: arenas.options },
    { name: 'levels', label: 'Only for these levels (none ticked means any)', type: 'checks', options: opts(LEVELS) },
    { name: 'fromTime', label: 'Only sessions starting from', type: 'text', hint: '24-hour time such as 06:00. Empty means any time.' }, { name: 'toTime', label: 'and up to', type: 'text' },
    { name: 'family', label: 'Family package: riders with the same guardian may share it', type: 'checkbox' },
  ] as const;
  const rideFields = [
    { name: 'name', label: 'Name', type: 'text', required: true }, { name: 'description', label: 'Description', type: 'textarea' }, { name: 'price', label: 'Price (SAR, VAT included)', type: 'money', required: true },
    { name: 'durationMinutes', label: 'Length (minutes)', type: 'number', required: true, min: 1 }, { name: 'capacity', label: 'Riders', type: 'number', required: true, min: 1 },
    { name: 'minLevel', label: 'Minimum level', type: 'select', options: opts(LEVELS), required: true }, { name: 'minAgeYears', label: 'Minimum age (years)', type: 'number', min: 0 },
    { name: 'arenaId', label: 'Usual route or location', type: 'select', options: arenas.options, blank: 'Chosen when scheduling' },
    { name: 'maxRiderWeightKg', label: 'Heaviest rider (kg)', type: 'number', min: 10 },
    { name: 'activeFrom', label: 'Offered from', type: 'date' }, { name: 'activeTo', label: 'Offered until', type: 'date' },
    { name: 'bookUntilHours', label: 'Booking closes (hours before)', type: 'number', min: 0 }, { name: 'cancelHours', label: 'Free cancellation (hours before)', type: 'number', min: 0, hint: 'Empty uses the club rule. Weather cancellations never cost the rider.' },
    { name: 'horseRequired', label: 'Horses must be assigned before it is published or booked', type: 'checkbox' },
  ] as const;
  const RIDE_KEYS = ['arenaId', 'maxRiderWeightKg', 'activeFrom', 'activeTo', 'bookUntilHours', 'cancelHours', 'horseRequired'] as const;

  return (
    <>
      <PageHead title="Money" sub={branch?.name} actions={manager && tab === 'packages' ? <Btn kind="primary" onClick={() => setF('newPkg')}>New package</Btn> : manager && tab === 'rides' ? <Btn kind="primary" onClick={() => setF('newRide')}>New ride type</Btn> : undefined} />
      <div className="page">
        <Tabs tabs={[{ id: 'receipts', label: 'Receipts' }, { id: 'invoices', label: 'Invoices' }, { id: 'packages', label: 'Packages' }, { id: 'classes', label: 'Class types' }, { id: 'rides', label: 'Ride types' }, ...(manager ? [{ id: 'unpaid' as const, label: 'Unpaid' }] : [])]} value={tab} onChange={setTab} />
        {tab === 'receipts' && <Card flex>
          <div className="filters"><select aria-label="Method" value={method} onChange={(e) => { setMethod(e.target.value); setOffset(0); }}><option value="">Any method</option>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></div>
          <Load q={receipts}>{(d) => <>
            <Table rowKey={(r) => r.id} rows={d.receipts} empty="No receipts." onRow={(r) => setF({ receipt: r })} cols={[{ head: 'Number', cell: (r) => <b>{r.number}</b> }, { head: 'Rider', cell: (r) => r.riderName }, { head: 'Amount', cell: (r) => money(r.amountMinor, currency) }, { head: 'VAT', cell: (r) => money(r.vatMinor, currency) }, { head: 'Method', cell: (r) => label(r.method) }, { head: 'Issued', cell: (r) => fmtDateTime(r.issuedAt) }]} />
            <div className="actions" style={{ paddingTop: 12 }}><Btn small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>‹ Previous</Btn><span className="sub">{d.total === 0 ? 0 : offset + 1}–{Math.min(offset + 25, d.total)} of {d.total}</span><Btn small disabled={offset + 25 >= d.total} onClick={() => setOffset(offset + 25)}>Next ›</Btn></div>
          </>}</Load></Card>}
        {tab === 'invoices' && <InvoicesTab />}
        {tab === 'classes' && <ClassTypesTab manager={manager} />}
        {tab === 'packages' && <Card flex><Load q={pkgs}>{(d) => <Table rowKey={(p) => p.id} rows={d.packageTypes} empty="No packages." cols={[{ head: 'Package', cell: (p) => <b>{p.name}</b> }, { head: 'Classes', cell: (p) => p.classes }, { head: 'Price', cell: (p) => money(p.priceMinor, currency) }, { head: 'Valid days', cell: (p) => p.validDays }, { head: 'Covers', cell: (p) => [...p.classFormats.map(label), p.rideTypeIds.length ? `${p.rideTypeIds.length} ride type(s)` : null, p.family ? 'family' : null, p.arenaIds.length ? 'some arenas' : null, p.levels.length ? p.levels.map(label).join('/') : null, p.fromTime || p.toTime ? `${p.fromTime ?? ''}–${p.toTime ?? ''}` : null].filter(Boolean).join(', ') }, { head: 'Status', cell: (p) => <Badge value={p.active ? 'active' : 'inactive'} /> }, { head: '', right: true, width: '0.8fr', cell: (p) => manager ? <Btn small onClick={() => setF({ editPkg: p })}>Edit</Btn> : null }]} />}</Load></Card>}
        {tab === 'rides' && <Card flex><Load q={rides}>{(d) => <Table rowKey={(p) => p.id} rows={d.rideTypes} empty="No ride types." cols={[{ head: 'Ride', cell: (p) => <b>{p.name}</b> }, { head: 'Price', cell: (p) => money(p.priceMinor, currency) }, { head: 'Minutes', cell: (p) => p.durationMinutes }, { head: 'Riders', cell: (p) => p.capacity }, { head: 'Level', cell: (p) => label(p.minLevel) }, { head: 'Min age', cell: (p) => p.minAgeYears ?? '' }, { head: 'Rules', cell: (p) => [p.horseRequired ? 'horse required' : null, p.maxRiderWeightKg ? `≤ ${p.maxRiderWeightKg} kg` : null, p.bookUntilHours !== null ? `closes ${p.bookUntilHours} h before` : null].filter(Boolean).join(', ') }, { head: 'Status', cell: (p) => <Badge value={p.active ? 'active' : 'inactive'} /> }, { head: '', right: true, width: '0.8fr', cell: (p) => <span className="actions"><Btn small onClick={() => setF({ ratesFor: p })}>Rates</Btn>{manager ? <Btn small onClick={() => setF({ editRide: p })}>Edit</Btn> : null}</span> }]} />}</Load></Card>}
        {tab === 'unpaid' && <Card flex title="Riders let in without paying"><Load q={unpaid}>{(d) => <><p>Owed: <b>{money(d.owedMinor, currency)}</b></p><Table rowKey={(u) => u.bookingId} rows={d.unpaid} empty="Nobody owes anything." cols={[{ head: 'Rider', cell: (u) => <b>{u.riderName}</b> }, { head: 'Class or ride', cell: (u) => u.title }, { head: 'When', cell: (u) => fmtDateTime(u.startsAt) }, { head: 'Amount', cell: (u) => money(u.priceMinor, currency) }, { head: 'Reason', cell: (u) => u.reason ?? '' }, { head: '', right: true, cell: (u) => <Btn small kind="primary" onClick={() => setF({ pay: { id: u.bookingId, riderName: u.riderName }, amountMinor: u.priceMinor })}>Take payment</Btn> }]} /></>}</Load></Card>}
      </div>

      {f === 'newPkg' && <FormDialog title="New package" onClose={() => setF(null)} onDone={reload} initial={{ classFormats: [CLASS_FORMATS[0]], rideTypeIds: [], arenaIds: [], levels: [] }} fields={[...pkgFields]} onSubmit={(v) => post('/package-types', { branchId, name: v.name, classes: Number(v.classes), priceMinor: toMinor(String(v.price)), validDays: Number(v.validDays), classFormats: v.classFormats, ...pkgLimits(v) })} />}
      {typeof f === 'object' && f && 'editPkg' in f && <FormDialog title={`Edit ${f.editPkg.name}`} onClose={() => setF(null)} onDone={reload} initial={{ ...asValues(f.editPkg, ['rideTypeIds', 'arenaIds', 'levels', 'fromTime', 'toTime', 'family']), name: f.editPkg.name, classes: String(f.editPkg.classes), price: fromMinor(f.editPkg.priceMinor), validDays: String(f.editPkg.validDays), classFormats: f.editPkg.classFormats, active: f.editPkg.active }} fields={[...pkgFields, { name: 'active', label: 'On sale', type: 'checkbox' } as const]} onSubmit={(v) => api('PATCH', `/package-types/${f.editPkg.id}`, { name: v.name, classes: Number(v.classes), priceMinor: toMinor(String(v.price)), validDays: Number(v.validDays), classFormats: v.classFormats, active: v.active === true, ...pkgLimits(v) })} />}
      {f === 'newRide' && <FormDialog title="New ride type" onClose={() => setF(null)} onDone={reload} initial={{ minLevel: LEVELS[0], horseRequired: true }} fields={[...rideFields]} onSubmit={(v) => post('/ride-types', { branchId, name: v.name, ...(v.description ? { description: v.description } : {}), priceMinor: toMinor(String(v.price)), durationMinutes: Number(v.durationMinutes), capacity: Number(v.capacity), minLevel: v.minLevel, ...(v.minAgeYears ? { minAgeYears: Number(v.minAgeYears) } : {}), ...rideRules(v) })} />}
      {typeof f === 'object' && f && 'editRide' in f && <FormDialog title={`Edit ${f.editRide.name}`} onClose={() => setF(null)} onDone={reload} initial={{ ...asValues(f.editRide, RIDE_KEYS), name: f.editRide.name, description: f.editRide.description ?? '', price: fromMinor(f.editRide.priceMinor), durationMinutes: String(f.editRide.durationMinutes), capacity: String(f.editRide.capacity), minLevel: f.editRide.minLevel, minAgeYears: f.editRide.minAgeYears === null ? '' : String(f.editRide.minAgeYears), active: f.editRide.active }} fields={[...rideFields, { name: 'active', label: 'Available to schedule', type: 'checkbox' } as const]} onSubmit={(v) => api('PATCH', `/ride-types/${f.editRide.id}`, { name: v.name, description: v.description || null, priceMinor: toMinor(String(v.price)), durationMinutes: Number(v.durationMinutes), capacity: Number(v.capacity), minLevel: v.minLevel, minAgeYears: v.minAgeYears ? Number(v.minAgeYears) : null, active: v.active === true, ...rideRules(v) })} />}
      {typeof f === 'object' && f && 'ratesFor' in f && <RatesDialog ride={f.ratesFor} manager={manager} onClose={() => setF(null)} onChanged={rides.reload} />}
      {typeof f === 'object' && f && 'receipt' in f && <ReceiptDialog r={f.receipt} manager={manager} onClose={() => setF(null)} />}
      {typeof f === 'object' && f && 'pay' in f && <TakePayment b={f.pay} amountMinor={f.amountMinor} onClose={() => setF(null)} onPaid={(id) => { unpaid.reload(); receipts.reload(); setF(id ? { paid: id } : null); }} />}
      {typeof f === 'object' && f && 'paid' in f && <PaidReceipt id={f.paid} onClose={() => setF(null)} />}
    </>
  );
}

function ReceiptDialog({ r, manager, onClose }: { r: Receipt; manager: boolean; onClose: () => void }) {
  const { currency } = useBranch();
  const [adding, setAdding] = useState(false);
  const act = useAct();
  const q = useQuery<Receipt & { adjustments: Adj[] }>(`/receipts/${r.id}`);
  return (
    <Modal title={`Receipt ${r.number}`} onClose={onClose}>
      <Load q={q}>{(d) => <ReceiptSheet r={d} />}</Load>
      <Card title="Refunds and corrections" actions={<Btn small kind="primary" onClick={() => setAdding(true)}>Add</Btn>}>
        <Load q={q}>{(d) => <Table rowKey={(a) => a.id} rows={d.adjustments} empty="None." cols={[{ head: 'Kind', cell: (a) => label(a.kind) }, { head: 'Amount', cell: (a) => money(a.amountMinor, currency) }, { head: 'Reason', cell: (a) => a.reason }, { head: 'Status', cell: (a) => <Badge value={a.approvedBy ? 'approved' : 'awaiting_approval'} /> }, { head: '', right: true, cell: (a) => (manager && !a.approvedBy ? <Btn small kind="primary" onClick={() => void act(() => post(`/adjustments/${a.id}/approve`), 'Approved').then((ok) => ok && q.reload())}>Approve</Btn> : null) }]} />}</Load>
      </Card>
      {adding && <FormDialog title="Refund or correction" onClose={() => setAdding(false)} onDone={() => { setAdding(false); q.reload(); }} initial={{ kind: ADJUSTMENT_KINDS[0] }} fields={[{ name: 'kind', label: 'Kind', type: 'select', required: true, options: opts(ADJUSTMENT_KINDS) }, { name: 'amount', label: 'Amount (SAR)', type: 'money', required: true, hint: manager ? undefined : 'Above the manager limit, a manager must approve it.' }, { name: 'reason', label: 'Reason', type: 'text', required: true }]} onSubmit={(v) => post(`/receipts/${r.id}/adjustments`, { kind: v.kind, amountMinor: toMinor(String(v.amount)), reason: v.reason })} />}
    </Modal>
  );
}
