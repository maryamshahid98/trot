// Compiles the API (and the shared rules package) into one file for the Vercel function. Installed libraries stay separate.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  absWorkingDir: root,
  entryPoints: ['apps/api/src/serverless.ts'],
  outfile: 'apps/api/dist/serverless.mjs',
  tsconfig: 'apps/api/tsconfig.json',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info',
  plugins: [{
    name: 'libraries-stay-outside',
    setup(b) {
      // Everything imported by name is left to Node, except our own workspace package, which is TypeScript source.
      b.onResolve({ filter: /^[^./]/ }, (a) => (a.path === '@trot/domain' || path.isAbsolute(a.path) ? undefined : { external: true }));
    },
  }],
});
