// Repeating a class every week (or every 2, 3 or 4 weeks) at the SAME CLOCK TIME in the branch's time zone.
// "Every Thursday at 09:00" must stay 09:00 on the wall clock even when the clocks change, so the dates are worked out
// on the branch's local calendar and only then turned back into instants. Pure code: no database, no framework.

export interface Slot {
  /** Milliseconds since 1970 (UTC), like every time in the rules code. */
  startsAt: number;
  endsAt: number;
}

export interface WeeklyRepeat {
  /** 1 = every week, 2 = every other week, and so on. */
  everyWeeks: number;
  /** Total number of sessions, including the first. Give this or `untilDate`, not both. */
  count?: number;
  /** The last day (YYYY-MM-DD, branch calendar) a session may start on. Give this or `count`, not both. */
  untilDate?: string;
}

export const MAX_SERIES_SESSIONS = 52;

export class RecurrenceError extends Error {}

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(ms: number, timeZone: string): Parts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((x) => x.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** How far the zone's clock is ahead of UTC at this instant, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the clock in this zone shows the given date and time. */
function localToInstant(p: Parts, timeZone: string): number {
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // The offset depends on the instant we are looking for, so settle on it in two steps (this also copes with the hour the clocks change).
  const first = asIfUtc - offsetAt(asIfUtc, timeZone);
  return asIfUtc - offsetAt(first, timeZone);
}

/** YYYY-MM-DD of an instant on the branch's calendar. */
export function localDateOf(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The sessions of a weekly series, the first one included, each at the same clock time as the first.
 * Every session keeps the length of the first. Throws RecurrenceError for a request that makes no sense.
 */
export function weeklySlots(first: Slot, repeat: WeeklyRepeat, timeZone: string): Slot[] {
  if (!Number.isInteger(repeat.everyWeeks) || repeat.everyWeeks < 1 || repeat.everyWeeks > 4) throw new RecurrenceError('everyWeeks must be 1, 2, 3 or 4.');
  const hasCount = repeat.count !== undefined;
  const hasUntil = repeat.untilDate !== undefined;
  if (hasCount === hasUntil) throw new RecurrenceError('Give either a number of sessions or a last date, not both and not neither.');
  if (hasCount && (!Number.isInteger(repeat.count) || (repeat.count as number) < 2 || (repeat.count as number) > MAX_SERIES_SESSIONS)) {
    throw new RecurrenceError(`A series has between 2 and ${MAX_SERIES_SESSIONS} sessions.`);
  }
  if (!(first.endsAt > first.startsAt)) throw new RecurrenceError('The session must end after it starts.');
  if (hasUntil && !/^\d{4}-\d{2}-\d{2}$/.test(repeat.untilDate as string)) throw new RecurrenceError('The last date must look like 2026-12-31.');

  const start = localParts(first.startsAt, timeZone);
  const length = first.endsAt - first.startsAt;
  const slots: Slot[] = [];
  for (let k = 0; ; k++) {
    // Move along the calendar by whole weeks (Date.UTC rolls the month over correctly), then read the clock time back in.
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + k * repeat.everyWeeks * 7));
    const day: Parts = { ...start, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const startsAt = localToInstant(day, timeZone);
    if (hasUntil && localDateOf(startsAt, timeZone) > (repeat.untilDate as string)) break;
    slots.push({ startsAt, endsAt: startsAt + length });
    if (hasCount && slots.length >= (repeat.count as number)) break;
    if (slots.length > MAX_SERIES_SESSIONS) throw new RecurrenceError(`That makes more than ${MAX_SERIES_SESSIONS} sessions. Choose an earlier last date.`);
  }
  if (slots.length < 2) throw new RecurrenceError('The last date is too early: a series needs at least 2 sessions.');
  return slots;
}
