import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

type Issue = { path: PropertyKey[]; code: string; message: string; origin?: string; minimum?: unknown; maximum?: unknown };

/** The library's own wording ("Too small: expected string to have >=1 characters") means nothing at a front desk. */
function plain(i: Issue): string {
  const generic = /^(Too small|Too big|Invalid input|Invalid option|Invalid string)/.test(i.message);
  if (!generic) return i.message;
  if (i.code === 'invalid_type') return 'is required';
  if (i.code === 'invalid_value') return 'is not one of the choices';
  if (i.code === 'too_small') return i.origin === 'string' ? (Number(i.minimum) <= 1 ? 'is required' : `needs at least ${i.minimum} characters`) : i.origin === 'array' ? 'choose at least one' : `must be at least ${i.minimum}`;
  if (i.code === 'too_big') return i.origin === 'string' ? `can be at most ${i.maximum} characters` : i.origin === 'array' ? 'has too many choices' : `must be at most ${i.maximum}`;
  return 'is not valid';
}

/** Checks input against a zod schema. Unknown fields are dropped. A bad request becomes a 400 listing each field. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw new BadRequestException({
      message: 'The request is not valid.',
      // One message per field: the first thing wrong is the thing to fix.
      problems: (r.error.issues as unknown as Issue[])
        .map((i) => ({ field: i.path.join('.'), message: plain(i) }))
        .filter((p, n, all) => all.findIndex((q) => q.field === p.field) === n),
    });
  }
  return r.data;
}
