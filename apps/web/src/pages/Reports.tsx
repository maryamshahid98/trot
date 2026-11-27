import { useState } from 'react';
import { useBranch } from '../lib/branch';
import { addDays, dayEndIso, dayStartIso, fmtDate, label, money, pct, todayLocal } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import { downloadCsv } from '../lib/csv';
import { LIST_REPORTS, TableReport } from './TableReport';
import { Btn, Card, Load, PageHead, Row, Stat, Table, Tabs } from '../ui/kit';

interface Revenue { receipts: number; grossMinor: number; vatMinor: number; refundsMinor: number; netMinor: number; byMethod: { method: string; amountMinor: number; receipts?: number }[]; byDay: { day: string; amountMinor: number }[] }
interface Attendance { classes: number; attended: number; noShows: number; cancelled: number; attendanceRate: number | null; perCoach: { coachId: string; coachName: string; classes: number; attended: number; noShows: number }[] }
interface Util { classes: number; places: number; filled: number; utilisation: number | null; byArena: { arenaId: string; arenaName: string; classes: number; places: number; filled: number; utilisation: number | null }[] }
interface Rides { rides: number; cancelledRides: number; places: number; booked: number; noShows: number; utilisation: number | null; netMinor: number; byType: { name: string; rides: number; places: number; booked: number; noShows: number; utilisation: number | null; netMinor: number }[] }

export function Reports() {
  const { branchId, branch, currency } = useBranch();
  const [tab, setTab] = useState<string>('revenue');
  const [from, setFrom] = useState(addDays(todayLocal(), -29));
  const [to, setTo] = useState(todayLocal());
  const ok = branchId && from && to && from <= to;
  const range = ok ? qs({ branchId, from: dayStartIso(from), to: dayEndIso(to) }) : null;
  const rev = useQuery<Revenue>(range && tab === 'revenue' ? `/reports/revenue${range}` : null);
  const att = useQuery<Attendance>(range && tab === 'attendance' ? `/reports/attendance${range}` : null);
  const util = useQuery<Util>(range && tab === 'utilisation' ? `/reports/utilisation${range}` : null);
  const rides = useQuery<Rides>(range && tab === 'rides' ? `/reports/rides${range}` : null);
  const m = (n: number) => money(n, currency);
  const major = (n: number) => (n / 100).toFixed(2);
  /** The tables on screen as rows, headings first, for the export. */
  const sheet = (): (string | number)[][] => {
    if (tab === 'revenue' && rev.data) {
      const d = rev.data;
      return [['Taken', 'Refunds', 'Net', 'VAT included', 'Receipts'], [major(d.grossMinor), major(d.refundsMinor), major(d.netMinor), major(d.vatMinor), d.receipts], [], ['Method', 'Amount'], ...d.byMethod.map((r) => [label(r.method), major(r.amountMinor)]), [], ['Day', 'Amount'], ...d.byDay.map((r) => [r.day, major(r.amountMinor)])];
    }
    if (tab === 'attendance' && att.data) return [['Coach', 'Classes', 'Came', 'No-shows'], ...att.data.perCoach.map((r) => [r.coachName, r.classes, r.attended, r.noShows])];
    if (tab === 'utilisation' && util.data) return [['Arena', 'Classes', 'Places', 'Filled', 'Rate'], ...util.data.byArena.map((r) => [r.arenaName, r.classes, r.places, r.filled, pct(r.utilisation)])];
    if (tab === 'rides' && rides.data) return [['Ride', 'Rides', 'Places', 'Booked', 'Rate', 'No-shows', 'Net'], ...rides.data.byType.map((r) => [r.name, r.rides, r.places, r.booked, pct(r.utilisation), r.noShows, major(r.netMinor)])];
    return [];
  };
  return (
    <>
      <PageHead title="Reports" sub={`${branch?.name ?? ''} · ${fmtDate(dayStartIso(from))} to ${fmtDate(dayStartIso(to))}`} actions={<>
        {['revenue', 'attendance', 'utilisation', 'rides'].includes(tab) && <Btn onClick={() => downloadCsv(`${tab}-${from}-to-${to}.csv`, sheet())}>Export to Excel (CSV)</Btn>}
        <Btn onClick={() => window.print()}>Print or save as PDF</Btn>
        <input className="chip" type="date" aria-label="From" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <input className="chip" type="date" aria-label="To" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
      </>} />
      <div className="page print-area">
        <Tabs tabs={[{ id: 'revenue', label: 'Revenue' }, { id: 'attendance', label: 'Attendance' }, { id: 'utilisation', label: 'Places filled' }, { id: 'rides', label: 'Rides' }, ...LIST_REPORTS.map(([id, name]) => ({ id: id as string, label: name as string }))]} value={tab} onChange={setTab} />
        {ok && LIST_REPORTS.some(([id]) => id === tab) && <TableReport name={tab} from={dayStartIso(from)} to={dayEndIso(to)} />}
        {tab === 'revenue' && <Load q={rev}>{(d) => <>
          <Row><Stat label="Taken" value={m(d.grossMinor)} sub={`${d.receipts} receipts`} hot /><Stat label="Refunds" value={m(d.refundsMinor)} /><Stat label="Net" value={m(d.netMinor)} /><Stat label="VAT included" value={m(d.vatMinor)} /></Row>
          <Card title="By payment method"><Table rowKey={(r) => r.method} rows={d.byMethod} empty="Nothing taken." cols={[{ head: 'Method', cell: (r) => label(r.method) }, { head: 'Amount', cell: (r) => m(r.amountMinor) }]} /></Card>
          <Card title="By day"><Table rowKey={(r) => r.day} rows={d.byDay} empty="Nothing taken." cols={[{ head: 'Day', cell: (r) => r.day }, { head: 'Amount', cell: (r) => m(r.amountMinor) }]} /></Card>
        </>}</Load>}
        {tab === 'attendance' && <Load q={att}>{(d) => <>
          <Row><Stat label="Classes finished" value={String(d.classes)} /><Stat label="Came" value={String(d.attended)} /><Stat label="No-shows" value={String(d.noShows)} /><Stat label="Attendance" value={pct(d.attendanceRate)} hot /></Row>
          <Card title="By coach"><Table rowKey={(r) => r.coachId} rows={d.perCoach} empty="No finished classes." cols={[{ head: 'Coach', cell: (r) => <b>{r.coachName}</b> }, { head: 'Classes', cell: (r) => r.classes }, { head: 'Came', cell: (r) => r.attended }, { head: 'No-shows', cell: (r) => r.noShows }]} /></Card>
        </>}</Load>}
        {tab === 'utilisation' && <Load q={util}>{(d) => <>
          <Row><Stat label="Classes and rides" value={String(d.classes)} /><Stat label="Places" value={String(d.places)} /><Stat label="Filled" value={String(d.filled)} /><Stat label="Places filled" value={pct(d.utilisation)} hot /></Row>
          <Card title="By arena"><Table rowKey={(r) => r.arenaId} rows={d.byArena} empty="Nothing scheduled." cols={[{ head: 'Arena', cell: (r) => <b>{r.arenaName}</b> }, { head: 'Classes', cell: (r) => r.classes }, { head: 'Places', cell: (r) => r.places }, { head: 'Filled', cell: (r) => r.filled }, { head: 'Rate', cell: (r) => pct(r.utilisation) }]} /></Card>
        </>}</Load>}
        {tab === 'rides' && <Load q={rides}>{(d) => <>
          <Row><Stat label="Rides" value={String(d.rides)} sub={`${d.cancelledRides} cancelled`} /><Stat label="Booked" value={String(d.booked)} sub={`of ${d.places} places`} /><Stat label="No-shows" value={String(d.noShows)} /><Stat label="Net takings" value={m(d.netMinor)} hot /></Row>
          <Card title="By ride type"><Table rowKey={(r) => r.name} rows={d.byType} empty="No rides." cols={[{ head: 'Ride', cell: (r) => <b>{r.name}</b> }, { head: 'Rides', cell: (r) => r.rides }, { head: 'Booked', cell: (r) => r.booked }, { head: 'Rate', cell: (r) => pct(r.utilisation) }, { head: 'No-shows', cell: (r) => r.noShows }, { head: 'Net', cell: (r) => m(r.netMinor) }]} /></Card>
        </>}</Load>}
      </div>
    </>
  );
}
