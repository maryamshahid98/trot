import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { FRONT_DESK } from '../constants';
import type { Role } from '../constants';
import { addDays, dayEndIso, dayStartIso, fmtDay, fmtTime, label, places, todayLocal, weekStart } from '../lib/format';
import { useBranch } from '../lib/branch';
import { qs, useQuery } from '../lib/useApi';
import type { Occurrence } from '../lib/types';
import { Btn, Load, PageHead } from '../ui/kit';
import { ClassDialog } from './ClassDialog';
import { NewClassDialog, NewRideDialog } from './ScheduleForms';

export function Calendar() {
  const { user } = useAuth();
  const { branchId, branch } = useBranch();
  const [start, setStart] = useState(() => weekStart(todayLocal()));
  const [kind, setKind] = useState<'' | 'class' | 'ride'>('');
  const [open, setOpen] = useState<Occurrence | null>(null);
  const [form, setForm] = useState<'class' | 'ride' | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const q = useQuery<Occurrence[]>(branchId ? `/schedule${qs({ branchId, from: dayStartIso(start), to: dayEndIso(addDays(start, 6)), kind })}` : null);
  const front = FRONT_DESK.includes(user!.role as Role);
  const today = todayLocal();
  const byDay = (d: string) => (q.data ?? []).filter((o) => dayStartIso(d) <= new Date(o.startsAt).toISOString() && new Date(o.startsAt).toISOString() < dayEndIso(d)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return (
    <>
      <PageHead title="Calendar" sub={`${branch?.name ?? ''} · week of ${fmtDay(dayStartIso(start))}`} actions={
        <>
          <Btn onClick={() => setStart(addDays(start, -7))}>‹ Week</Btn>
          <Btn onClick={() => setStart(weekStart(todayLocal()))}>Today</Btn>
          <Btn onClick={() => setStart(addDays(start, 7))}>Week ›</Btn>
          <select className="chip" aria-label="Show" value={kind} onChange={(e) => setKind(e.target.value as '' | 'class' | 'ride')}><option value="">Classes and rides</option><option value="class">Classes only</option><option value="ride">Rides only</option></select>
          {front && <Btn kind="primary" onClick={() => setForm('class')}>New class</Btn>}
          {front && <Btn kind="primary" onClick={() => setForm('ride')}>New ride</Btn>}
        </>
      } />
      <div className="page">
        <Load q={q}>{() => (
          <div className="week">
            {days.map((d) => (
              <div key={d} className={`day${d === today ? ' today' : ''}`}>
                <div className="day-h">{fmtDay(dayStartIso(d))}</div>
                {byDay(d).map((o) => (
                  <button key={o.id} className={`ev${o.rideTypeId ? ' ride' : ''} ${o.status}`} onClick={() => setOpen(o)}>
                    <b>{fmtTime(o.startsAt)} {o.title}{o.seriesId ? <span className="repeat-mark" role="img" aria-label="repeats" title="Part of a repeating series"> ↻</span> : null}</b>
                    <span>{o.arenaName} · {o.coachName}</span>
                    <span>{label(o.status)} · {Math.max(0, o.capacity - o.booked)} of {places(o.capacity)} free</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}</Load>
      </div>
      {open && <ClassDialog occ={open} onClose={() => setOpen(null)} onChanged={q.reload} />}
      {form === 'class' && <NewClassDialog onClose={() => setForm(null)} onDone={() => { setForm(null); q.reload(); }} />}
      {form === 'ride' && <NewRideDialog onClose={() => setForm(null)} onDone={() => { setForm(null); q.reload(); }} />}
    </>
  );
}
