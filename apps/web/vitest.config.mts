import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Unit tests for the browser-only money, copy and signing rules (tests/*.test.ts). Node, no DOM. */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // tsconfig keeps JSX as-is for Next; the tests need it compiled (lib/demo.tsx builds receipt rows).
  esbuild: { jsx: 'automatic' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
