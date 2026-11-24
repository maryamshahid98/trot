import { useState } from 'react';
import { addDays, dayEndIso, dayStartIso, fmtDate, fmtTime, label, money, todayLocal } from '../lib/format';
import { useBranch } from '../lib/branch';
import { qs, useQuery } from '../lib/useApi';
import type { Occurrence } from '../lib/types';
import { Badge, Btn, Card, Load, PageHead, Table } from '../ui/kit';
import { ClassDialog } from './ClassDialog';

/** The day sheet: pick a day, open a class or ride, and handle its riders, payments and check-in. */
export function Bookings() {
  const { branchId, branch } = useBranch();
  const [day, setDay] = useState(todayLocal());
  const [open, setOpen] = useState<Occurrence | null>(null);
  const q = useQuery<Occurrence[]>(branchId ? `/schedule${qs({ branchId, from: dayStartIso(day), to: dayEndIso(day) })}` : null);
  return (
    <>
      <PageHead title="Bookings" sub={`${branch?.name ?? ''} · ${fmtDate(dayStartIso(day))}`} actions={
        <>
          <Btn onClick={() => setDay(addDays(day, -1))}>‹ Day</Btn>
          <input className="chip" type="date" aria-label="Day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <Btn onClick={() => setDay(todayLocal())}>Today</Btn>
          <Btn onClick={() => setDay(addDays(day, 1))}>Day ›</Btn>
        </>
      } />
      <div className="page">
        <Card title="Open a class or ride to see its riders" flex>
          <Load q={q}>{(list) => (
            <Table rowKey={(o) => o.id} rows={[...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt))} empty="Nothing is scheduled this day." onRow={setOpen} cols={[
              { head: 'Time', cell: (o) => `${fmtTime(o.startsAt)}–${fmtTime(o.endsAt)}`, width: '0.9fr' }, { head: 'Class or ride', cell: (o) => <b>{o.title}</b>, width: '1.6fr' },
              { head: 'Where', cell: (o) => o.arenaName }, { head: 'Coach', cell: (o) => o.coachName }, { head: 'Price', cell: (o) => money(o.priceMinor), width: '0.8fr' },
              { head: 'Places', cell: (o) => o.capacity, width: '0.6fr' }, { head: 'Level', cell: (o) => label(o.minLevel), width: '0.8fr' }, { head: 'Status', cell: (o) => <Badge value={o.status} />, width: '0.9fr' },
            ]} />
          )}</Load>
        </Card>
      </div>
      {open && <ClassDialog occ={open} onClose={() => setOpen(null)} onChanged={q.reload} />}
    </>
  );
}
