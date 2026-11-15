import { defineConfig } from 'tsup';

// CommonJS so PM2 cluster mode can load it. Workspace packages are bundled (they ship
// TypeScript source); @velum/db stays external because Prisma loads its engine from disk.
// Two programs: the workers (dist/index.js) and the signer (dist/signer.js: the price relayer and the keeper, run as
// their own user from their own build, on-chain audit M-2; it never loads @velum/db, so its build needs no Prisma).
export default defineConfig({
  entry: { index: 'src/index.ts', signer: 'src/signer.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@velum/config', '@velum/math'],
  external: ['@velum/db'],
});
