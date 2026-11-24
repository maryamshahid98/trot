// Minimal typings so `tsc` works without installing @types/node in this offline workspace.
// Delete this file once @types/node is installed.
declare module "node:test" { export function test(name: string, fn: () => void | Promise<void>): void; export function describe(name: string, fn: () => void): void; export const it: typeof test; }
declare module "node:assert/strict" { const assert: { equal(a: unknown, b: unknown, m?: string): void; deepEqual(a: unknown, b: unknown, m?: string): void; ok(v: unknown, m?: string): void; }; export default assert; }
