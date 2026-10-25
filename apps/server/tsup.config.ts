import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // sqlite exists only as node:sqlite; stripping this prefix breaks production.
  removeNodeProtocol: false,
  noExternal: ['@openwebprint/shared'],
});
