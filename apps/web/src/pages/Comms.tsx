import { useState } from 'react';
import { post } from '../api/client';
import { useBranch } from '../lib/branch';
import { fmtDateTime, label } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import { Badge, Btn, Card, Load, PageHead, Table, Tabs, useAct, useToast } from '../ui/kit';
import { TemplatesTab } from './MessageSettings';

interface Message {
  id: number; event: string; channel: string; to: string; subject: string; status: string; attempts: number;
  lastError: string | null; createdAt: string; sentAt: string | null; recipientName: string | null;
}
const STATUSES = ['queued', 'sending', 'sent', 'failed', 'skipped'];
const EVENT_LABELS: Record<string, string> = {
  'booking.confirmed': 'Booking confirmed', 'booking.pending_payment': 'Place held', 'payment.received': 'Receipt', 'payment.refunded': 'Refund', 'booking.cancelled': 'Booking cancelled',
  'class.cancelled': 'Class cancelled', 'class.changed': 'Class changed', 'waitlist.offered': 'Waitlist offer', 'class.reminder': 'Class reminder', 'package.low_balance': 'Package low',
  'package.expiring': 'Package expiring', 'document.expiring': 'Document expiring', 'incident.escalated': 'Incident', 'assessment.decided': 'Assessment',
};
const PAGE = 25;

export function Comms() {
  const { branchId, branch } = useBranch();
  const act = useAct();
  const toast = useToast();
  const [tab, setTab] = useState<'sent' | 'wording'>('sent');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const list = useQuery<{ total: number; messages: Message[] }>(branchId ? `/notifications${qs({ branchId, status, limit: PAGE, offset })}` : null);

  const sendNow = () => void act(async () => {
    const r = await post<{ sent: number; failed: number; retrying: number; skipped: number }>('/notifications/dispatch');
    toast(`${r.sent} sent${r.retrying ? `, ${r.retrying} will be tried again` : ''}${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`);
    list.reload();
  });
  const retry = (m: Message) => void act(async () => { await post(`/notifications/${m.id}/retry`); list.reload(); }, 'Queued again');

  return (
    <>
      <PageHead title="Messages" sub={`${branch?.name ?? ''} · who was told what`} actions={<Btn kind="primary" onClick={sendNow}>Send now</Btn>} />
      <div className="page">
        <Tabs tabs={[{ id: 'sent', label: 'Messages' }, { id: 'wording', label: 'Wording' }]} value={tab} onChange={setTab} />
        {tab === 'wording' && <TemplatesTab />}
        {tab === 'sent' && <Card flex>
          <p className="sub" style={{ marginTop: 0 }}>
            Confirmations, receipts, cancellations and waitlist offers are queued the moment they happen and sent within a minute. Reminders follow each person's choices.
            A message that fails is tried again after 2, 4, 8 and 16 minutes, then shown here as failed.
          </p>
          <div className="filters">
            <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
              <option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </div>
          <Load q={list}>{(d) => (
            <>
              <Table rowKey={(m) => String(m.id)} rows={d.messages} empty="No messages yet." cols={[
                { head: 'When', cell: (m) => fmtDateTime(m.createdAt), width: '1.2fr' },
                { head: 'To', cell: (m) => <span><b>{m.recipientName ?? ''}</b><br /><span className="sub">{m.to} · {m.channel}</span></span>, width: '1.6fr' },
                { head: 'About', cell: (m) => <span><b>{EVENT_LABELS[m.event] ?? m.event}</b><br /><span className="sub">{m.subject}</span></span>, width: '2fr' },
                { head: 'Status', cell: (m) => <span><Badge value={m.status} />{m.attempts > 1 && <span className="sub"> {m.attempts} tries</span>}{m.lastError && <><br /><span className="sub">{m.lastError}</span></>}</span>, width: '1.6fr' },
                { head: '', right: true, cell: (m) => (m.status === 'failed' || m.status === 'skipped' ? <Btn small onClick={() => retry(m)}>Try again</Btn> : null) },
              ]} />
              <div className="actions" style={{ paddingTop: 12 }}>
                <Btn small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ Previous</Btn>
                <span className="sub">{d.total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</span>
                <Btn small disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Next ›</Btn>
              </div>
            </>
          )}</Load>
        </Card>}
      </div>
    </>
  );
}
