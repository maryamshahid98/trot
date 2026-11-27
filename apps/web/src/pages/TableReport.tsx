import { useBranch } from '../lib/branch';
import { downloadCsv } from '../lib/csv';
import { fmtDateTime, label, money } from '../lib/format';
import { qs, useQuery } from '../lib/useApi';
import { Btn, Card, Load, Table } from '../ui/kit';

export const LIST_REPORTS = [
  ['daily', 'Daily operations'], ['class-occupancy', 'Class occupancy'], ['instructors', 'Instructors'], ['horse-welfare', 'Horse welfare'], ['progression', 'Rider progress'],
  ['package-liability', 'Package liability'], ['walk-ins', 'Walk-ins'], ['receivables', 'Sales and owed'], ['reconciliation', 'Reconciliation'], ['incidents', 'Incidents'],
] as const;

interface Data { title: string; columns: { head: string; kind: 'text' | 'money' | 'when' }[]; rows: (string | number | null)[][] }

/** One list report, as the server describes it: shown as a table and saved as a spreadsheet. */
export function TableReport({ name, from, to }: { name: string; from: string; to: string }) {
  const { branchId, currency } = useBranch();
  const q = useQuery<Data>(branchId ? `/reports/table/${name}${qs({ branchId, from, to })}` : null);
  const show = (v: string | number | null, kind: string, asFile = false) => {
    if (v === null) return '';
    if (kind === 'money') return asFile ? (Number(v) / 100).toFixed(2) : money(v, currency);
    if (kind === 'when') return fmtDateTime(v);
    return typeof v === 'string' && /^[a-z]+(_[a-z]+)+$/.test(v) ? label(v) : v;
  };
  return (
    <Load q={q}>{(d) => (
      <Card title={d.title} actions={<Btn small onClick={() => downloadCsv(`${name}.csv`, [d.columns.map((c) => c.head), ...d.rows.map((r) => r.map((v, i) => show(v, d.columns[i].kind, true)))])}>Export to Excel (CSV)</Btn>}>
        <Table rowKey={(r) => r.key} rows={d.rows.map((cells, i) => ({ key: String(i), cells }))} empty="Nothing in this period."
          cols={d.columns.map((c, i) => ({ head: c.head, cell: (r: { cells: (string | number | null)[] }) => show(r.cells[i], c.kind) }))} />
      </Card>
    )}</Load>
  );
}
