import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, post } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { BOOKING_STATUS, MANAGER_ROLES } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { fmtDateTime, label } from '../lib/format';
import { textOrNull } from '../lib/form';
import { qs, useQuery } from '../lib/useApi';
import type { Horse, Occurrence, RosterBooking } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import { Btn, Modal } from '../ui/kit';
import { opts } from '../ui/pickers';

/** The booking number as text and as a QR code, to print or show at the gate (BKG-007). */
export function BookingPass({ b, occ, onClose }: { b: RosterBooking; occ: Occurrence; onClose: () => void }) {
  const [src, setSrc] = useState('');
  useEffect(() => { void QRCode.toDataURL(b.number, { width: 220, margin: 1 }).then(setSrc); }, [b.number]);
  return (
    <Modal title={`Booking ${b.number}`} onClose={onClose}>
      <div className="print-area" style={{ textAlign: 'center' }}>
        <h2 className="card-title">{b.number}</h2>
        <p><b>{b.riderName}</b><br />{occ.title}<br />{fmtDateTime(occ.startsAt)} · {occ.arenaName}</p>
        {src && <img src={src} width={220} height={220} alt={`QR code for booking ${b.number}`} />}
        <div className="form-actions no-print"><Btn kind="primary" onClick={() => window.print()}>Print</Btn></div>
      </div>
    </Modal>
  );
}

const ATTENDANCE = ['present', 'late', 'absent', 'excused'] as const;

/** What happened in the lesson, and how the rider attended (ATT-002, ATT-006). */
export function LessonRecord({ b, onClose, onDone }: { b: RosterBooking; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const { branchId } = useBranch();
  const manager = MANAGER_ROLES.includes(user!.role as Role);
  const final = b.status === BOOKING_STATUS.COMPLETED || b.status === BOOKING_STATUS.NO_SHOW;
  const canMark = final ? manager : b.status === BOOKING_STATUS.CHECKED_IN;
  const horses = useQuery<{ horses: Horse[] }>(branchId ? `/horses${qs({ branchId })}` : null);
  const skills = useQuery<{ skills: { id: string; name: string }[] }>('/skills');
  const choices = final ? ATTENDANCE : (['present', 'late'] as const);
  return (
    <FormDialog title={`Lesson record: ${b.riderName}`} onClose={onClose} onDone={onDone}
      initial={{ attendance: b.attendance ?? '', horseId: b.horseId ?? '', outcome: b.outcome ?? '', skillIds: b.skillIds ?? [], notes: b.notes ?? '' }}
      fields={[
        ...(canMark ? [{ name: 'attendance', label: 'Attendance', type: 'select', options: opts(choices), blank: 'Not changed', hint: final ? 'This is final: a change needs a reason and is logged.' : undefined } as const] : []),
        ...(canMark && final ? [{ name: 'reason', label: 'Reason for changing attendance', type: 'text', showIf: (v: Record<string, unknown>) => !!v.attendance && v.attendance !== (b.attendance ?? '') } as const] : []),
        { name: 'horseId', label: 'Horse actually ridden', type: 'select', options: (horses.data?.horses ?? []).map((h) => ({ value: h.id, label: h.name })), blank: 'Not recorded' },
        { name: 'outcome', label: 'Lesson outcome', type: 'textarea' },
        { name: 'skillIds', label: 'Skills practised', type: 'checks', options: (skills.data?.skills ?? []).map((k) => ({ value: k.id, label: k.name })), hint: skills.data && skills.data.skills.length === 0 ? 'No skills are set up yet (Progress > Skills).' : undefined },
        { name: 'notes', label: 'Instructor notes (staff only)', type: 'textarea' },
      ]}
      onSubmit={async (v) => {
        if (canMark && v.attendance && v.attendance !== (b.attendance ?? '')) {
          await post(`/bookings/${b.id}/attendance`, { attendance: v.attendance, ...(textOrNull(v.reason) ? { reason: textOrNull(v.reason) } : {}) });
        }
        await api('PUT', `/bookings/${b.id}/record`, { horseId: textOrNull(v.horseId), outcome: textOrNull(v.outcome), skillIds: v.skillIds, notes: textOrNull(v.notes) });
      }} />
  );
}

export const attendanceText = (b: RosterBooking) => (b.attendance ? label(b.attendance) : '');
