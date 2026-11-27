import { useState } from 'react';
import { useBranch } from '../lib/branch';
import { dayEndIso, dayStartIso, fmtDate, fmtDateTime, label, money } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import { Badge, Btn, Card, Load, Modal, Table } from '../ui/kit';

interface InvoiceRow {
  id: string; number: string; status: string; riderName: string; currency: string; grossMinor: number; vatMinor: number; vatPercent: number;
  issuedAt: string; paidAt: string | null; receiptNumber: string | null; description: string | null;
}
interface InvoiceDetail extends InvoiceRow {
  branchName: string; payerName: string | null; sellerName: string; sellerTaxNumber: string | null; sellerAddress: string | null; sellerPhone: string | null; sellerEmail: string | null; sellerLogo: string | null;
  lines: { description: string; quantity: number; totalMinor: number; vatMinor: number }[];
  creditNotes: { id: string; number: string; amountMinor: number; vatMinor: number; reason: string; issuedAt: string }[];
}
const STATUSES = ['issued', 'paid', 'voided', 'credited'];
const PAGE = 25;

/** Invoices of the branch, newest first, with a status filter and a search by number. */
export function InvoicesTab() {
  const { branchId } = useBranch();
  const [status, setStatus] = useState('');
  const [number, setNumber] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery<{ total: number; invoices: InvoiceRow[] }>(branchId ? `/invoices${qs({ branchId, status, number: number.trim(), limit: PAGE, offset })}` : null);
  return (
    <Card flex>
      <div className="filters">
        <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <input aria-label="Invoice number" placeholder="Number, for example I-30001" value={number} onChange={(e) => { setNumber(e.target.value); setOffset(0); }} />
      </div>
      <Load q={list}>{(d) => (
        <>
          <Table rowKey={(i) => i.id} rows={d.invoices} empty="No invoices." onRow={(i) => setOpen(i.id)} cols={[
            { head: 'Number', cell: (i) => <b>{i.number}</b> },
            { head: 'Rider', cell: (i) => i.riderName },
            { head: 'For', cell: (i) => i.description ?? '', width: '2fr' },
            { head: 'Amount', cell: (i) => money(i.grossMinor, i.currency) },
            { head: 'Status', cell: (i) => <Badge value={i.status} /> },
            { head: 'Issued', cell: (i) => fmtDate(i.issuedAt) },
          ]} />
          <div className="actions" style={{ paddingTop: 12 }}>
            <Btn small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ Previous</Btn>
            <span className="sub">{d.total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</span>
            <Btn small disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Next ›</Btn>
          </div>
        </>
      )}</Load>
      {open && <InvoiceDialog id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

/** One invoice laid out like a paper invoice. "Print" prints just this (the browser can also save it as a PDF). */
export function InvoiceDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery<InvoiceDetail>(`/invoices/${id}`);
  return (
    <Modal title="Invoice" onClose={onClose} wide>
      <Load q={q}>{(i) => (
        <div className="print-area">
          <div className="doc-head">
            <div>{i.sellerLogo && <img className="doc-logo" src={i.sellerLogo} alt="" />}<h2 className="card-title" style={{ fontSize: 20 }}>Tax invoice {i.number}</h2><span className="sub">{[i.sellerName, i.branchName, i.sellerAddress, i.sellerPhone, i.sellerEmail].filter(Boolean).join(' · ')}</span><br />
              <span className="sub">{i.sellerTaxNumber ? `Tax number ${i.sellerTaxNumber}` : <span className="no-print">Add the club’s tax number under Admin &gt; Club.</span>}</span></div>
            <Badge value={i.status} />
          </div>
          <dl className="kv">
            <dt>Rider</dt><dd>{i.riderName}</dd>
            {i.payerName && <><dt>Billed to</dt><dd>{i.payerName}</dd></>}
            <dt>Issued</dt><dd>{fmtDateTime(i.issuedAt)}</dd>
            {i.paidAt && <><dt>Paid</dt><dd>{fmtDateTime(i.paidAt)}{i.receiptNumber ? ` · receipt ${i.receiptNumber}` : ''}</dd></>}
          </dl>
          <Table rowKey={(l) => l.description} rows={i.lines} cols={[
            { head: 'Description', cell: (l) => l.description, width: '3fr' }, { head: 'Qty', cell: (l) => l.quantity },
            { head: 'VAT', cell: (l) => money(l.vatMinor, i.currency) }, { head: 'Total', cell: (l) => money(l.totalMinor, i.currency), right: true },
          ]} />
          <dl className="kv totals">
            <dt>Total excluding VAT</dt><dd>{money(i.grossMinor - i.vatMinor, i.currency)}</dd>
            <dt>VAT ({i.vatPercent}%)</dt><dd>{money(i.vatMinor, i.currency)}</dd>
            <dt><b>Total</b></dt><dd><b>{money(i.grossMinor, i.currency)}</b></dd>
          </dl>
          {i.creditNotes.length > 0 && (
            <>
              <h3 className="card-title" style={{ padding: '12px 0 4px' }}>Credit notes</h3>
              <Table rowKey={(n) => n.id} rows={i.creditNotes} cols={[
                { head: 'Number', cell: (n) => <b>{n.number}</b> }, { head: 'Date', cell: (n) => fmtDate(n.issuedAt) }, { head: 'Reason', cell: (n) => n.reason, width: '2fr' },
                { head: 'Amount', cell: (n) => money(n.amountMinor, i.currency), right: true },
              ]} />
            </>
          )}
          <div className="form-actions no-print"><Btn onClick={() => window.print()}>Print or save as PDF</Btn></div>
        </div>
      )}</Load>
    </Modal>
  );
}

interface Account {
  riderName: string; currency: string; openingBalanceMinor: number; balanceMinor: number; unpaidInvoicesMinor: number;
  entries: { at: string; type: string; number: string; description: string; debitMinor: number; creditMinor: number; balanceMinor: number }[];
}
const TYPE_LABEL: Record<string, string> = { invoice: 'Invoice', receipt: 'Payment', credit_note: 'Credit note', refund_paid: 'Refund' };

/** A rider's account: what was charged, paid, credited and refunded, and where it stands. Print it as a statement. */
export function AccountPanel({ riderId }: { riderId: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useQuery<Account>(`/riders/${riderId}/account${qs({ from: from ? dayStartIso(from) : '', to: to ? dayEndIso(to) : '' })}`);
  return (
    <Card title="Account">
      <div className="filters">
        <label className="sub">From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="sub">To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <Load q={q}>{(a) => (
        <div className="print-area">
          {(from || to) && <p className="sub">Statement for {a.riderName}{from ? ` from ${from}` : ''}{to ? ` to ${to}` : ''} · opening balance {money(a.openingBalanceMinor, a.currency)}</p>}
          <p>
            {a.balanceMinor > 0 ? <>Owed by the family: <b>{money(a.balanceMinor, a.currency)}</b></> : a.balanceMinor < 0 ? <>Credit in the family's favour: <b>{money(-a.balanceMinor, a.currency)}</b></> : <>Nothing owed either way.</>}
            {a.unpaidInvoicesMinor > 0 && <span className="sub"> · {money(a.unpaidInvoicesMinor, a.currency)} on invoices not yet paid</span>}
          </p>
          <Table rowKey={(e) => `${e.at}${e.number}${e.type}`} rows={a.entries} empty="No activity yet." cols={[
            { head: 'Date', cell: (e) => fmtDate(e.at) },
            { head: 'What', cell: (e) => <span><b>{TYPE_LABEL[e.type] ?? e.type}</b> {e.number !== 'refund' && e.number}<br /><span className="sub">{e.description}</span></span>, width: '3fr' },
            { head: 'Charged', cell: (e) => (e.debitMinor ? money(e.debitMinor, a.currency) : ''), right: true },
            { head: 'Paid / credited', cell: (e) => (e.creditMinor ? money(e.creditMinor, a.currency) : ''), right: true },
            { head: 'Balance', cell: (e) => money(e.balanceMinor, a.currency), right: true },
          ]} />
          <div className="form-actions no-print"><Btn small onClick={() => window.print()}>Print statement</Btn></div>
        </div>
      )}</Load>
    </Card>
  );
}
