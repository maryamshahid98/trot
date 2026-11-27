import { useState } from 'react';
import { api } from '../api/client';
import { useBranch } from '../lib/branch';
import { label } from '../lib/format';
import { asValues, textOrNull } from '../lib/form';
import { qs, useQuery } from '../lib/useApi';
import { FormDialog } from '../ui/FormDialog';
import { Btn, Card, Load, Modal, Table } from '../ui/kit';

interface Template { event: string; kind: 'essential' | 'reminder'; subject: string | null; body: string | null }

/** The club's own wording for each message. Without it the built-in wording is sent. */
export function TemplatesTab() {
  const { branchId } = useBranch();
  const q = useQuery<{ placeholders: string[]; templates: Template[] }>(branchId ? `/notifications/templates${qs({ branchId })}` : null);
  const [edit, setEdit] = useState<Template | null>(null);
  return (
    <Card flex title="Message wording">
      <Load q={q}>{(d) => <>
        <Table rowKey={(t) => t.event} rows={d.templates} cols={[
          { head: 'Message', cell: (t) => <b>{label(t.event.replace(/\./g, '_'))}</b> }, { head: 'Sent', cell: (t) => (t.kind === 'essential' ? 'Always' : 'Only if the person accepts reminders') },
          { head: 'Wording', cell: (t) => t.subject ?? 'Built-in', width: '2fr' }, { head: '', right: true, cell: (t) => <Btn small onClick={() => setEdit(t)}>Edit</Btn> },
        ]} />
        {edit && <FormDialog wide title={`Wording: ${label(edit.event.replace(/\./g, '_'))}`} onClose={() => setEdit(null)} onDone={() => { setEdit(null); q.reload(); }} initial={asValues(edit, ['subject', 'body'])}
          fields={[{ name: 'subject', label: 'Subject', type: 'text', hint: `You can use ${d.placeholders.map((p) => `{${p}}`).join(' ')}` }, { name: 'body', label: 'Message', type: 'textarea', hint: 'Leave both empty to use the built-in wording.' }]}
          onSubmit={(v) => { const subject = textOrNull(v.subject); const body = textOrNull(v.body); if (!subject !== !body) throw new Error('Fill in both the subject and the message, or neither.'); return api('PUT', '/notifications/templates', { branchId, event: edit.event, subject, body }); }} />}
      </>}</Load>
    </Card>
  );
}

/** A family's reminder choices, changed at the desk when they ask. */
export function PreferencesDialog({ accountId, name, onClose }: { accountId: string; name: string; onClose: () => void }) {
  const q = useQuery<{ emailEnabled: boolean; smsEnabled: boolean }>(`/notifications/customers/${accountId}/preferences`);
  if (!q.data) return <Modal title={`Messages: ${name}`} onClose={onClose}><Load q={q}>{() => null}</Load></Modal>;
  return (
    <FormDialog title={`Messages: ${name}`} onClose={onClose} onDone={onClose} initial={asValues(q.data, ['emailEnabled', 'smsEnabled'])}
      fields={[{ name: 'emailEnabled', label: 'Reminders by email', type: 'checkbox' }, { name: 'smsEnabled', label: 'Reminders by text message', type: 'checkbox', hint: 'Confirmations, receipts and cancellations are always sent.' }]}
      onSubmit={(v) => api('PUT', `/notifications/customers/${accountId}/preferences`, { emailEnabled: v.emailEnabled === true, smsEnabled: v.smsEnabled === true })} />
  );
}
