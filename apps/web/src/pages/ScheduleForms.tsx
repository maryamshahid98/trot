import { api, ApiError, post } from '../api/client';
import { CLASS_FORMATS, LEVELS, OCCURRENCE_STATUS } from '../constants';
import { useBranch } from '../lib/branch';
import { useQuery, qs } from '../lib/useApi';
import { fmtDateTime, fromMinor, isoToLocalInput, toMinor, zonedToIso, money } from '../lib/format';
import type { ClassType, Occurrence, RideType } from '../lib/types';
import { FormDialog } from '../ui/FormDialog';
import type { FieldDef, Values } from '../ui/FormDialog';
import { useToast } from '../ui/kit';
import { opts, useArenas, useStaff } from '../ui/pickers';

const STATUS_OPTIONS = [{ value: OCCURRENCE_STATUS.PUBLISHED, label: 'Published (customers can book)' }, { value: OCCURRENCE_STATUS.DRAFT, label: 'Draft (staff only)' }];
const OVERRIDE: FieldDef = { name: 'overrideReason', label: 'Manager override reason', type: 'text', hint: 'Only to knowingly override a clash, a closure, staff leave, the arena’s size or levels, or opening hours. Managers and owners only.' };
const overrideOf = (v: Values) => (typeof v.overrideReason === 'string' && v.overrideReason.trim() ? { override: { reason: v.overrideReason.trim() } } : {});

const REPEAT_OPTIONS = [{ value: '1', label: 'Every week' }, { value: '2', label: 'Every 2 weeks' }, { value: '3', label: 'Every 3 weeks' }, { value: '4', label: 'Every 4 weeks' }];
const repeating = (v: Values) => typeof v.repeat === 'string' && v.repeat !== '';

interface SeriesProblem { date?: string; reasons?: { message?: string }[] }
interface SeriesResult { seriesId: string | null; created: unknown[]; skipped: { startsAt: string }[] }

/** A refused series answers with the dates that failed and why; turn that into one readable message. */
function seriesError(e: unknown): unknown {
  if (!(e instanceof ApiError) || e.problems.length === 0) return e;
  const lines = (e.problems as unknown as SeriesProblem[]).filter((p) => p.date).map((p) => `${fmtDateTime(p.date as string)}: ${(p.reasons ?? []).map((r) => r.message).filter(Boolean).join(', ') || 'clash'}`);
  return lines.length ? new ApiError(e.status, `${e.message} ${lines.join(' · ')}`, []) : e;
}

export function NewClassDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { branchId } = useBranch();
  const toast = useToast();
  const arenas = useArenas();
  const coaches = useStaff('coach');
  const catalogue = useQuery<{ classTypes: ClassType[] }>(branchId ? `/class-types${qs({ branchId })}` : null);
  const types = (catalogue.data?.classTypes ?? []).filter((t) => t.active);
  const fromList = (v: Values) => types.find((t) => t.id === v.classTypeId);
  const own = (v: Values) => !fromList(v);
  const fields: FieldDef[] = [
    { name: 'classTypeId', label: 'From the class catalogue', type: 'select', options: types.map((t) => ({ value: t.id, label: `${t.name} · ${t.durationMinutes} min · ${money(t.priceMinor)}` })), blank: 'Not from the catalogue', hint: 'A catalogue class fills in the title, type, level, length, places and price, and its age and cancellation rules.' },
    { name: 'title', label: 'Title', type: 'text', hint: 'Leave empty to use the catalogue name.' },
    { name: 'format', label: 'Class type', type: 'select', options: opts(CLASS_FORMATS), showIf: own },
    { name: 'arenaId', label: 'Arena', type: 'select', options: arenas.options, required: true },
    { name: 'coachId', label: 'Coach', type: 'select', options: coaches.options, required: true },
    { name: 'minLevel', label: 'Level', type: 'select', options: opts(LEVELS), showIf: own },
    { name: 'startsAt', label: 'Starts', type: 'datetime', required: true },
    { name: 'endsAt', label: 'Ends', type: 'datetime', hint: 'Leave empty to use the catalogue length.' },
    { name: 'capacity', label: 'Places', type: 'number', min: 1, hint: 'Leave empty to use the catalogue number.' },
    { name: 'price', label: 'Price (SAR, VAT included)', type: 'money', min: 0, hint: 'Leave empty to use the catalogue price.' },
    { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
    { name: 'repeat', label: 'Repeat', type: 'select', options: REPEAT_OPTIONS, blank: 'Does not repeat', hint: 'Every date is checked like a single class, at the same clock time.' },
    { name: 'repeatCount', label: 'Number of classes in the series', type: 'number', min: 2, max: 52, required: true, showIf: repeating, hint: 'Including the first one (2 to 52).' },
    { name: 'skipConflicts', label: 'Skip dates that clash, instead of refusing the whole series', type: 'checkbox', showIf: repeating },
    OVERRIDE,
  ];
  return (
    <FormDialog title="New class" fields={fields} initial={{ minLevel: LEVELS[0], status: OCCURRENCE_STATUS.PUBLISHED }} submit="Check and save" onClose={onClose} onDone={onDone}
      onSubmit={async (v) => {
        const t = fromList(v);
        const missing = [!v.title && !t ? 'title' : null, !v.format && !t ? 'class type' : null, !v.endsAt && !t ? 'end time' : null, !v.capacity && !t ? 'places' : null, !v.startsAt ? 'start time' : null].filter(Boolean);
        if (missing.length) throw new Error(`Please fill in: ${missing.join(', ')}.`);
        const startsAt = zonedToIso(String(v.startsAt));
        const one = {
          branchId, title: v.title || t!.name, arenaId: v.arenaId, coachId: v.coachId, format: t?.format ?? v.format, minLevel: t?.minLevel ?? (v.minLevel || LEVELS[0]), status: v.status || OCCURRENCE_STATUS.PUBLISHED,
          startsAt, endsAt: v.endsAt ? zonedToIso(String(v.endsAt)) : new Date(Date.parse(startsAt) + t!.durationMinutes * 60_000).toISOString(),
          capacity: v.capacity ? Number(v.capacity) : t!.capacity, priceMinor: v.price ? toMinor(String(v.price)) : (t?.priceMinor ?? 0), ...(t ? { classTypeId: t.id } : {}), ...overrideOf(v),
        };
        if (!repeating(v)) return post('/schedule', one);
        try {
          const r = await post<SeriesResult>('/schedule/series', { ...one, repeat: { everyWeeks: Number(v.repeat), count: Number(v.repeatCount) }, skipConflicts: v.skipConflicts === true });
          toast(r.skipped.length ? `${r.created.length} classes saved, ${r.skipped.length} skipped because they clash` : `${r.created.length} classes saved`);
        } catch (e) { throw seriesError(e); }
      }} />
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
    { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, hint: 'A ride that needs horses is saved as a draft. Open it, assign the horses, then publish.' },
    OVERRIDE,
  ];
  return (
    <FormDialog title="New ride" fields={fields} initial={{ status: OCCURRENCE_STATUS.DRAFT }} submit="Check and save" onClose={onClose} onDone={onDone}
      onSubmit={(v) => post('/rides', {
        branchId, rideTypeId: v.rideTypeId, arenaId: v.arenaId, coachId: v.coachId, startsAt: zonedToIso(String(v.startsAt)),
        ...(v.capacity ? { capacity: Number(v.capacity) } : {}), status: v.status || OCCURRENCE_STATUS.PUBLISHED, ...overrideOf(v),
      })} />
  );
}

/** Move, re-staff or edit a session that has not started. Only what changed is sent. */
export function EditSessionDialog({ occ, onClose, onDone }: { occ: Occurrence; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const arenas = useArenas();
  const coaches = useStaff('coach');
  const ride = occ.rideTypeId !== null;
  const initial: Record<string, string> = {
    title: occ.title, arenaId: occ.arenaId, coachId: occ.coachId, minLevel: occ.minLevel, startsAt: isoToLocalInput(occ.startsAt), endsAt: isoToLocalInput(occ.endsAt),
    capacity: String(occ.capacity), price: fromMinor(occ.priceMinor),
  };
  const fields: FieldDef[] = [
    ...(ride ? [] : [{ name: 'title', label: 'Title', type: 'text', required: true } as const]),
    { name: 'arenaId', label: ride ? 'Route or location' : 'Arena', type: 'select', options: arenas.options, required: true },
    { name: 'coachId', label: ride ? 'Guide' : 'Coach', type: 'select', options: coaches.options, required: true },
    ...(ride ? [] : [{ name: 'minLevel', label: 'Level', type: 'select', options: opts(LEVELS) } as const]),
    { name: 'startsAt', label: 'Starts', type: 'datetime', required: true, hint: ride ? 'The ride keeps its length.' : undefined },
    ...(ride ? [] : [{ name: 'endsAt', label: 'Ends', type: 'datetime', required: true } as const]),
    { name: 'capacity', label: 'Places', type: 'number', required: true, min: 1, hint: occ.booked ? `${occ.booked} booked. Booked riders are told about a new time, place or coach.` : undefined },
    ...(ride ? [] : [{ name: 'price', label: 'Price (SAR, VAT included)', type: 'money', min: 0 } as const]),
    OVERRIDE,
  ];
  return (
    <FormDialog title={ride ? 'Change this ride' : 'Change this class'} fields={fields} initial={initial} submit="Check and save" onClose={onClose} onDone={onDone}
      onSubmit={async (v) => {
        const body: Record<string, unknown> = {};
        const changed = (k: string) => v[k] !== undefined && v[k] !== initial[k];
        for (const k of ['title', 'arenaId', 'coachId', 'minLevel'] as const) if (changed(k)) body[k] = v[k];
        if (changed('startsAt')) body.startsAt = zonedToIso(String(v.startsAt));
        if (!ride && (changed('startsAt') || changed('endsAt'))) body.endsAt = zonedToIso(String(v.endsAt));
        if (changed('capacity')) body.capacity = Number(v.capacity);
        if (!ride && changed('price')) body.priceMinor = toMinor(String(v.price || 0));
        if (Object.keys(body).length === 0) throw new Error('Nothing has changed yet.');
        const r = await api<{ ridersTold: number; horsesFreed: number }>('PATCH', `/schedule/${occ.id}`, { ...body, ...overrideOf(v) });
        toast(`Saved.${r.ridersTold ? ` ${r.ridersTold} riders will be told.` : ''}${r.horsesFreed ? ' Assign the horses again.' : ''}`);
      }} />
  );
}

export function PublishDialog({ occ, onClose, onDone }: { occ: Occurrence; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  return (
    <FormDialog title={`Publish ${occ.title}`} fields={[OVERRIDE]} submit="Check and publish" onClose={onClose} onDone={onDone}
      onSubmit={async (v) => { await post(`/schedule/${occ.id}/publish`, overrideOf(v)); toast('Published. Riders can now be booked.'); }} />
  );
}
