import type { Values } from '../ui/FormDialog';

/** An empty box means "nothing recorded": send null, or leave the field out of a new record. */
export const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const numberOrNull = (v: unknown): number | null => (typeof v === 'string' && v.trim() !== '' ? Number(v) : null);
/** Drops empty values, for creating a record. */
export const given = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== null && x !== undefined && x !== ''));
/** Turns a record into the strings a form starts with. */
export const asValues = (o: object, keys: readonly string[]): Values =>
  Object.fromEntries(keys.map((k) => { const x = (o as Record<string, unknown>)[k]; return [k, typeof x === 'boolean' || Array.isArray(x) ? (x as boolean | string[]) : x === null || x === undefined ? '' : String(x)]; }));
