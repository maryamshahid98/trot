import { useRef, useState } from 'react';
import { api, get, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { BOOKING_STATUS, CANCEL_CAUSES, CANCEL_CAUSES_CLASS, FRONT_DESK, MANAGER_ROLES, OFFICE_METHODS, PAY_WITH, ROLE, RUNNER_ROLES, OCCURRENCE_STATUS } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { fmtDateTime, fmtTime, fromMinor, label, money, toMinor } from '../lib/format';
import { errorText, useQuery, qs } from '../lib/useApi';
import type { Occurrence, Receipt, Rider, RosterBooking, WaitEntry } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Badge, Btn, Card, Confirm, Load, Modal, Table, Tabs, useAct, useToast } from '../ui/kit';
import { opts } from '../ui/pickers';
import { ReceiptSheet } from './ReceiptSheet';
import { attendanceText, BookingPass, LessonRecord } from './BookingExtras';
import { EditSessionDialog, PublishDialog } from './ScheduleForms';

interface Roster { occurrence: { id: string; title: string; capacity: number }; bookings: RosterBooking[]; waitlist: WaitEntry[] }
interface Assignment { id: string; horseId: string; horseName: string; horseStatus: string; riderId: string | null; riderName: string | null }
interface Suggest { suitable: { id: string; name: string }[] }
interface Pkg { id: string; status: string; name: string; balance: number; validUntil: string; rideTypeIds: string[] }
interface Preview { allowed: boolean; consumesClass: boolean; returnsPackageClass: boolean; reason: string; payment: { receiptId: string; number: string; paidMinor: number; returnedMinor: number } | null }
interface Customer { id: string; fullName: string; phone: string | null; riders: { id: string; fullName: string; level: string }[] }

type Dialog =
  | { kind: 'addBooking' } | { kind: 'pay'; b: RosterBooking } | { kind: 'receipt'; id: string } | { kind: 'unpaid'; b: RosterBooking }
  | { kind: 'cancelBooking'; b: RosterBooking } | { kind: 'accept'; w: WaitEntry } | { kind: 'dropWait'; w: WaitEntry }
  | { kind: 'pass'; b: RosterBooking } | { kind: 'record'; b: RosterBooking } | { kind: 'edit' } | { kind: 'publish' } | { kind: 'complete' } | { kind: 'cancelClass' } | { kind: 'cancelSeries' } | { kind: 'assign' } | { kind: 'unassign'; a: Assignment } | null;

/** Check-in opens this long before the start (the server enforces it). */
const CHECK_IN_EARLY_MS = 60 * 60_000;
const SOURCE_LABEL: Record<string, string> = { walk_in: 'Walk-in', staff_portal: 'Front desk', customer_app: 'App', imported: 'Imported' };

export function ClassDialog({ occ, onClose, onChanged }: { occ: Occurrence; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const role = user!.role as Role;
  const act = useAct();
  const toast = useToast();
  const front = FRONT_DESK.includes(role);
  const manager = MANAGER_ROLES.includes(role);
  const runner = RUNNER_ROLES.includes(role);
  const horseTeam = front || role === ROLE.COACH || role === ROLE.STABLE_HAND;
  const [tab, setTab] = useState<'riders' | 'horses'>(runner ? 'riders' : 'horses');
  const [dlg, setDlg] = useState<Dialog>(null);
  const roster = useQuery<Roster>(runner ? `/bookings${qs({ occurrenceId: occ.id })}` : null);
  const horses = useQuery<{ assignments: Assignment[] }>(tab === 'horses' ? `/schedule/${occ.id}/horses` : null);
  // Horses can be assigned to a draft too: some rides need them before they can be published.
  const draft = occ.status === OCCURRENCE_STATUS.DRAFT;
  const open = occ.status === OCCURRENCE_STATUS.PUBLISHED || occ.status === OCCURRENCE_STATUS.IN_PROGRESS;
  const [openedAt] = useState(() => Date.now());
  const started = openedAt >= Date.parse(occ.startsAt);
  const checkInOpen = openedAt >= Date.parse(occ.startsAt) - CHECK_IN_EARLY_MS && openedAt < Date.parse(occ.endsAt);
  const mine = role !== ROLE.COACH || occ.coachId === user!.id;
  const noun = occ.rideTypeId ? 'ride' : 'class';
  // The schedule row this dialog was opened from does not change while it is open; the roster does.
  const taken = roster.data ? roster.data.bookings.filter((b) => b.status !== BOOKING_STATUS.CANCELLED && b.status !== BOOKING_STATUS.NO_SHOW).length : occ.booked;
  const refresh = () => { roster.reload(); horses.reload(); onChanged(); };
  const done = () => { setDlg(null); refresh(); };
  /** The session itself changed: the details on this dialog are out of date, so go back to the schedule. */
  const replaced = () => { onChanged(); onClose(); };

  const rowActions = (b: RosterBooking) => {
    const pending = b.status === BOOKING_STATUS.PENDING_OFFICE_PAYMENT;
    const owes = pending || (b.owedMinor !== null && b.status !== BOOKING_STATUS.CANCELLED);
    return (
      <span className="actions">
        {owes && front && <Btn small kind="primary" onClick={() => setDlg({ kind: 'pay', b })}>Take payment</Btn>}
        {pending && manager && <Btn small onClick={() => setDlg({ kind: 'unpaid', b })}>Confirm unpaid</Btn>}
        {b.status === BOOKING_STATUS.CONFIRMED && runner && open && checkInOpen && <Btn small onClick={() => void act(() => post(`/bookings/${b.id}/check-in`), 'Checked in').then((ok) => ok && refresh())}>Check in</Btn>}
        {(b.status === BOOKING_STATUS.CONFIRMED || pending) && runner && open && started && <Btn small onClick={() => void act(() => post(`/bookings/${b.id}/no-show`), 'Marked no-show').then((ok) => ok && refresh())}>No-show</Btn>}
        {runner && mine && started && b.status !== BOOKING_STATUS.CANCELLED && <Btn small onClick={() => setDlg({ kind: 'record', b })}>Lesson record</Btn>}
        <Btn small onClick={() => setDlg({ kind: 'pass', b })}>Pass</Btn>
        {(pending || b.status === BOOKING_STATUS.CONFIRMED) && front && <Btn small kind="danger" onClick={() => setDlg({ kind: 'cancelBooking', b })}>Cancel</Btn>}
      </span>
    );
  };

  const offerPlaces = () => void act(async () => {
    const r = await post<{ offers: unknown[] }>(`/schedule/${occ.id}/waitlist/refresh`);
    toast(r.offers.length ? `${r.offers.length} offer${r.offers.length === 1 ? '' : 's'} sent` : 'No offers made: there is no free place, or nobody waiting is eligible');
    refresh();
  });

  return (
    <Modal title={occ.title} onClose={onClose} wide>
      <p className="sub">{fmtDateTime(occ.startsAt)} – {fmtTime(occ.endsAt)} · {occ.arenaName} · {occ.coachName} · {label(occ.format)} · {label(occ.minLevel)} · {money(occ.priceMinor)} · {Math.max(0, occ.capacity - taken)} of {occ.capacity} places free · <Badge value={occ.status} /></p>
      {draft && <p className="note">This is a draft. Riders cannot be booked until it is published.</p>}
      <div className="actions" style={{ padding: '8px 0 12px' }}>
        {runner && <Tabs tabs={[{ id: 'riders', label: 'Riders' }, { id: 'horses', label: 'Horses' }]} value={tab} onChange={setTab} />}
        <span style={{ flex: 1 }} />
        {front && draft && !started && <Btn kind="primary" onClick={() => setDlg({ kind: 'publish' })}>Publish</Btn>}
        {front && (draft || occ.status === OCCURRENCE_STATUS.PUBLISHED) && !started && <Btn onClick={() => setDlg({ kind: 'edit' })}>Change time, place or coach</Btn>}
        {front && open && !started && <Btn kind="primary" onClick={() => setDlg({ kind: 'addBooking' })}>Add rider</Btn>}
        {front && open && !started && (roster.data?.waitlist.length ?? 0) > 0 && <Btn onClick={offerPlaces}>Offer free places</Btn>}
        {runner && mine && open && started && <Btn onClick={() => setDlg({ kind: 'complete' })}>Finish {noun}</Btn>}
        {manager && (open || draft) && <Btn kind="danger" onClick={() => setDlg({ kind: 'cancelClass' })}>Cancel {noun}</Btn>}
        {manager && open && occ.seriesId && <Btn kind="danger" onClick={() => setDlg({ kind: 'cancelSeries' })}>Cancel series</Btn>}
      </div>

      {tab === 'riders' && runner && (
        <Load q={roster}>{(r) => (
          <>
            <Card title={`Booked ${r.bookings.filter((b) => b.status !== BOOKING_STATUS.CANCELLED).length} of ${occ.capacity}`}>
              <Table rowKey={(b) => b.id} rows={r.bookings} empty="No riders booked yet." cols={[
                { head: 'Rider', cell: (b) => <span><b>{b.riderName}</b><br /><span className="sub">{b.number} · {SOURCE_LABEL[b.source] ?? label(b.source)}</span></span> },
                { head: 'Level', cell: (b) => label(b.level), width: '0.7fr' },
                { head: 'Paying', cell: (b) => <span>{label(b.payWith)}{b.owedMinor !== null && <><br /><span className="sub">{money(b.owedMinor)} owed</span></>}</span>, width: '0.8fr' },
                { head: 'Status', cell: (b) => <span><Badge value={b.status} />{b.attendance && <><br /><span className="sub">{attendanceText(b)}</span></>}{b.status === BOOKING_STATUS.PENDING_OFFICE_PAYMENT && b.holdExpiresAt && <><br /><span className="sub">held until {fmtTime(b.holdExpiresAt)}</span></>}</span>, width: '1fr' },
                { head: '', cell: rowActions, width: '2.4fr', right: true },
              ]} />
            </Card>
            {r.waitlist.length > 0 && (
              <Card title="Waitlist">
                <Table rowKey={(w) => w.id} rows={r.waitlist.map((w, i) => ({ ...w, position: i + 1 }))} cols={[
                  { head: 'Place', cell: (w) => w.position, width: '0.4fr' }, { head: 'Rider', cell: (w) => <b>{w.riderName}</b> }, { head: 'Status', cell: (w) => <Badge value={w.status} /> },
                  { head: 'Offer ends', cell: (w) => (w.offerExpiresAt ? fmtDateTime(w.offerExpiresAt) : '') },
                  { head: '', right: true, width: '1.8fr', cell: (w) => front ? (
                    <span className="actions">
                      {w.status === 'offered' && <Btn small kind="primary" onClick={() => setDlg({ kind: 'accept', w })}>Accept offer</Btn>}
                      <Btn small kind="danger" onClick={() => setDlg({ kind: 'dropWait', w })}>{w.status === 'offered' ? 'Decline' : 'Remove'}</Btn>
                    </span>
                  ) : null },
                ]} />
              </Card>
            )}
          </>
        )}</Load>
      )}

      {tab === 'horses' && (
        <Card title={`Horses for this ${noun}`} actions={horseTeam && mine && (open || draft) ? <Btn small kind="primary" onClick={() => setDlg({ kind: 'assign' })}>Assign horse</Btn> : undefined}>
          <Load q={horses}>{(h) => (
            <Table rowKey={(a) => a.id} rows={h.assignments} empty="No horses assigned yet." cols={[
              { head: 'Horse', cell: (a) => <b>{a.horseName}</b> }, { head: 'Rider', cell: (a) => a.riderName ?? `Whole ${noun}` },
              { head: 'Horse status', cell: (a) => <Badge value={a.horseStatus} /> },
              { head: '', cell: (a) => (horseTeam && mine) ? <Btn small kind="danger" onClick={() => setDlg({ kind: 'unassign', a })}>Remove</Btn> : null, right: true, width: '0.8fr' },
            ]} />
          )}</Load>
        </Card>
      )}

      {dlg?.kind === 'pass' && <BookingPass b={dlg.b} occ={occ} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'record' && <LessonRecord b={dlg.b} onClose={() => setDlg(null)} onDone={done} />}
      {dlg?.kind === 'edit' && <EditSessionDialog occ={occ} onClose={() => setDlg(null)} onDone={replaced} />}
      {dlg?.kind === 'publish' && <PublishDialog occ={occ} onClose={() => setDlg(null)} onDone={replaced} />}
      {dlg?.kind === 'addBooking' && <AddBooking occ={occ} onClose={() => setDlg(null)} onDone={done} />}
      {dlg?.kind === 'pay' && <TakePayment b={dlg.b} amountMinor={dlg.b.owedMinor ?? occ.priceMinor} onClose={() => setDlg(null)} onPaid={(id) => { refresh(); setDlg(id ? { kind: 'receipt', id } : null); }} />}
      {dlg?.kind === 'receipt' && <PaidReceipt id={dlg.id} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'unpaid' && (
        <FormDialog title={`Confirm without payment: ${dlg.b.riderName}`} submit="Confirm unpaid" onClose={() => setDlg(null)} onDone={done}
          fields={[{ name: 'reason', label: 'Reason', type: 'text', required: true, hint: 'The amount stays owed. Take the payment from this list or from Money > Unpaid.' }]} onSubmit={(v) => post(`/bookings/${dlg.b.id}/confirm-unpaid`, { reason: v.reason })} />
      )}
      {dlg?.kind === 'cancelBooking' && <CancelBooking b={dlg.b} onClose={() => setDlg(null)} onDone={done} />}
      {dlg?.kind === 'accept' && <AcceptOffer w={dlg.w} occ={occ} onClose={() => setDlg(null)} onDone={done} />}
      {dlg?.kind === 'dropWait' && <Confirm title="Take off the waitlist?" text={dlg.w.riderName} danger onClose={() => setDlg(null)} onDone={done} action={() => post(`/waitlist/${dlg.w.id}/leave`)} />}
      {dlg?.kind === 'complete' && (
        <FormDialog title={`Finish ${noun}`} submit={`Finish ${noun}`} onClose={() => setDlg(null)} onDone={() => { done(); onClose(); }}
          fields={[{ name: 'markRemainingNoShow', label: 'Mark riders who did not check in as no-show', type: 'checkbox' }]} onSubmit={(v) => post(`/schedule/${occ.id}/complete`, { markRemainingNoShow: v.markRemainingNoShow === true })} />
      )}
      {dlg?.kind === 'cancelClass' && (
        <FormDialog title={`Cancel this ${noun}`} submit={`Cancel ${noun}`} onClose={() => setDlg(null)} onDone={replaced}
          fields={[{ name: 'cause', label: 'Why', type: 'select', required: true, options: opts(CANCEL_CAUSES_CLASS) }, { name: 'reason', label: 'Reason', type: 'text', required: true, hint: 'All bookings are cancelled and the horses are freed. Money already paid must be refunded or credited on each receipt.' }]}
          initial={{ cause: 'club' }} onSubmit={async (v) => {
            const paid = (roster.data?.bookings ?? []).filter((b) => b.payWith === PAY_WITH.OFFICE && b.owedMinor === null && (b.status === BOOKING_STATUS.CONFIRMED || b.status === BOOKING_STATUS.CHECKED_IN));
            await post(`/schedule/${occ.id}/cancel`, { cause: v.cause, reason: v.reason });
            toast(paid.length ? `Cancelled. Check refunds for: ${paid.map((b) => b.riderName).join(', ')}` : 'Cancelled', paid.length > 0);
          }} />
      )}
      {dlg?.kind === 'cancelSeries' && (
        <FormDialog title="Cancel the whole series" submit="Cancel series" onClose={() => setDlg(null)} onDone={replaced}
          fields={[{ name: 'cause', label: 'Why', type: 'select', required: true, options: opts(CANCEL_CAUSES_CLASS) }, { name: 'reason', label: 'Reason', type: 'text', required: true, hint: 'Every date that has not started yet is cancelled, like a single class: bookings are cancelled and the horses are freed.' }]}
          initial={{ cause: 'club' }} onSubmit={async (v) => { const r = await post<{ cancelled: number; failed: unknown[] }>(`/schedule/series/${occ.seriesId}/cancel`, { cause: v.cause, reason: v.reason }); toast(r.failed.length ? `${r.cancelled} cancelled, ${r.failed.length} could not be` : `${r.cancelled} classes cancelled`); }} />
      )}
      {dlg?.kind === 'assign' && <AssignHorse occ={occ} riders={roster.data?.bookings ?? []} onClose={() => setDlg(null)} onDone={done} />}
      {dlg?.kind === 'unassign' && <Confirm title="Remove this horse?" text={dlg.a.horseName} danger onClose={() => setDlg(null)} onDone={done} action={() => api('DELETE', `/schedule/${occ.id}/horses/${dlg.a.id}`)} />}
    </Modal>
  );
}

/** Records cash or card taken at the desk, then hands back the receipt. */
export function TakePayment({ b, amountMinor, onClose, onPaid }: { b: { id: string; riderName: string }; amountMinor: number; onClose: () => void; onPaid: (receiptId: string | null) => void }) {
  const toast = useToast();
  const receiptId = useRef<string | null>(null);
  return (
    <FormDialog title={`Payment: ${b.riderName}`} submit="Record payment" onClose={onClose} onDone={() => onPaid(receiptId.current)}
      fields={[
        { name: 'method', label: 'Method', type: 'select', required: true, options: opts(OFFICE_METHODS) },
        { name: 'amount', label: 'Amount (SAR)', type: 'money', required: true, hint: 'Must match the price. A receipt is issued.' },
        { name: 'terminalRef', label: 'Card terminal reference (optional)', type: 'text', showIf: (v) => v.method === 'card_at_desk' },
      ]}
      initial={{ method: 'cash', amount: fromMinor(amountMinor) }}
      onSubmit={async (v) => {
        const r = await post<{ receipt: { id: string; number: string } | null }>(`/bookings/${b.id}/payment`, { method: v.method, amountMinor: toMinor(String(v.amount)), ...(v.method === 'card_at_desk' && v.terminalRef ? { terminalRef: v.terminalRef } : {}) });
        toast(r.receipt ? `Payment recorded. Receipt ${r.receipt.number}` : 'Booking confirmed');
        receiptId.current = r.receipt?.id ?? null;
      }} />
  );
}

export function PaidReceipt({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery<Receipt>(`/receipts/${id}`);
  return <Modal title="Receipt" onClose={onClose}><Load q={q}>{(r) => <ReceiptSheet r={r} />}</Load></Modal>;
}

/** Shows what cancelling costs before it happens, and settles any money already paid (BRD 5.7). */
function CancelBooking({ b, onClose, onDone }: { b: RosterBooking; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [cause, setCause] = useState('customer');
  const [money_, setMoney] = useState<'' | 'refund' | 'credit' | 'none'>('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery<Preview>(`/bookings/${b.id}/cancel-preview${qs({ cause })}`);
  const p = preview.data;
  const left = p?.payment ? p.payment.paidMinor - p.payment.returnedMinor : 0;

  async function go() {
    setError(null);
    if (left > 0 && !money_) { setError('Choose what happens to the money already paid.'); return; }
    const back = toMinor(amount || fromMinor(left));
    if (left > 0 && money_ !== 'none' && !(back > 0 && back <= left)) { setError(`Enter an amount up to ${money(left)}.`); return; }
    setBusy(true);
    try {
      await post(`/bookings/${b.id}/cancel`, { cause });
    } catch (e) { setError(errorText(e)); setBusy(false); return; }
    if (left > 0 && money_ !== 'none' && p?.payment) {
      try {
        await post(`/receipts/${p.payment.receiptId}/adjustments`, { kind: money_, amountMinor: back, reason: `Booking cancelled (${cause})` });
        toast(`Booking cancelled and ${money_ === 'refund' ? 'refund' : 'credit'} of ${money(back)} recorded`);
      } catch (e) { toast(`The booking is cancelled, but the money was not recorded: ${errorText(e)} Add it on receipt ${p.payment.number}.`, true); }
    } else toast('Booking cancelled');
    onDone();
  }

  return (
    <Modal title={`Cancel booking: ${b.riderName}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <div className="field">
          <label htmlFor="cancel-cause">Who is cancelling?</label>
          <select id="cancel-cause" value={cause} onChange={(e) => setCause(e.target.value)}>
            {CANCEL_CAUSES.map((c) => <option key={c} value={c}>{c === 'customer' ? 'The rider or family' : c === 'club' ? 'The club' : 'Weather'}</option>)}
          </select>
        </div>
        <Load q={preview}>{(x) => (
          <div className="note" role="status">
            <b>{x.reason}</b><br />
            {b.payWith === PAY_WITH.PACKAGE && (x.returnsPackageClass ? 'One class goes back to the package.' : x.consumesClass ? 'The package class is used up.' : 'No package class changes.')}
            {x.payment ? ` Paid ${money(x.payment.paidMinor)} (receipt ${x.payment.number})${x.payment.returnedMinor ? `, ${money(x.payment.returnedMinor)} already returned` : ''}.` : b.payWith === PAY_WITH.OFFICE ? ' Nothing has been paid, so nothing is returned.' : ''}
            {x.payment && x.consumesClass ? ' Under the club rules a late cancellation is normally not refunded.' : ''}
          </div>
        )}</Load>
        {left > 0 && (
          <>
            <div className="field">
              <label htmlFor="cancel-money">Money already paid *</label>
              <select id="cancel-money" value={money_} onChange={(e) => setMoney(e.target.value as typeof money_)}>
                <option value="">Choose…</option><option value="refund">Refund it</option><option value="credit">Keep as account credit</option><option value="none">No refund or credit</option>
              </select>
            </div>
            {(money_ === 'refund' || money_ === 'credit') && (
              <div className="field"><label htmlFor="cancel-amount">Amount (SAR)</label><input id="cancel-amount" type="number" step="0.01" min="0" value={amount || fromMinor(left)} onChange={(e) => setAmount(e.target.value)} /></div>
            )}
          </>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="form-actions"><Btn onClick={onClose}>Keep booking</Btn><Btn kind="danger" type="submit" disabled={busy || preview.loading || p?.allowed === false}>Cancel booking</Btn></div>
      </form>
    </Modal>
  );
}

const packageOptions = (list: Pkg[], rideTypeId: string | null) => [
  { value: PAY_WITH.OFFICE, label: 'Pay at the office' },
  ...(list.filter((p) => p.status === 'active' && (rideTypeId === null || p.rideTypeIds.includes(rideTypeId))).map((p) => ({ value: p.id, label: `Package: ${p.name} (${p.balance} left)` }))),
];
const paymentBody = (pay: string) => (pay === PAY_WITH.OFFICE ? { payWith: PAY_WITH.OFFICE } : { payWith: PAY_WITH.PACKAGE, packageId: pay });

function AcceptOffer({ w, occ, onClose, onDone }: { w: WaitEntry; occ: Occurrence; onClose: () => void; onDone: () => void }) {
  const pkgs = useQuery<{ packages: Pkg[] }>(`/riders/${w.riderId}/packages`);
  return (
    <FormDialog title={`Accept offer: ${w.riderName}`} submit="Book the place" onClose={onClose} onDone={onDone} initial={{ pay: PAY_WITH.OFFICE }}
      fields={[{ name: 'pay', label: 'Payment', type: 'select', required: true, options: packageOptions(pkgs.data?.packages ?? [], occ.rideTypeId) }]}
      onSubmit={(v) => post(`/waitlist/${w.id}/accept`, paymentBody(String(v.pay)))} />
  );
}

function AddBooking({ occ, onClose, onDone }: { occ: Occurrence; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { branchId } = useBranch();
  const [q, setQ] = useState('');
  const [rider, setRider] = useState<{ id: string; fullName: string } | null>(null);
  const searching = q.trim().length >= 2 && !rider;
  const found = useQuery<{ riders: Rider[] }>(searching ? `/riders${qs({ branchId, q: q.trim(), limit: 8 })}` : null);
  const families = useQuery<{ customers: Customer[] }>(searching ? `/accounts/customers${qs({ branchId, q: q.trim() })}` : null);
  const pkgs = useQuery<{ packages: Pkg[] }>(rider ? `/riders/${rider.id}/packages` : null);
  const isRide = occ.rideTypeId !== null;
  if (!rider) {
    return (
      <Modal title="Add a rider" onClose={onClose}>
        <div className="field"><label htmlFor="rq">Find a rider, or a parent by name or phone</label><input id="rq" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least 2 characters" /></div>
        <Load q={found}>{(d) => <Table rowKey={(r) => r.id} rows={d.riders} empty="No riders match." onRow={setRider} cols={[{ head: 'Rider', cell: (r) => <b>{r.fullName}</b> }, { head: 'Born', cell: (r) => r.dateOfBirth }, { head: 'Level', cell: (r) => label(r.level) }]} />}</Load>
        {(families.data?.customers ?? []).filter((c) => c.riders.length > 0).map((c) => (
          <Card key={c.id} title={`${c.fullName}’s riders`}>
            <Table rowKey={(r) => r.id} rows={c.riders} onRow={setRider} cols={[{ head: 'Rider', cell: (r) => <b>{r.fullName}</b> }, { head: 'Level', cell: (r) => label(r.level) }]} />
          </Card>
        ))}
      </Modal>
    );
  }
  return (
    <FormDialog title={`Book ${rider.fullName}`} submit="Book" onClose={onClose} onDone={onDone} initial={{ pay: PAY_WITH.OFFICE }}
      fields={[{ name: 'pay', label: 'Payment', type: 'select', required: true, options: packageOptions(pkgs.data?.packages ?? [], occ.rideTypeId), blank: 'Choose…', hint: isRide ? 'A ride is paid at the office unless the rider’s package includes this ride.' : `Price ${money(occ.priceMinor)} if paid at the office.` }]}
      onSubmit={async (v) => {
        const r = await post<{ status: string; position?: number; holdExpiresAt?: string | null }>('/bookings', { occurrenceId: occ.id, riderId: rider.id, ...paymentBody(String(v.pay)) });
        if (r.status === 'waitlisted') toast(`Full: ${rider.fullName} is number ${r.position} on the waitlist`);
        else if (r.status === BOOKING_STATUS.PENDING_OFFICE_PAYMENT) {
          const bookings = await get<Roster>(`/bookings${qs({ occurrenceId: occ.id })}`).catch(() => null);
          const until = r.holdExpiresAt ?? bookings?.bookings.find((b) => b.riderId === rider.id)?.holdExpiresAt;
          toast(`Place held for ${rider.fullName}${until ? ` until ${fmtTime(until)}` : ''}. Take payment to confirm.`);
        } else toast(`${rider.fullName} is booked`);
      }} />
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
        { name: 'riderId', label: 'For which rider (optional)', type: 'select', options: live.map((r) => ({ value: r.riderId, label: r.riderName })), blank: 'Everyone' },
        ...(manager ? [{ name: 'overrideReason', label: 'Override reason', type: 'text', hint: 'Only to knowingly break a rest or workload limit. Safety rules can never be overridden.' } as const] : []),
      ]}
      onSubmit={(v) => post(`/schedule/${occ.id}/horses`, { horseId: v.horseId, ...(v.riderId ? { riderId: v.riderId } : {}), ...(typeof v.overrideReason === 'string' && v.overrideReason.trim() ? { override: { reason: v.overrideReason.trim() } } : {}) })} />
  );
}
