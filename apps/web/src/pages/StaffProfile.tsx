import { api } from '../api/client';
import { CLASS_FORMATS, LEVELS } from '../constants';
import { asValues, numberOrNull, textOrNull } from '../lib/form';
import { useQuery } from '../lib/useApi';
import { FormDialog } from '../ui/FormDialog';
import type { Values } from '../ui/FormDialog';
import { Load, Modal } from '../ui/kit';
import { opts } from '../ui/pickers';

interface Profile { qualifications: string | null; levels: string[]; formats: string[]; certificationExpires: string | null; workDays: number[]; workFrom: string | null; workTo: string | null; maxSessionsPerDay: number | null }
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((label, i) => ({ value: String(i), label }));

/** What an instructor may teach and when they work. Scheduling checks every session against it. */
export function StaffProfileDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const q = useQuery<{ profile: Profile | null }>(`/staff/${id}/profile`);
  if (!q.data) return <Modal title={`Qualifications: ${name}`} onClose={onClose}><Load q={q}>{() => null}</Load></Modal>;
  const p = q.data.profile;
  const initial: Values = p
    ? { ...asValues(p, ['qualifications', 'levels', 'formats', 'certificationExpires', 'workFrom', 'workTo', 'maxSessionsPerDay']), workDays: p.workDays.map(String) }
    : { levels: [...LEVELS], formats: [], workDays: [] };
  return (
    <FormDialog title={`Qualifications: ${name}`} onClose={onClose} onDone={onClose} initial={initial}
      fields={[
        { name: 'qualifications', label: 'Qualifications and disciplines', type: 'textarea' },
        { name: 'levels', label: 'Riding levels they may teach', type: 'checks', options: opts(LEVELS) },
        { name: 'formats', label: 'Kinds of class (none ticked means any)', type: 'checks', options: opts([...CLASS_FORMATS, 'ride']) },
        { name: 'certificationExpires', label: 'Certificate expires', type: 'date' },
        { name: 'workDays', label: 'Working days (none ticked means any)', type: 'checks', options: DAYS },
        { name: 'workFrom', label: 'Starts work at', type: 'text', hint: '24-hour time such as 08:00.' }, { name: 'workTo', label: 'Finishes at', type: 'text' },
        { name: 'maxSessionsPerDay', label: 'Most sessions a day', type: 'number', min: 1 },
      ]}
      onSubmit={(v) => api('PUT', `/staff/${id}/profile`, {
        qualifications: textOrNull(v.qualifications), levels: v.levels, formats: v.formats, certificationExpires: textOrNull(v.certificationExpires),
        workDays: (v.workDays as string[]).map(Number), workFrom: textOrNull(v.workFrom), workTo: textOrNull(v.workTo), maxSessionsPerDay: numberOrNull(v.maxSessionsPerDay),
      })} />
  );
}
