export type When = string | number | Date | null | undefined;

/** The API sends times as ISO text or as milliseconds (sometimes as a numeric string). */
export function toDate(v: When): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' && /^\d{10,}$/.test(v)) return new Date(Number(v));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

let currentZone = 'Asia/Riyadh';
export const setZone = (z: string) => { currentZone = z; };
export const getZone = () => currentZone;

const fmt = (opts: Intl.DateTimeFormatOptions) => (v: When): string => {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat('en-GB', { timeZone: currentZone, ...opts }).format(d) : '';
};
export const fmtTime = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtDate = fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const fmtDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDateTime = (v: When): string => (toDate(v) ? `${fmtDate(v)}, ${fmtTime(v)}` : '');

/** 35000 -> "SAR 350.00". Amounts are held in halalas (minor units). */
export function money(minor: number | string | null | undefined, currency = 'SAR'): string {
  const n = Number(minor ?? 0);
  return `${currency} ${(n / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export const toMinor = (major: string | number): number => Math.round(Number(major) * 100);
export const fromMinor = (minor: number): string => (minor / 100).toFixed(2);
/** "1 place", "2 places". */
export const places = (n: number): string => `${n} ${n === 1 ? 'place' : 'places'}`;

export const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

/** 'pending_office_payment' -> 'Pending office payment' */
export const label = (s: string | null | undefined): string => {
  if (!s) return '';
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// ---------- club-time helpers: the club's day is in the branch's time zone, not the browser's ----------
function offsetMinutes(at: Date, zone: string): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - at.getTime()) / 60_000;
}
/** "2026-12-01T16:00" typed in the club's time zone -> an exact instant as ISO text with an offset. */
export function zonedToIso(local: string, zone = currentZone): string {
  const asUtc = new Date(`${local}:00Z`);
  const off = offsetMinutes(asUtc, zone);
  const at = new Date(asUtc.getTime() - off * 60_000);
  const off2 = offsetMinutes(at, zone);
  const real = new Date(asUtc.getTime() - off2 * 60_000);
  return real.toISOString();
}
/** The instant as the "YYYY-MM-DDTHH:mm" text a datetime-local box wants, in the club's time zone. */
export function isoToLocalInput(v: When, zone = currentZone): string {
  const d = toDate(v);
  if (!d) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
/** Today's date in the club's zone as YYYY-MM-DD. */
export const todayLocal = (): string => isoToLocalInput(new Date()).slice(0, 10);
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Start and end of a club day (or run of days) as ISO instants. */
export const dayStartIso = (day: string): string => zonedToIso(`${day}T00:00`);
export const dayEndIso = (day: string): string => zonedToIso(`${addDays(day, 1)}T00:00`);
/** Monday of the week that holds this day. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  return addDays(day, -wd);
}
