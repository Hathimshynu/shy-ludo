import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle the internal workspace packages (they ship TypeScript source).
  noExternal: [/^@ludo\//],
  external: ['@prisma/client', '.prisma/client'],
});
