import { defineConfig } from 'tsup';

// CommonJS so PM2 cluster mode can load it. Workspace packages are bundled (they ship
// TypeScript source); @velum/db stays external because Prisma loads its engine from disk.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@velum/config', '@velum/math'],
  external: ['@velum/db'],
});
