import { post } from '../api/client';
import { CLASS_FORMATS, LEVELS, OCCURRENCE_STATUS } from '../constants';
import { useBranch } from '../lib/branch';
import { useQuery, qs } from '../lib/useApi';
import { toMinor, zonedToIso, money } from '../lib/format';
import type { RideType } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import type { FieldDef, Values } from '../ui/FormDialog';
import { opts, useArenas, useStaff } from '../ui/pickers';

const STATUS_OPTIONS = [{ value: OCCURRENCE_STATUS.PUBLISHED, label: 'Published (customers can book)' }, { value: OCCURRENCE_STATUS.DRAFT, label: 'Draft (staff only)' }];
const OVERRIDE: FieldDef = { name: 'overrideReason', label: 'Manager override reason', type: 'text', hint: 'Only fill this in to knowingly override a clash with another class, a closure or staff leave. Managers and owners only.' };
const overrideOf = (v: Values) => (typeof v.overrideReason === 'string' && v.overrideReason.trim() ? { override: { reason: v.overrideReason.trim() } } : {});

export function NewClassDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { branchId } = useBranch();
  const arenas = useArenas();
  const coaches = useStaff('coach');
  const fields: FieldDef[] = [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'format', label: 'Class type', type: 'select', options: opts(CLASS_FORMATS), required: true },
    { name: 'arenaId', label: 'Arena', type: 'select', options: arenas.options, required: true },
    { name: 'coachId', label: 'Coach', type: 'select', options: coaches.options, required: true },
    { name: 'minLevel', label: 'Level', type: 'select', options: opts(LEVELS) },
    { name: 'startsAt', label: 'Starts', type: 'datetime', required: true },
    { name: 'endsAt', label: 'Ends', type: 'datetime', required: true },
    { name: 'capacity', label: 'Places', type: 'number', required: true, min: 1 },
    { name: 'price', label: 'Price (SAR, VAT included)', type: 'money', min: 0 },
    { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
    OVERRIDE,
  ];
  return (
    <FormDialog title="New class" fields={fields} initial={{ minLevel: LEVELS[0], status: OCCURRENCE_STATUS.PUBLISHED, price: '0' }} submit="Check and save" onClose={onClose} onDone={onDone}
      onSubmit={(v) => post('/schedule', {
        branchId, title: v.title, arenaId: v.arenaId, coachId: v.coachId, format: v.format, minLevel: v.minLevel || LEVELS[0], status: v.status || OCCURRENCE_STATUS.PUBLISHED,
        startsAt: zonedToIso(String(v.startsAt)), endsAt: zonedToIso(String(v.endsAt)), capacity: Number(v.capacity), priceMinor: toMinor(String(v.price || 0)), ...overrideOf(v),
      })} />
  );
}

export function NewRideDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { branchId } = useBranch();
  const types = useQuery<{ rideTypes: RideType[] }>(branchId ? `/ride-types${qs({ branchId, includeInactive: 'false' })}` : null);
  const arenas = useArenas();
  const coaches = useStaff('coach');
  const list = types.data?.rideTypes ?? [];
  const fields: FieldDef[] = [
    { name: 'rideTypeId', label: 'Ride type', type: 'select', required: true, options: list.map((t) => ({ value: t.id, label: `${t.name} · ${money(t.priceMinor)} · ${t.durationMinutes} min` })), hint: 'The price, length, level and minimum age come from the ride type and are copied onto the ride.' },
    { name: 'arenaId', label: 'Route or location', type: 'select', required: true, options: arenas.options },
    { name: 'coachId', label: 'Guide', type: 'select', required: true, options: coaches.options },
    { name: 'startsAt', label: 'Starts', type: 'datetime', required: true, hint: 'The end time is worked out from the ride type’s length.' },
    { name: 'capacity', label: 'Riders (optional)', type: 'number', min: 1, hint: 'Can be lowered, never raised above the ride type.' },
    { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
    OVERRIDE,
  ];
  return (
    <FormDialog title="New ride" fields={fields} initial={{ status: OCCURRENCE_STATUS.PUBLISHED }} submit="Check and save" onClose={onClose} onDone={onDone}
      onSubmit={(v) => post('/rides', {
        branchId, rideTypeId: v.rideTypeId, arenaId: v.arenaId, coachId: v.coachId, startsAt: zonedToIso(String(v.startsAt)),
        ...(v.capacity ? { capacity: Number(v.capacity) } : {}), status: v.status || OCCURRENCE_STATUS.PUBLISHED, ...overrideOf(v),
      })} />
  );
}
