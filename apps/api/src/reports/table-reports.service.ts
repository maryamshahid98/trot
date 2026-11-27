import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sessionHorses } from '../common/sql.ts';
import { z } from 'zod';
import type { AuthUser } from '../auth/decorators.ts';
import { branchFor } from '../common/branch.ts';
import { parse } from '../common/validate.ts';
import { ROLE } from '../config/constants.ts';
import { DbService } from '../db/db.service.ts';
import { uuid } from '../schedule/schedule.schemas.ts';

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date-time such as 2026-12-01T16:00:00+03:00');
const Query = z.object({ branchId: uuid.optional(), from: isoTime, to: isoTime });
/** money: minor units, shown as an amount. when: an instant, shown on the branch's clock. */
type Kind = 'text' | 'money' | 'when';
interface Report { title: string; columns: [string, Kind?][]; sql: string; managersOnly: boolean }

// Every query takes $1 = branch, $2 = from, $3 = to and selects its columns in the order listed.
const WINDOW = (col: string) => `${col} >= $2::timestamptz AND ${col} < $3::timestamptz`;
const REPORTS: Record<string, Report> = {
  daily: {
    title: 'Daily operations', managersOnly: false,
    columns: [['Start', 'when'], ['Session'], ['Arena'], ['Instructor'], ['Horses'], ['Riders'], ['Booked'], ['Checked in'], ['Status']],
    sql: `SELECT lower(o.during), o.title, a.name, c.full_name,
        coalesce(${sessionHorses('o.id')}, 'Not assigned'),
        coalesce((SELECT string_agg(r.full_name, ', ' ORDER BY r.full_name) FROM bookings b JOIN riders r ON r.id = b.rider_id WHERE b.occurrence_id = o.id AND b.status <> 'cancelled'), ''),
        (SELECT count(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status <> 'cancelled')::text || ' of ' || o.capacity,
        (SELECT count(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('checked_in', 'completed'))::int, o.status::text
      FROM occurrences o JOIN arenas a ON a.id = o.arena_id JOIN accounts c ON c.id = o.coach_id WHERE o.branch_id = $1 AND ${WINDOW('lower(o.during)')} ORDER BY 1`,
  },
  'class-occupancy': {
    title: 'Class occupancy', managersOnly: true,
    columns: [['Class'], ['Sessions'], ['Places'], ['Booked'], ['Waiting'], ['Attended'], ['Filled %']],
    sql: `SELECT o.title, count(*)::int, sum(o.capacity)::int, sum(x.booked)::int, sum(x.waiting)::int, sum(x.attended)::int, round(100.0 * sum(x.booked) / nullif(sum(o.capacity), 0))::int
      FROM occurrences o CROSS JOIN LATERAL (SELECT
        (SELECT count(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status <> 'cancelled') AS booked,
        (SELECT count(*) FROM waitlist_entries w WHERE w.occurrence_id = o.id AND w.status IN ('active', 'offered')) AS waiting,
        (SELECT count(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('checked_in', 'completed')) AS attended) x
      WHERE o.branch_id = $1 AND o.status <> 'cancelled' AND ${WINDOW('lower(o.during)')} GROUP BY o.title ORDER BY 1`,
  },
  instructors: {
    title: 'Instructor utilisation', managersOnly: true,
    columns: [['Instructor'], ['Sessions'], ['Teaching hours'], ['Attended'], ['Cancelled sessions']],
    sql: `SELECT c.full_name, count(*) FILTER (WHERE o.status <> 'cancelled')::int, round((coalesce(sum(extract(epoch FROM upper(o.during) - lower(o.during))) FILTER (WHERE o.status <> 'cancelled'), 0) / 3600)::numeric, 1)::text,
        coalesce(sum((SELECT count(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('checked_in', 'completed'))), 0)::int, count(*) FILTER (WHERE o.status = 'cancelled')::int
      FROM occurrences o JOIN accounts c ON c.id = o.coach_id WHERE o.branch_id = $1 AND ${WINDOW('lower(o.during)')} GROUP BY c.full_name ORDER BY 1`,
  },
  'horse-welfare': {
    title: 'Horse workload and welfare', managersOnly: true,
    columns: [['Horse'], ['Status'], ['Sessions'], ['Hours'], ['Busiest day'], ['Care due']],
    sql: `SELECT h.name, h.status::text, count(x.id)::int, round((coalesce(sum(extract(epoch FROM upper(x.during) - lower(x.during))), 0) / 3600)::numeric, 1)::text,
        coalesce((SELECT max(n) FROM (SELECT count(*) AS n FROM horse_assignments y WHERE y.horse_id = h.id AND ${WINDOW('lower(y.during)')} GROUP BY (lower(y.during) AT TIME ZONE br.time_zone)::date) d), 0)::int,
        coalesce((SELECT string_agg(kind || ' ' || to_char(due_on, 'YYYY-MM-DD'), ', ') FROM (SELECT DISTINCT ON (kind) kind, due_on FROM horse_care_events e WHERE e.horse_id = h.id ORDER BY kind, happened_on DESC, recorded_at DESC) z WHERE due_on < ($3::timestamptz)::date + 30), '')
      FROM horses h JOIN branches br ON br.id = h.branch_id LEFT JOIN horse_assignments x ON x.horse_id = h.id AND ${WINDOW('lower(x.during)')} WHERE h.branch_id = $1 GROUP BY h.id, br.time_zone ORDER BY 1`,
  },
  progression: {
    title: 'Rider attendance and progress', managersOnly: true,
    columns: [['Rider'], ['Level'], ['Attended'], ['No-shows'], ['Cancelled'], ['Assessments'], ['Level changes']],
    sql: `SELECT r.full_name, r.level::text, count(b.id) FILTER (WHERE b.status IN ('checked_in', 'completed'))::int, count(b.id) FILTER (WHERE b.status = 'no_show')::int, count(b.id) FILTER (WHERE b.status = 'cancelled')::int,
        (SELECT count(*) FROM assessments s WHERE s.rider_id = r.id AND ${WINDOW('s.created_at')})::int, (SELECT count(*) FROM rider_level_history h WHERE h.rider_id = r.id AND h.reason <> 'initial' AND ${WINDOW('h.changed_at')})::int
      FROM riders r LEFT JOIN (bookings b JOIN occurrences o ON o.id = b.occurrence_id) ON b.rider_id = r.id AND ${WINDOW('lower(o.during)')} WHERE r.branch_id = $1 AND r.anonymised_at IS NULL GROUP BY r.id ORDER BY 1`,
  },
  'package-liability': {
    title: 'Packages still owed to riders', managersOnly: true,
    columns: [['Rider'], ['Package'], ['Status'], ['Classes left'], ['Valid until'], ['Value left', 'money']],
    sql: `SELECT r.full_name, t.name, p.status, l.balance::int, to_char(p.valid_until, 'YYYY-MM-DD'), (t.price_minor::bigint * l.balance / t.classes)::int
      FROM rider_packages p JOIN riders r ON r.id = p.rider_id JOIN package_types t ON t.id = p.package_type_id
      CROSS JOIN LATERAL (SELECT coalesce(sum(delta), 0) AS balance FROM package_ledger WHERE rider_package_id = p.id) l
      WHERE r.branch_id = $1 AND p.status IN ('active', 'frozen') AND l.balance > 0 AND p.purchased_at < $3::timestamptz AND p.valid_until >= $2::timestamptz ORDER BY p.valid_until, 1`,
  },
  'walk-ins': {
    title: 'Walk-in and single visits', managersOnly: true,
    columns: [['Visit', 'when'], ['Rider'], ['Session'], ['Booking'], ['Source'], ['Status'], ['Paid', 'money']],
    sql: `SELECT lower(o.during), r.full_name, o.title, b.number, b.source, b.status::text, coalesce((SELECT sum(x.amount_minor) FROM receipts x WHERE x.for_booking_id = b.id), 0)::int
      FROM bookings b JOIN riders r ON r.id = b.rider_id JOIN occurrences o ON o.id = b.occurrence_id WHERE b.branch_id = $1 AND (b.source = 'walk_in' OR o.single_visit) AND ${WINDOW('lower(o.during)')} ORDER BY 1`,
  },
  receivables: {
    title: 'Sales and money still owed', managersOnly: true,
    columns: [['Issued', 'when'], ['Invoice'], ['Rider'], ['For'], ['Status'], ['Total', 'money'], ['VAT', 'money'], ['Owed', 'money']],
    sql: `SELECT i.issued_at, i.number, r.full_name, coalesce((SELECT description FROM invoice_lines WHERE invoice_id = i.id LIMIT 1), ''), i.status, i.gross_minor, i.vat_minor, CASE WHEN i.status = 'issued' THEN i.gross_minor ELSE 0 END
      FROM invoices i JOIN riders r ON r.id = i.rider_id WHERE i.branch_id = $1 AND ${WINDOW('i.issued_at')} ORDER BY 1`,
  },
  reconciliation: {
    title: 'Money reconciliation', managersOnly: true,
    columns: [['Measure'], ['Count'], ['Amount', 'money']],
    sql: `SELECT 'Invoices issued (not voided)', count(*)::int, coalesce(sum(gross_minor), 0)::int FROM invoices WHERE branch_id = $1 AND status <> 'voided' AND ${WINDOW('issued_at')}
      UNION ALL SELECT 'Invoices still unpaid', count(*)::int, coalesce(sum(gross_minor), 0)::int FROM invoices WHERE branch_id = $1 AND status = 'issued' AND ${WINDOW('issued_at')}
      UNION ALL SELECT 'Receipts', count(*)::int, coalesce(sum(amount_minor), 0)::int FROM receipts WHERE branch_id = $1 AND ${WINDOW('issued_at')}
      UNION ALL SELECT 'Refunds', count(*)::int, coalesce(sum(amount_minor), 0)::int FROM financial_adjustments WHERE branch_id = $1 AND kind = 'refund' AND ${WINDOW('created_at')}
      UNION ALL SELECT 'Credit notes', count(*)::int, coalesce(sum(amount_minor), 0)::int FROM credit_notes WHERE branch_id = $1 AND ${WINDOW('issued_at')}
      UNION ALL SELECT 'Bookings made', count(*)::int, NULL FROM bookings WHERE branch_id = $1 AND ${WINDOW('created_at')}
      UNION ALL SELECT 'Package classes sold or used (net)', count(*)::int, NULL FROM package_ledger l JOIN rider_packages p ON p.id = l.rider_package_id JOIN riders r ON r.id = p.rider_id WHERE r.branch_id = $1 AND ${WINDOW('l.at')}`,
  },
  incidents: {
    title: 'Incident register', managersOnly: true,
    columns: [['When', 'when'], ['Number'], ['Severity'], ['Kind'], ['Status'], ['Horse'], ['Rider'], ['Open actions']],
    sql: `SELECT i.occurred_at, i.number, i.severity, i.kind, i.status, coalesce(h.name, ''), coalesce(r.full_name, ''), (SELECT count(*) FROM incident_actions a WHERE a.incident_id = i.id AND a.done_at IS NULL)::int
      FROM incidents i LEFT JOIN horses h ON h.id = i.horse_id LEFT JOIN riders r ON r.id = i.rider_id WHERE i.branch_id = $1 AND ${WINDOW('i.occurred_at')} ORDER BY 1`,
  },
};

/** The club's list reports (BRD 10.1): one shape for all of them, so each can be shown and exported the same way. */
@Injectable()
export class TableReportsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async run(name: string, query: unknown, user: AuthUser) {
    const report = Object.hasOwn(REPORTS, name) ? REPORTS[name] : undefined;
    const managers = user.role === ROLE.MANAGER || user.role === ROLE.OWNER;
    if (!report || (report.managersOnly && !managers)) throw new NotFoundException('Report not found.');
    const q = parse(Query, query);
    if (Date.parse(q.to) <= Date.parse(q.from) || Date.parse(q.to) - Date.parse(q.from) > 367 * 86_400_000) throw new BadRequestException('Choose a period of up to one year.');
    const branchId = branchFor(q.branchId, user);
    return this.db.scoped({ branchIds: [branchId], role: user.role }, async (c) => {
      const r = await c.query({ text: `SELECT * FROM (${report.sql}) AS x LIMIT 2000`, values: [branchId, q.from, q.to], rowMode: 'array' });
      return { title: report.title, columns: report.columns.map(([head, kind]) => ({ head, kind: kind ?? 'text' })), rows: r.rows };
    });
  }
}
