import { useState } from 'react';
import { api, fetchFile, post, uploadFile } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DOC_KINDS, FRONT_DESK, LEVELS, MANAGER_ROLES, PACKAGE_STATUSES_SETTABLE, PAYMENT_METHODS, RIDER_STATUSES, ROLE } from '../../constants';
import type { Role } from '../../constants';
import { useBranch } from '../../lib/branch';
import { fmtDate, label, money, toMinor } from '../../lib/format';
import { errorText } from '../../lib/useApi';
import { qs, useQuery } from '../../lib/useApi';
import type { PackageType, RiderDetail } from '../../lib/types';
import { FormDialog } from '../../ui/FormDialog';
import { Badge, Btn, Card, Confirm, Load, Modal, Table, Tabs, useAct } from '../../ui/kit';
import { opts } from '../../ui/pickers';
import { AccountPanel } from '../Invoices';

interface Doc { id: string; kind: string; status: string; signedAt: string | null; expiresAt: string | null; rejectedReason?: string | null; hasFile?: boolean; fileName?: string | null; fileType?: string | null; fileSize?: number | null }

const MAX_FILE_BYTES = 5 * 1024 * 1024; // the server's default limit; the server is the one that enforces it
const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const fileProblem = (f: File | null): string | null => (f && f.size > MAX_FILE_BYTES ? 'That file is over 5 MB. Choose a smaller scan or photo.' : null);

/** A file picker for the form dialogs. The file is kept by the caller, so the dialog's own answers stay simple text. */
function FilePick({ file, onPick }: { file: File | null; onPick: (f: File | null) => void }) {
  const problem = fileProblem(file);
  return (
    <div className="field">
      <label htmlFor="doc-file">Scan or photo (PDF, JPEG or PNG, up to 5 MB)</label>
      <input id="doc-file" type="file" accept={FILE_ACCEPT} onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
      {problem && <span className="error" role="alert">{problem}</span>}
    </div>
  );
}
interface Progress {
  level: string; ratingMax: number;
  history: { fromLevel: string | null; toLevel: string; reason: string; changedAt: string; changedBy: string | null }[];
  assessments: { id: string; fromLevel: string; targetLevel: string; status: string; decidedAt: string | null; ratings: { skillName: string; rating: number }[] }[];
}
interface Guardian { accountId: string; fullName: string | null; email: string | null; phone: string | null }
interface Pkg { id: string; status: string; name: string; balance: number; purchasedAt: string; validUntil: string; classFormats: string[] }
interface Ledger { entries: { id: string; delta: number; reason: string; note: string | null; at: string }[]; balance: number }
type Dlg = null | 'edit' | 'status' | 'level' | 'doc' | 'addGuardian' | 'sell' | { attach: Doc } | { view: { name: string; url: string | null } } | { reject: Doc } | { removeG: Guardian } | { ledger: Pkg } | { adjust: Pkg } | { pstatus: Pkg };

export function RiderDialog({ riderId, onClose, onChanged }: { riderId: string; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const { branchId, currency } = useBranch();
  const role = user!.role as Role;
  const act = useAct();
  const front = FRONT_DESK.includes(role);
  const manager = MANAGER_ROLES.includes(role);
  const canLevel = role === ROLE.COACH || manager;
  const [tab, setTab] = useState<'profile' | 'guardians' | 'documents' | 'packages' | 'account' | 'progress'>('profile');
  const [dlg, setDlg] = useState<Dlg>(null);
  const r = useQuery<RiderDetail>(`/riders/${riderId}`);
  const guardians = useQuery<{ guardians: Guardian[] }>(tab === 'guardians' && front ? `/riders/${riderId}/guardians` : null);
  const docs = useQuery<{ documents: Doc[] }>(tab === 'documents' ? `/riders/${riderId}/documents` : null);
  const pkgs = useQuery<{ packages: Pkg[] }>(tab === 'packages' ? `/riders/${riderId}/packages` : null);
  const progress = useQuery<Progress>(tab === 'progress' ? `/riders/${riderId}/progress` : null);
  const types = useQuery<{ packageTypes: PackageType[] }>(dlg === 'sell' && branchId ? `/package-types${qs({ branchId })}` : null);
  const [pick, setPick] = useState<File | null>(null);
  const openFile = (k: Doc) => void act(async () => {
    const { blob, type } = await fetchFile(`/documents/${k.id}/file`);
    const url = URL.createObjectURL(blob);
    if (type.startsWith('image/')) setDlg({ view: { name: k.fileName ?? 'Document', url } });
    else { // a PDF is saved to the device: a tab opened from here would have to obey this site's strict security rules
      const a = document.createElement('a');
      a.href = url;
      a.download = k.fileName ?? 'document.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  });
  const reloadAll = () => { r.reload(); guardians.reload(); docs.reload(); pkgs.reload(); onChanged(); };
  const done = () => { setDlg(null); reloadAll(); };
  const d = r.data;

  return (
    <Modal title={d?.fullName ?? 'Rider'} onClose={onClose} wide>
      <div className="actions" style={{ paddingBottom: 12 }}>
        <Tabs tabs={[{ id: 'profile', label: 'Profile' }, ...(front ? [{ id: 'guardians' as const, label: 'Guardians' }] : []), { id: 'documents', label: 'Documents' }, { id: 'packages', label: 'Packages' }, ...(front ? [{ id: 'account' as const, label: 'Account' }] : []), { id: 'progress', label: 'Progress' }]} value={tab} onChange={setTab} />
      </div>

      {tab === 'profile' && <Load q={r}>{(x) => (
        <Card title="Profile" actions={<>
          {canLevel && <Btn small onClick={() => setDlg('level')}>Set level</Btn>}
          {front && <Btn small onClick={() => setDlg('status')}>Change status</Btn>}
          {front && <Btn small kind="primary" onClick={() => setDlg('edit')}>Edit</Btn>}
        </>}>
          <dl className="kv">
            <dt>Born</dt><dd>{x.dateOfBirth}</dd><dt>Level</dt><dd>{label(x.level)}</dd><dt>Status</dt><dd><Badge value={x.status} /></dd>
            <dt>Walk-in</dt><dd>{x.isWalkIn ? 'Yes' : 'No'}</dd>
            <dt>Emergency contact</dt><dd>{x.emergencyContact ? `${x.emergencyContact.name}, ${x.emergencyContact.phone}` : '—'}</dd>
            <dt>Medical notes</dt><dd>{x.medicalNotes ?? '—'}</dd><dt>Allergies</dt><dd>{x.allergies ?? '—'}</dd>
          </dl>
        </Card>
      )}</Load>}

      {tab === 'guardians' && front && (
        <Card title="Guardians" actions={manager ? <Btn small kind="primary" onClick={() => setDlg('addGuardian')}>Add guardian</Btn> : undefined}>
          <Load q={guardians}>{(g) => <Table rowKey={(x) => x.accountId} rows={g.guardians} empty="No guardian linked." cols={[
            { head: 'Name', cell: (x) => <b>{x.fullName}</b> }, { head: 'Email', cell: (x) => x.email ?? '' }, { head: 'Phone', cell: (x) => x.phone ?? '' },
            { head: '', cell: (x) => <Btn small kind="danger" onClick={() => setDlg({ removeG: x })}>Remove</Btn>, right: true, width: '0.8fr' },
          ]} />}</Load>
        </Card>
      )}

      {tab === 'documents' && (
        <Card title="Medical form, waiver and permissions" actions={<Btn small kind="primary" onClick={() => setDlg('doc')}>Record a document</Btn>}>
          <Load q={docs}>{(x) => <Table rowKey={(k) => k.id} rows={x.documents} empty="No documents yet." cols={[
            { head: 'Document', cell: (k) => <b>{label(k.kind)}</b> }, { head: 'Status', cell: (k) => <Badge value={k.status} /> },
            { head: 'Signed', cell: (k) => (k.signedAt ? fmtDate(k.signedAt) : '') }, { head: 'Expires', cell: (k) => (k.expiresAt ? fmtDate(k.expiresAt) : '') },
            { head: 'File', cell: (k) => (k.hasFile ? <Btn small onClick={() => openFile(k)}>{k.fileType === 'application/pdf' ? 'Download' : 'View'}</Btn> : <Btn small onClick={() => { setPick(null); setDlg({ attach: k }); }}>Attach file</Btn>) },
            { head: '', width: '1.6fr', right: true, cell: (k) => front && k.status === 'submitted' ? (
              <span className="actions"><Btn small kind="primary" onClick={() => void act(() => post(`/documents/${k.id}/verify`), 'Verified').then((ok) => ok && reloadAll())}>Verify</Btn><Btn small kind="danger" onClick={() => setDlg({ reject: k })}>Reject</Btn></span>
            ) : null },
          ]} />}</Load>
        </Card>
      )}

      {tab === 'account' && front && <AccountPanel riderId={riderId} />}
      {tab === 'progress' && (
        <Card title="Level history and assessments">
          <Load q={progress}>{(x) => (
            <>
              <p>Current level: <Badge value={x.level} /></p>
              <Table rowKey={(h) => `${h.changedAt}${h.toLevel}`} rows={x.history} empty="No changes yet." cols={[
                { head: 'When', cell: (h) => fmtDate(h.changedAt) },
                { head: 'Change', cell: (h) => (h.fromLevel ? `${label(h.fromLevel)} → ${label(h.toLevel)}` : `Started at ${label(h.toLevel)}`) },
                { head: 'Why', cell: (h) => label(h.reason) },
                { head: 'By', cell: (h) => h.changedBy ?? '' },
              ]} />
              <h3 className="card-title" style={{ padding: '16px 0 4px' }}>Assessments</h3>
              <Table rowKey={(a) => a.id} rows={x.assessments} empty="No assessments yet." cols={[
                { head: 'Date', cell: (a) => (a.decidedAt ? fmtDate(a.decidedAt) : '') },
                { head: 'Level', cell: (a) => `${label(a.fromLevel)} → ${label(a.targetLevel)}` },
                { head: 'Result', cell: (a) => <Badge value={a.status} /> },
                { head: 'Skills', width: '2fr', cell: (a) => (a.ratings.length ? a.ratings.map((s) => `${s.skillName} ${s.rating}/${x.ratingMax}`).join(' · ') : '') },
              ]} />
            </>
          )}</Load>
        </Card>
      )}      {tab === 'packages' && (
        <Card title="Class packages" actions={front ? <Btn small kind="primary" onClick={() => setDlg('sell')}>Sell package</Btn> : undefined}>
          <Load q={pkgs}>{(x) => <Table rowKey={(k) => k.id} rows={x.packages} empty="No packages." cols={[
            { head: 'Package', cell: (k) => <b>{k.name}</b>, width: '1.4fr' }, { head: 'Left', cell: (k) => k.balance, width: '0.5fr' }, { head: 'Status', cell: (k) => <Badge value={k.status} /> },
            { head: 'Valid until', cell: (k) => fmtDate(k.validUntil) },
            { head: '', width: '2fr', right: true, cell: (k) => (
              <span className="actions"><Btn small onClick={() => setDlg({ ledger: k })}>History</Btn>
                {manager && <Btn small onClick={() => setDlg({ adjust: k })}>Adjust</Btn>}{manager && <Btn small onClick={() => setDlg({ pstatus: k })}>Status</Btn>}</span>
            ) },
          ]} />}</Load>
        </Card>
      )}

      {dlg === 'edit' && d && (
        <FormDialog title="Edit rider" onClose={() => setDlg(null)} onDone={done}
          initial={{ fullName: d.fullName, dateOfBirth: d.dateOfBirth, medicalNotes: d.medicalNotes ?? '', allergies: d.allergies ?? '', ecName: d.emergencyContact?.name ?? '', ecPhone: d.emergencyContact?.phone ?? '' }}
          fields={[{ name: 'fullName', label: 'Full name', type: 'text', required: true }, { name: 'dateOfBirth', label: 'Date of birth', type: 'date' }, { name: 'ecName', label: 'Emergency contact name', type: 'text' }, { name: 'ecPhone', label: 'Emergency contact phone', type: 'tel' }, { name: 'medicalNotes', label: 'Medical notes', type: 'textarea' }, { name: 'allergies', label: 'Allergies', type: 'textarea' }]}
          onSubmit={(v) => api('PATCH', `/riders/${riderId}`, { fullName: v.fullName, dateOfBirth: v.dateOfBirth, emergencyContact: v.ecName && v.ecPhone ? { name: v.ecName, phone: v.ecPhone } : null, medicalNotes: v.medicalNotes || null, allergies: v.allergies || null })} />
      )}
      {dlg === 'level' && d && <FormDialog title="Set level" onClose={() => setDlg(null)} onDone={done} initial={{ level: d.level }} fields={[{ name: 'level', label: 'Level', type: 'select', required: true, options: opts(LEVELS) }]} onSubmit={(v) => post(`/riders/${riderId}/level`, { level: v.level })} />}
      {dlg === 'status' && d && <FormDialog title="Change status" onClose={() => setDlg(null)} onDone={done} initial={{ status: d.status }} fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: opts(RIDER_STATUSES) }, { name: 'reason', label: 'Reason', type: 'text' }]} onSubmit={(v) => post(`/riders/${riderId}/status`, { status: v.status, ...(v.reason ? { reason: v.reason } : {}) })} />}
      {dlg === 'doc' && (
        <FormDialog title="Record a document" onClose={() => setDlg(null)} onDone={done}
          fields={[{ name: 'kind', label: 'Document', type: 'select', required: true, options: opts(DOC_KINDS) }, { name: 'signedAt', label: 'Signed on', type: 'date' }, { name: 'expiresAt', label: 'Expires on', type: 'date', hint: 'Medical forms expire. Leave blank if it does not.' }]}
          extra={<FilePick file={pick} onPick={setPick} />}
          onSubmit={async (v) => {
            const problem = fileProblem(pick);
            if (problem) throw new Error(problem);
            const made = await post<{ id: string }>(`/riders/${riderId}/documents`, { kind: v.kind, ...(v.signedAt ? { signedAt: new Date(`${v.signedAt}T00:00:00Z`).toISOString() } : {}), ...(v.expiresAt ? { expiresAt: new Date(`${v.expiresAt}T00:00:00Z`).toISOString() } : {}) });
            if (pick) {
              try { await uploadFile(`/documents/${made.id}/file`, pick); }
              catch (e) { reloadAll(); throw new Error(`The document was recorded, but its file could not be attached: ${errorText(e)} Use "Attach file" on the document to try again.`, { cause: e }); }
            }
          }} />
      )}
      {typeof dlg === 'object' && dlg && 'attach' in dlg && (
        <FormDialog title={`Attach a file: ${label(dlg.attach.kind)}`} submit="Attach" fields={[]} onClose={() => setDlg(null)} onDone={done}
          extra={<FilePick file={pick} onPick={setPick} />}
          onSubmit={async () => {
            if (!pick) throw new Error('Choose a file first.');
            const problem = fileProblem(pick);
            if (problem) throw new Error(problem);
            await uploadFile(`/documents/${dlg.attach.id}/file`, pick);
          }} />
      )}
      {typeof dlg === 'object' && dlg && 'view' in dlg && (
        <Modal title={dlg.view.name} onClose={() => { if (dlg.view.url) URL.revokeObjectURL(dlg.view.url); setDlg(null); }} wide>
          {dlg.view.url && <img src={dlg.view.url} alt={dlg.view.name} style={{ maxWidth: '100%', borderRadius: 12 }} />}
        </Modal>
      )}
      {typeof dlg === 'object' && dlg && 'reject' in dlg && <FormDialog title="Reject document" onClose={() => setDlg(null)} onDone={done} fields={[{ name: 'reason', label: 'Reason', type: 'text', required: true }]} onSubmit={(v) => post(`/documents/${dlg.reject.id}/reject`, { reason: v.reason })} />}
      {dlg === 'addGuardian' && <AddGuardian riderId={riderId} onClose={() => setDlg(null)} onDone={done} />}
      {typeof dlg === 'object' && dlg && 'removeG' in dlg && <Confirm title="Remove guardian?" text={dlg.removeG.fullName ?? ''} danger onClose={() => setDlg(null)} onDone={done} action={() => api('DELETE', `/riders/${riderId}/guardians/${dlg.removeG.accountId}`)} />}
      {dlg === 'sell' && (
        <FormDialog title="Sell a package" submit="Sell and take payment" onClose={() => setDlg(null)} onDone={done}
          fields={[{ name: 'packageTypeId', label: 'Package', type: 'select', required: true, options: (types.data?.packageTypes ?? []).filter((t) => t.active).map((t) => ({ value: t.id, label: `${t.name} · ${t.classes} classes · ${money(t.priceMinor, currency)}` })) }, { name: 'method', label: 'Paid by', type: 'select', required: true, options: opts(PAYMENT_METHODS) }, { name: 'amount', label: 'Amount (SAR, optional)', type: 'money', hint: 'Leave blank to charge the package price.' }]}
          initial={{ method: 'cash' }} onSubmit={(v) => post(`/riders/${riderId}/packages`, { packageTypeId: v.packageTypeId, method: v.method, ...(v.amount ? { amountMinor: toMinor(String(v.amount)) } : {}) })} />
      )}
      {typeof dlg === 'object' && dlg && 'ledger' in dlg && <LedgerDialog pkg={dlg.ledger} onClose={() => setDlg(null)} />}
      {typeof dlg === 'object' && dlg && 'adjust' in dlg && <FormDialog title={`Adjust: ${dlg.adjust.name}`} onClose={() => setDlg(null)} onDone={done} fields={[{ name: 'delta', label: 'Classes to add (negative to remove)', type: 'number', required: true }, { name: 'reason', label: 'Reason', type: 'text', required: true }]} onSubmit={(v) => post(`/packages/${dlg.adjust.id}/adjust`, { delta: Number(v.delta), reason: v.reason })} />}
      {typeof dlg === 'object' && dlg && 'pstatus' in dlg && <FormDialog title={`Package status: ${dlg.pstatus.name}`} onClose={() => setDlg(null)} onDone={done} initial={{ status: 'active' }} fields={[{ name: 'status', label: 'Status', type: 'select', required: true, options: opts(PACKAGE_STATUSES_SETTABLE) }, { name: 'reason', label: 'Reason', type: 'text', required: true }]} onSubmit={(v) => post(`/packages/${dlg.pstatus.id}/status`, { status: v.status, reason: v.reason })} />}
    </Modal>
  );
}

function LedgerDialog({ pkg, onClose }: { pkg: Pkg; onClose: () => void }) {
  const q = useQuery<Ledger>(`/packages/${pkg.id}/ledger`);
  return (
    <Modal title={`History: ${pkg.name}`} onClose={onClose}>
      <Load q={q}>{(l) => (<>
        <p>Classes left: <b>{l.balance}</b></p>
        <Table rowKey={(e) => e.id} rows={l.entries} cols={[{ head: 'When', cell: (e) => fmtDate(e.at) }, { head: 'Change', cell: (e) => (e.delta > 0 ? `+${e.delta}` : String(e.delta)), width: '0.6fr' }, { head: 'Why', cell: (e) => label(e.reason) }, { head: 'Note', cell: (e) => e.note ?? '' }]} />
      </>)}</Load>
    </Modal>
  );
}

function AddGuardian({ riderId, onClose, onDone }: { riderId: string; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const found = useQuery<{ accounts: { id: string; fullName: string; email: string; role: string }[] }>(q.trim().length >= 2 ? `/accounts${qs({ q: q.trim(), role: 'customer', limit: 8 })}` : null);
  const act = useAct();
  return (
    <Modal title="Add a guardian" onClose={onClose}>
      <div className="field"><label htmlFor="gq">Find the customer account</label><input id="gq" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or email" /></div>
      <Load q={found}>{(d) => <Table rowKey={(a) => a.id} rows={d.accounts} empty="No customer accounts match." onRow={(a) => void act(() => post(`/riders/${riderId}/guardians`, { accountId: a.id }), 'Guardian added').then((ok) => ok && onDone())} cols={[{ head: 'Name', cell: (a) => <b>{a.fullName}</b> }, { head: 'Email', cell: (a) => a.email }]} />}</Load>
    </Modal>
  );
}
