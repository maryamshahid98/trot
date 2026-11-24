import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { MANAGER_ROLES } from '../constants';
import type { Role } from '../constants';
import { useBranch } from '../lib/branch';
import { dayEndIso, dayStartIso, fmtTime, label, money, pct, todayLocal } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import type { Occurrence } from '../lib/types';
import { Badge, Card, Load, PageHead, Row, Stat, Table } from '../ui/kit';
import { ClassDialog } from './ClassDialog';

interface Revenue { receipts: number; grossMinor: number; netMinor: number }
interface Util { classes: number; places: number; filled: number; utilisation: number | null }
interface Unpaid { unpaid: unknown[]; owedMinor: number }

export function Dashboard() {
  const { user } = useAuth();
  const { branchId, branch, currency } = useBranch();
  const [open, setOpen] = useState<Occurrence | null>(null);
  const day = todayLocal();
  const range = { branchId, from: dayStartIso(day), to: dayEndIso(day) };
  const manager = MANAGER_ROLES.includes(user!.role as Role);
  const today = useQuery<Occurrence[]>(branchId ? `/schedule${qs(range)}` : null);
  const rev = useQuery<Revenue>(branchId && manager ? `/reports/revenue${qs(range)}` : null);
  const util = useQuery<Util>(branchId && manager ? `/reports/utilisation${qs(range)}` : null);
  const unpaid = useQuery<Unpaid>(branchId && manager ? `/reports/unpaid${qs({ branchId })}` : null);
  const live = (today.data ?? []).filter((o) => o.status !== 'cancelled');

  return (
    <>
      <PageHead title="Dashboard" sub={`${branch?.name ?? ''} · today`} />
      <div className="page">
        {manager && (
          <Row>
            <Stat label="Taken today" value={rev.data ? money(rev.data.netMinor, currency) : '—'} sub={rev.data ? `${rev.data.receipts} receipts` : undefined} hot />
            <Stat label="Places filled" value={util.data ? pct(util.data.utilisation) : '—'} sub={util.data ? `${util.data.filled} of ${util.data.places} places` : undefined} />
            <Stat label="Classes and rides" value={String(live.length)} sub="not cancelled" />
            <Stat label="Owed by riders" value={unpaid.data ? money(unpaid.data.owedMinor, currency) : '—'} sub={unpaid.data ? `${unpaid.data.unpaid.length} unpaid bookings` : undefined} />
          </Row>
        )}
        <Card title="Today" flex>
          <Load q={today}>{(list) => (
            <Table rowKey={(o) => o.id} rows={[...list].sort((a, b) => a.startsAt.localeCompare(b.startsAt))} empty="Nothing is scheduled today." onRow={setOpen} cols={[
              { head: 'Time', cell: (o) => `${fmtTime(o.startsAt)}–${fmtTime(o.endsAt)}`, width: '0.9fr' },
              { head: 'Class or ride', cell: (o) => <b>{o.title}</b>, width: '1.6fr' },
              { head: 'Type', cell: (o) => label(o.format), width: '0.9fr' },
              { head: 'Where', cell: (o) => o.arenaName }, { head: 'Coach', cell: (o) => o.coachName },
              { head: 'Places', cell: (o) => o.capacity, width: '0.6fr' }, { head: 'Status', cell: (o) => <Badge value={o.status} />, width: '0.9fr' },
            ]} />
          )}</Load>
        </Card>
      </div>
      {open && <ClassDialog occ={open} onClose={() => setOpen(null)} onChanged={today.reload} />}
    </>
  );
}
