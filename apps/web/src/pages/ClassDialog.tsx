import { useState } from 'react';
import { post, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { BOOKING_STATUS, CANCEL_CAUSES_CLASS, FRONT_DESK, MANAGER_ROLES, PAY_WITH, PAYMENT_METHODS, RUNNER_ROLES, OCCURRENCE_STATUS } from '../constants';
import type { Role } from '../constants';
import { fmtDateTime, fmtTime, fromMinor, label, money, toMinor } from '../lib/format';
import { useQuery, qs } from '../lib/useApi';
import type { Occurrence, Rider, RosterBooking, WaitEntry } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Confirm, Load, Modal, Table, Tabs, useAct, useToast } from '../ui/kit';
import { opts } from '../ui/pickers';

interface Roster { occurrence: { id: string; title: string; capacity: number }; bookings: RosterBooking[]; waitlist: WaitEntry[] }
interface Assignment { id: string; horseId: string; horseName: string; horseStatus: string; riderId: string | null; riderName: string | null }
interface Suggest { suitable: { id: string; name: string }[]; unsuitable: { id: string; name: string; reasons?: { message: string }[] }[] }
interface Pkg { id: string; status: string; name: string; balance?: number; validUntil: string }

type Dialog =
  | { kind: 'addBooking' } | { kind: 'pay'; b: RosterBooking } | { kind: 'unpaid'; b: RosterBooking }
  | { kind: 'cancelBooking'; b: RosterBooking } | { kind: 'complete' } | { kind: 'cancelClass' } | { kind: 'cancelSeries' } | { kind: 'assign' } | { kind: 'unassign'; a: Assignment } | null;

export function ClassDialog({ occ, onClose, onChanged }: { occ: Occurrence; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const role = user!.role as Role;
  const act = useAct();
  const toast = useToast();
  const [tab, setTab] = useState<'riders' | 'horses'>('riders');
  const [dlg, setDlg] = useState<Dialog>(null);
  const roster = useQuery<Roster>(`/bookings${qs({ occurrenceId: occ.id })}`);
  const horses = useQuery<{ assignments: Assignment[] }>(tab === 'horses' ? `/schedule/${occ.id}/horses` : null);
  const front = FRONT_DESK.includes(role);
  const manager = MANAGER_ROLES.includes(role);
  const runner = RUNNER_ROLES.includes(role);
  const open = occ.status === OCCURRENCE_STATUS.PUBLISHED || occ.status === OCCURRENCE_STATUS.IN_PROGRESS;
  const refresh = () => { roster.reload(); horses.reload(); onChanged(); };
  const done = () => { setDlg(null); refresh(); };

  const rowActions = (b: RosterBooking) => (
    <span className="actions">
      {b.status === BOOKING_STATUS.PENDING_OFFICE_PAYMENT && front && <Btn small kind="primary" onClick={() => setDlg({ kind: 'pay', b })}>Take payment</Btn>}
      {b.status === BOOKING_STATUS.PENDING_OFFICE_PAYMENT && manager && <Btn small onClick={() => setDlg({ kind: 'unpaid', b })}>Confirm unpaid</Btn>}
      {b.status === BOOKING_STATUS.CONFIRMED && runner && <Btn small onClick={() => void act(() => post(`/bookings/${b.id}/check-in`), 'Checked in').then((ok) => ok && refresh())}>Check in</Btn>}
      {(b.status === BOOKING_STATUS.CONFIRMED || b.status === BOOKING_STATUS.CHECKED_IN) && runner && <Btn small onClick={() => void act(() => post(`/bookings/${b.id}/no-show`), 'Marked no-show').then((ok) => ok && refresh())}>No-show</Btn>}
      {(b.status === BOOKING_STATUS.PENDING_OFFICE_PAYMENT || b.status === BOOKING_STATUS.CONFIRMED) && front && <Btn small kind="danger" onClick={() => setDlg({ kind: 'cancelBooking', b })}>Cancel</Btn>}
    </span>
  );

  return (
    <Modal title={occ.title} onClose={onClose} wide>
      <p className="sub">{fmtDateTime(occ.startsAt)} – {fmtTime(occ.endsAt)} · {occ.arenaName} · {occ.coachName} · {label(occ.format)} · {label(occ.minLevel)} · {money(occ.priceMinor)} · <Badge value={occ.status} /></p>
      <div className="actions" style={{ padding: '8px 0 12px' }}>
        <Tabs tabs={[{ id: 'riders', label: 'Riders' }, { id: 'horses', label: 'Horses' }]} value={tab} onChange={setTab} />
        <span style={{ flex: 1 }} />
        {front && open && <Btn kind="primary" onClick={() => setDlg({ kind: 'addBooking' })}>Add rider</Btn>}
        {front && open && <Btn onClick={() => void act(() => post(`/schedule/${occ.id}/waitlist/refresh`), 'Offers sent').then((ok) => ok && refresh())}>Offer free places</Btn>}
        {runner && open && <Btn onClick={() => setDlg({ kind: 'complete' })}>Finish class</Btn>}
        {manager && open && <Btn kind="danger" onClick={() => setDlg({ kind: 'cancelClass' })}>Cancel class</Btn>}
        {manager && open && occ.seriesId && <Btn kind="danger" onClick={() => setDlg({ kind: 'cancelSeries' })}>Cancel series</Btn>}
      </div>

      {tab === 'riders' && (
        <Load q={roster}>{(r) => (
          <>
            <Card title={`Booked ${r.bookings.filter((b) => b.status !== BOOKING_STATUS.CANCELLED).length} of ${occ.capacity}`}>
              <Table rowKey={(b) => b.id} rows={r.bookings} empty="No riders booked yet." cols={[
                { head: 'Rider', cell: (b) => <b>{b.riderName}</b> }, { head: 'Level', cell: (b) => label(b.level), width: '0.7fr' },
                { head: 'Paying', cell: (b) => label(b.payWith), width: '0.7fr' }, { head: 'Status', cell: (b) => <Badge value={b.status} />, width: '1fr' },
                { head: '', cell: rowActions, width: '2.4fr', right: true },
              ]} />
            </Card>
            {r.waitlist.length > 0 && (
              <Card title="Waitlist">
                <Table rowKey={(w) => w.id} rows={r.waitlist} cols={[{ head: 'Rider', cell: (w) => w.riderName }, { head: 'Status', cell: (w) => <Badge value={w.status} /> }, { head: 'Offer ends', cell: (w) => (w.offerExpiresAt ? fmtDateTime(w.offerExpiresAt) : '') }]} />
              </Card>
            )}
          </>
        )}</Load>
      )}

      {tab === 'horses' && (
        <Card title="Horses for this class" actions={front || role === 'coach' ? <Btn small kind="primary" onClick={() => setDlg({ kind: 'assign' })}>Assign horse</Btn> : undefined}>
          <Load q={horses}>{(h) => (
            <Table rowKey={(a) => a.id} rows={h.assignments} empty="No horses assigned yet." cols={[
              { head: 'Horse', cell: (a) => <b>{a.horseName}</b> }, { head: 'Rider', cell: (a) => a.riderName ?? 'Whole class' },
              { head: 'Horse status', cell: (a) => <Badge value={a.horseStatus} /> },
              { head: '', cell: (a) => (front || role === 'coach') ? <Btn small kind="danger" onClick={() => setDlg({ kind: 'unassign', a })}>Remove</Btn> : null, right: true, width: '0.8fr' },
            ]} />
          )}</Load>
        </Card>
      )}

      {dlg?.kind === 'addBooking' && <AddBooking occ={occ} onClose={() => setDlg(null)} onDone={done} />}
      {dlg?.kind === 'pay' && (
        <FormDialog title={`Payment: ${dlg.b.riderName}`} submit="Record payment" onClose={() => setDlg(null)} onDone={done}
          fields={[{ name: 'method', label: 'Method', type: 'select', required: true, options: opts(PAYMENT_METHODS) }, { name: 'amount', label: 'Amount (SAR)', type: 'money', required: true, hint: 'Must match the price. A receipt is issued.' }]}
          initial={{ method: 'cash', amount: fromMinor(occ.priceMinor) }}
          onSubmit={(v) => post(`/bookings/${dlg.b.id}/payment`, { method: v.method, amountMinor: toMinor(String(v.amount)) })} />
      )}
      {dlg?.kind === 'unpaid' && (
        <FormDialog title={`Confirm without payment: ${dlg.b.riderName}`} submit="Confirm unpaid" onClose={() => setDlg(null)} onDone={done}
          fields={[{ name: 'reason', label: 'Reason', type: 'text', required: true }]} onSubmit={(v) => post(`/bookings/${dlg.b.id}/confirm-unpaid`, { reason: v.reason })} />
      )}
      {dlg?.kind === 'cancelBooking' && (
        <Confirm title="Cancel this booking?" text={`${dlg.b.riderName}. The club’s cancellation rules decide whether the class is returned or used up.`} danger onClose={() => setDlg(null)} onDone={done}
          action={() => post(`/bookings/${dlg.b.id}/cancel`, { cause: 'club' })} />
      )}
      {dlg?.kind === 'complete' && (
        <FormDialog title="Finish class" submit="Finish class" onClose={() => setDlg(null)} onDone={done}
          fields={[{ name: 'markRemainingNoShow', label: 'Mark riders who did not check in as no-show', type: 'checkbox' }]} onSubmit={(v) => post(`/schedule/${occ.id}/complete`, { markRemainingNoShow: v.markRemainingNoShow === true })} />
      )}
      {dlg?.kind === 'cancelClass' && (
        <FormDialog title="Cancel this class" submit="Cancel class" onClose={() => setDlg(null)} onDone={() => { done(); onClose(); }}
          fields={[{ name: 'cause', label: 'Why', type: 'select', required: true, options: opts(CANCEL_CAUSES_CLASS) }, { name: 'reason', label: 'Reason', type: 'text', required: true, hint: 'All bookings are cancelled and the horses are freed.' }]}
          initial={{ cause: 'club' }} onSubmit={(v) => post(`/schedule/${occ.id}/cancel`, { cause: v.cause, reason: v.reason })} />
      )}
      {dlg?.kind === 'cancelSeries' && (
        <FormDialog title="Cancel the whole series" submit="Cancel series" onClose={() => setDlg(null)} onDone={() => { done(); onClose(); }}
          fields={[{ name: 'cause', label: 'Why', type: 'select', required: true, options: opts(CANCEL_CAUSES_CLASS) }, { name: 'reason', label: 'Reason', type: 'text', required: true, hint: 'Every date that has not started yet is cancelled, like a single class: bookings are cancelled and the horses are freed.' }]}
          initial={{ cause: 'club' }} onSubmit={async (v) => { const r = await post<{ cancelled: number; failed: unknown[] }>(`/schedule/series/${occ.seriesId}/cancel`, { cause: v.cause, reason: v.reason }); toast(r.failed.length ? `${r.cancelled} cancelled, ${r.failed.length} could not be` : `${r.cancelled} classes cancelled`); }} />
      )}
      {dlg?.kind === 'assign' && <AssignHorse occ={occ} riders={roster.data?.bookings ?? []} onClose={() => setDlg(null)} onDone={done} />}
      {dlg?.kind === 'unassign' && <Confirm title="Remove this horse?" text={dlg.a.horseName} danger onClose={() => setDlg(null)} onDone={done} action={() => api('DELETE', `/schedule/${occ.id}/horses/${dlg.a.id}`)} />}
    </Modal>
  );
}

function AddBooking({ occ, onClose, onDone }: { occ: Occurrence; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [rider, setRider] = useState<Rider | null>(null);
  const found = useQuery<{ riders: Rider[] }>(q.trim().length >= 2 && !rider ? `/riders${qs({ q: q.trim(), limit: 8 })}` : null);
  const pkgs = useQuery<{ packages: Pkg[] }>(rider ? `/riders/${rider.id}/packages` : null);
  const active = (pkgs.data?.packages ?? []).filter((p) => p.status === 'active');
  const isRide = occ.rideTypeId !== null;
  if (!rider) {
    return (
      <Modal title="Add a rider" onClose={onClose}>
        <div className="field"><label htmlFor="rq">Find a rider</label><input id="rq" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least 2 letters of the name" /></div>
        <Load q={found}>{(d) => <Table rowKey={(r) => r.id} rows={d.riders} empty="No riders match." onRow={setRider} cols={[{ head: 'Rider', cell: (r) => <b>{r.fullName}</b> }, { head: 'Born', cell: (r) => r.dateOfBirth }, { head: 'Level', cell: (r) => label(r.level) }]} />}</Load>
      </Modal>
    );
  }
  const payOptions = [{ value: PAY_WITH.OFFICE, label: 'Pay at the office' }, ...(isRide ? [] : active.map((p) => ({ value: p.id, label: `Package: ${p.name}` })))];
  return (
    <FormDialog title={`Book ${rider.fullName}`} submit="Book" onClose={onClose} onDone={onDone} initial={{ pay: PAY_WITH.OFFICE }}
      fields={[{ name: 'pay', label: 'Payment', type: 'select', required: true, options: payOptions, blank: 'Choose…', hint: isRide ? 'Rides are paid at the office. A class package never pays for a ride.' : undefined }]}
      onSubmit={(v) => post('/bookings', v.pay === PAY_WITH.OFFICE ? { occurrenceId: occ.id, riderId: rider.id, payWith: PAY_WITH.OFFICE } : { occurrenceId: occ.id, riderId: rider.id, payWith: PAY_WITH.PACKAGE, packageId: v.pay })} />
  );
}

function AssignHorse({ occ, riders, onClose, onDone }: { occ: Occurrence; riders: RosterBooking[]; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const sug = useQuery<Suggest>(`/schedule/${occ.id}/horses/suggestions`);
  const list = sug.data?.suitable ?? [];
  const live = riders.filter((r) => r.status !== BOOKING_STATUS.CANCELLED);
  const manager = MANAGER_ROLES.includes(user!.role as Role);
  return (
    <FormDialog title="Assign a horse" submit="Assign" onClose={onClose} onDone={onDone}
      fields={[
        { name: 'horseId', label: 'Horse', type: 'select', required: true, options: list.map((h) => ({ value: h.id, label: h.name })), hint: sug.loading ? 'Loading suitable horses…' : 'Only horses that fit the level, arena and workload are listed.' },
        { name: 'riderId', label: 'For which rider (optional)', type: 'select', options: live.map((r) => ({ value: r.riderId, label: r.riderName })), blank: 'Whole class' },
        ...(manager ? [{ name: 'overrideReason', label: 'Override reason', type: 'text', hint: 'Only to knowingly break a rest or workload limit. Safety rules can never be overridden.' } as const] : []),
      ]}
      onSubmit={(v) => post(`/schedule/${occ.id}/horses`, { horseId: v.horseId, ...(v.riderId ? { riderId: v.riderId } : {}), ...(typeof v.overrideReason === 'string' && v.overrideReason.trim() ? { override: { reason: v.overrideReason.trim() } } : {}) })} />
  );
}
