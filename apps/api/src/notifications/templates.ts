// The words of every message, in one place. A new language is added by filling in another entry of each template; the rest of the
// system does not change. Arabic is not translated yet (the club has to decide who approves translations, BRD open decision OD-09),
// so an Arabic-speaking recipient gets the English text until then.
//
// Messages never contain medical details, only what a person needs to act on (BRD 11.1).

export type NotifyEvent =
  | 'booking.confirmed'
  | 'booking.pending_payment'
  | 'payment.received'
  | 'payment.refunded'
  | 'booking.cancelled'
  | 'class.cancelled'
  | 'waitlist.offered'
  | 'class.reminder'
  | 'package.low_balance'
  | 'package.expiring'
  | 'document.expiring'
  | 'incident.escalated'
  | 'assessment.decided';

/**
 * essential: a person must hear it whatever their preferences (confirmations, receipts, cancellations, offers): BRD COM-002.
 * reminder: sent only on the channels the person has switched on.
 */
export const EVENT_KIND: Record<NotifyEvent, 'essential' | 'reminder'> = {
  'booking.confirmed': 'essential',
  'booking.pending_payment': 'essential',
  'payment.received': 'essential',
  'payment.refunded': 'essential',
  'booking.cancelled': 'essential',
  'class.cancelled': 'essential',
  'waitlist.offered': 'essential',
  'class.reminder': 'reminder',
  'package.low_balance': 'reminder',
  'package.expiring': 'reminder',
  'document.expiring': 'reminder',
  'incident.escalated': 'essential',
  'assessment.decided': 'essential',
};

export type Locale = 'en' | 'ar';
export type NotifyData = Record<string, string | number | boolean | null | undefined>;
export interface RenderContext { locale: Locale; timeZone: string; currency: string }
export interface Rendered { subject: string; body: string }

const text = (v: unknown, fallback = ''): string => (v === null || v === undefined || v === '' ? fallback : String(v));

/** "Thu 26 Nov, 09:00" on the branch's own clock. */
export function when(iso: unknown, ctx: RenderContext): string {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(ctx.locale === 'ar' ? 'ar-SA' : 'en-GB', { timeZone: ctx.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
export function day(iso: unknown, ctx: RenderContext): string {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(ctx.locale === 'ar' ? 'ar-SA' : 'en-GB', { timeZone: ctx.timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}
export function money(minor: unknown, ctx: RenderContext): string {
  return `${ctx.currency} ${(Number(minor) / 100).toFixed(2)}`;
}

type Template = (d: NotifyData, ctx: RenderContext) => Rendered;

const EN: Record<NotifyEvent, Template> = {
  'booking.confirmed': (d, c) => ({
    subject: `Booking confirmed: ${text(d.title)}`,
    body: `Hello,\n\n${text(d.riderName, 'Your rider')} is booked for ${text(d.title)} on ${when(d.startsAt, c)}.\n\nSee you there.`,
  }),
  'booking.pending_payment': (d, c) => ({
    subject: `Place held: ${text(d.title)}`,
    body: `Hello,\n\nWe are holding a place for ${text(d.riderName, 'your rider')} in ${text(d.title)} on ${when(d.startsAt, c)}.\n\nPlease pay ${money(d.amountMinor, c)} at the club office within ${text(d.holdMinutes)} minutes to keep it. After that the place is released.`,
  }),
  'payment.received': (d, c) => ({
    subject: `Receipt ${text(d.receiptNumber)}`,
    body: `Hello,\n\nThank you. We received ${money(d.amountMinor, c)} for ${text(d.riderName, 'your rider')}: ${text(d.title)} on ${when(d.startsAt, c)}.\n\nReceipt number: ${text(d.receiptNumber)}. The booking is confirmed.`,
  }),
  'payment.refunded': (d, c) => ({
    subject: `Refund processed: ${money(d.amountMinor, c)}`,
    body: `Hello,\n\nWe have refunded ${money(d.amountMinor, c)} to ${text(d.riderName, 'your account')}${d.reason ? ` (${text(d.reason)})` : ''}.\n\nIt may take a few days to show with your bank if it was paid by card.`,
  }),
  'booking.cancelled': (d, c) => ({
    subject: `Booking cancelled: ${text(d.title)}`,
    body: `Hello,\n\nThe booking for ${text(d.riderName, 'your rider')} in ${text(d.title)} on ${when(d.startsAt, c)} has been cancelled${d.byClub ? ' by the club' : ''}.${d.byClub ? '\n\nYou have not been charged, and any package class has been returned.' : ''}`,
  }),
  'class.cancelled': (d, c) => ({
    subject: `Class cancelled: ${text(d.title)}`,
    body: `Hello,\n\nWe are sorry: ${text(d.title)} on ${when(d.startsAt, c)} has been cancelled${d.reason ? ` (${text(d.reason)})` : ''}.\n\nYou have not been charged for it, and any package class has been returned to ${text(d.riderName, 'your rider')}.`,
  }),
  'waitlist.offered': (d, c) => ({
    subject: `A place is free: ${text(d.title)}`,
    body: `Good news,\n\nA place has opened in ${text(d.title)} on ${when(d.startsAt, c)} for ${text(d.riderName, 'your rider')}.\n\nPlease accept it before ${when(d.offerExpiresAt, c)}, or it will be offered to the next person.`,
  }),
  'class.reminder': (d, c) => ({
    subject: `Reminder: ${text(d.title)} ${when(d.startsAt, c)}`,
    body: `Hello,\n\nA reminder that ${text(d.riderName, 'your rider')} has ${text(d.title)} on ${when(d.startsAt, c)}${d.arena ? ` in ${text(d.arena)}` : ''}.`,
  }),
  'package.low_balance': (d) => ({
    subject: 'Your package is running low',
    body: `Hello,\n\n${text(d.riderName, 'Your rider')} has ${text(d.balance)} class${Number(d.balance) === 1 ? '' : 'es'} left on ${text(d.packageName, 'their package')}.`,
  }),
  'package.expiring': (d, c) => ({
    subject: 'Your package expires soon',
    body: `Hello,\n\n${text(d.packageName, 'The package')} for ${text(d.riderName, 'your rider')} expires on ${day(d.validUntil, c)}, with ${text(d.balance)} class${Number(d.balance) === 1 ? '' : 'es'} left. Unused classes are lost after that.`,
  }),
  'document.expiring': (d, c) => ({
    subject: `A document expires soon: ${text(d.documentKind)}`,
    body: `Hello,\n\nThe ${text(d.documentKind)} for ${text(d.riderName, 'your rider')} expires on ${day(d.expiresAt, c)}. Please bring or upload a new one so bookings are not blocked.`,
  }),
  'incident.escalated': (d) => ({
    subject: `${text(d.severity)} incident reported`,
    body: `A ${text(d.severity)} incident has been reported and needs management review.\n\nReference: ${text(d.reference)}. Open the portal to see the details.`,
  }),
  'assessment.decided': (d) => ({
    subject: `Assessment result for ${text(d.riderName, 'your rider')}`,
    body: `Hello,\n\n${text(d.riderName, 'Your rider')}'s assessment has been reviewed: ${text(d.outcome)}.${d.newLevel ? `\n\nThe new level is ${text(d.newLevel)}.` : ''}`,
  }),
};

const TEMPLATES: Record<Locale, Record<NotifyEvent, Template>> = { en: EN, ar: EN };

export function render(event: NotifyEvent, data: NotifyData, ctx: RenderContext): Rendered {
  return TEMPLATES[ctx.locale][event](data, ctx);
}
