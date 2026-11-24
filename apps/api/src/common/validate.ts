import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Checks input against a zod schema. Unknown fields are dropped. A bad request becomes a 400 listing each field. */
export function parse<T>(schema: ZodType<T, any, any>, input: unknown): T {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw new BadRequestException({
      message: 'The request is not valid.',
      problems: r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
