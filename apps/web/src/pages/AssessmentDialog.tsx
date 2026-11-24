import { useState } from 'react';
import { post, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { LEVELS, MANAGER_ROLES } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { fmtDate, label } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import { Badge, Btn, Card, Load, Modal, useAct } from '../ui/kit';

export interface Skill { id: string; name: string; description: string | null; forLevel: string; sortOrder: number; active: boolean }
interface Rating { skillId: string; skillName: string; rating: number; evidence: string | null }
export interface AssessmentRow {
  id: string; riderId: string; riderName: string; assessorId: string; assessorName: string; fromLevel: string; targetLevel: string;
  recommendation: string; status: string; notes: string | null; createdAt: string; submittedAt: string | null; decidedAt: string | null; decisionNote: string | null;
}
interface Detail extends AssessmentRow { ratings: Rating[] }

const RECOMMENDATIONS = [
  { value: 'promote', label: 'Promote to the next level' },
  { value: 'stay', label: 'Stay at this level' },
  { value: 'further_assessment', label: 'Needs further assessment' },
];
const SCALE = ['Not yet', 'Beginning', 'Getting there', 'Competent', 'Confident'];
const PASS = 3;

/** Rating a rider's skills, and (for a manager who did not do the assessment) deciding on it. */
export function AssessmentDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const { branchId } = useBranch();
  const act = useAct();
  const q = useQuery<Detail>(`/assessments/${id}`);
  const a = q.data;
  const skills = useQuery<{ skills: Skill[] }>(a && branchId ? `/skills${qs({ branchId, forLevel: a.targetLevel })}` : null);

  // What the assessor has typed but not yet saved. null means "as saved".
  const [draft, setDraft] = useState<{ recommendation?: string; notes?: string; ratings: Record<string, number> }>({ ratings: {} });
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mine = a?.assessorId === user?.id;
  const editable = !!a && mine && (a.status === 'draft' || a.status === 'needs_more');
  const canDecide = !!a && !mine && a.status === 'submitted' && MANAGER_ROLES.includes(user!.role as Role);
  const recommendation = draft.recommendation ?? a?.recommendation ?? 'promote';
  const notes = draft.notes ?? a?.notes ?? '';
  const ratingOf = (skillId: string): number | '' => draft.ratings[skillId] ?? a?.ratings.find((r) => r.skillId === skillId)?.rating ?? '';
  const required = recommendation === 'promote' ? (skills.data?.skills ?? []) : [];

  const save = async () => {
    const ratings = required.filter((s) => ratingOf(s.id) !== '').map((s) => ({ skillId: s.id, rating: Number(ratingOf(s.id)) }));
    await api('PUT', `/assessments/${id}`, { recommendation, notes, ...(ratings.length ? { ratings } : {}) });
    setDraft({ ratings: {} });
    q.reload();
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    const worked = await act(async () => { try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; } }, ok);
    if (worked) onChanged();
  };

  return (
    <Modal title={a ? `Assessment: ${a.riderName}` : 'Assessment'} onClose={onClose} wide>
      <Load q={q}>{(d) => (
        <>
          <p className="sub">
            {label(d.fromLevel)} → {label(d.targetLevel)} · started by {d.assessorName} on {fmtDate(d.createdAt)} · <Badge value={d.status} />
          </p>
          {d.status === 'needs_more' && d.decisionNote && <div className="error" role="status">Sent back: {d.decisionNote}</div>}
          {(d.status === 'approved' || d.status === 'rejected') && d.decisionNote && <p className="sub">Decision note: {d.decisionNote}</p>}

          <Card title="Recommendation">
            {editable ? (
              <div className="field">
                <select aria-label="Recommendation" value={recommendation} onChange={(e) => setDraft({ ...draft, recommendation: e.target.value })}>
                  {RECOMMENDATIONS.filter((r) => r.value !== 'promote' || d.fromLevel !== LEVELS[LEVELS.length - 1]).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            ) : <p>{RECOMMENDATIONS.find((r) => r.value === d.recommendation)?.label}</p>}
          </Card>

          {d.recommendation === 'promote' && (
            <Card title={`Skills needed for ${label(d.targetLevel)}`}>
              <Load q={skills}>{(s) => s.skills.length === 0 ? (
                <p className="sub">No skills are set up for {label(d.targetLevel)}, so your notes below are what justify the promotion. A manager can add skills under the Skills tab.</p>
              ) : (
                <div className="table-wrap"><div className="table" role="table" style={{ gridTemplateColumns: 'minmax(min-content, 2fr) minmax(min-content, 1.4fr)' }}>
                  {s.skills.map((sk) => {
                    const r = d.ratings.find((x) => x.skillId === sk.id);
                    const value = ratingOf(sk.id);
                    return (
                      <div className="tr" role="row" key={sk.id}>
                        <span role="cell" data-label="Skill"><b>{sk.name}</b>{sk.description && <span className="sub"> {sk.description}</span>}</span>
                        <span role="cell" data-label="Rating">
                          {editable ? (
                            <select aria-label={`Rating for ${sk.name}`} value={value} onChange={(e) => setDraft({ ...draft, ratings: { ...draft.ratings, [sk.id]: Number(e.target.value) } })}>
                              <option value="" disabled>Not rated</option>
                              {SCALE.map((l, i) => <option key={l} value={i + 1}>{i + 1} · {l}</option>)}
                            </select>
                          ) : r ? <span><Badge value={r.rating >= PASS ? 'passed' : 'below'} /> {r.rating} · {SCALE[r.rating - 1]}</span> : <span className="sub">Not rated</span>}
                        </span>
                      </div>
                    );
                  })}
                </div></div>
              )}</Load>
            </Card>
          )}

          <Card title="Notes">
            {editable ? (
              <div className="field"><textarea aria-label="Assessor's notes" rows={4} value={notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></div>
            ) : <p style={{ whiteSpace: 'pre-wrap' }}>{d.notes || <span className="sub">No notes.</span>}</p>}
          </Card>

          {error && <div className="error" role="alert">{error}</div>}

          {editable && (
            <div className="form-actions">
              <Btn onClick={() => void run(save, 'Saved')}>Save</Btn>
              <Btn kind="primary" onClick={() => void run(async () => { await save(); await post(`/assessments/${id}/submit`); }, 'Sent for approval')}>Save and send for approval</Btn>
            </div>
          )}

          {canDecide && (
            <Card title="Your decision">
              <p className="sub">Approving a promotion moves the rider to {label(d.targetLevel)} and records it in their level history.</p>
              <div className="field"><textarea aria-label="Decision note" rows={2} placeholder="Note (required to reject or send back)" value={note} onChange={(e) => setNote(e.target.value)} /></div>
              <div className="form-actions">
                <Btn onClick={() => void run(() => post(`/assessments/${id}/decision`, { decision: 'request_more', note }), 'Sent back to the assessor')}>Send back</Btn>
                <Btn kind="danger" onClick={() => void run(() => post(`/assessments/${id}/decision`, { decision: 'reject', note }), 'Rejected')}>Reject</Btn>
                <Btn kind="primary" onClick={() => void run(() => post(`/assessments/${id}/decision`, { decision: 'approve', ...(note.trim() ? { note } : {}) }), 'Approved')}>Approve</Btn>
              </div>
            </Card>
          )}
          {!editable && !canDecide && d.status === 'submitted' && <p className="sub">Waiting for a manager or owner other than {d.assessorName} to decide.</p>}
        </>
      )}</Load>
    </Modal>
  );
}
