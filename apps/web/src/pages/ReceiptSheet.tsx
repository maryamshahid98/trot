import { useBranch } from '../lib/branch';
import { fmtDateTime, label, money } from '../lib/format';
import type { Receipt } from '../lib/types';
import { Btn } from '../ui/kit';

/** One receipt laid out for the customer. "Print" prints just this (the browser can also save it as a PDF). */
export function ReceiptSheet({ r }: { r: Receipt }) {
  const { currency } = useBranch();
  const s = r.seller;
  return (
    <div className="print-area">
      <h2 className="card-title" style={{ fontSize: 20 }}>Receipt {r.number}</h2>
      {s && <p className="sub">{[s.name, s.branchName, s.address, s.phone, s.email, s.taxNumber ? `Tax number ${s.taxNumber}` : null].filter(Boolean).join(' · ')}</p>}
      <dl className="kv">
        <dt>Rider</dt><dd>{r.riderName}</dd>
        <dt>Amount</dt><dd>{money(r.amountMinor, currency)} (including VAT {money(r.vatMinor, currency)})</dd>
        <dt>Method</dt><dd>{label(r.method)}</dd>
        {r.terminalRef && <><dt>Card terminal reference</dt><dd>{r.terminalRef}</dd></>}
        <dt>Issued</dt><dd>{fmtDateTime(r.issuedAt)}</dd>
      </dl>
      <div className="form-actions no-print"><Btn kind="primary" onClick={() => window.print()}>Print receipt</Btn></div>
    </div>
  );
}
