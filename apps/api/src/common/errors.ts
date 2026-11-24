/** Small, typed readers for errors caught as `unknown`, so no catch block needs `any`. */

const field = (e: unknown, name: string): unknown => (typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[name] : undefined);

/** The Postgres error code (SQLSTATE, such as '23505') of a database error, or undefined for any other error. */
export const pgErrorCode = (e: unknown): string | undefined => {
  const code = field(e, 'code');
  return typeof code === 'string' ? code : undefined;
};

/** The name of the constraint a database error is about, when Postgres says. */
export const pgConstraint = (e: unknown): string | undefined => {
  const c = field(e, 'constraint');
  return typeof c === 'string' ? c : undefined;
};

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
