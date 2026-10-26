import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const pdfjs = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  const target = join(import.meta.dirname, 'public/pdfjs', directory);
  mkdirSync(target, { recursive: true });
  cpSync(join(pdfjs, directory), target, { recursive: true });
}
cpSync(join(pdfjs, 'LICENSE'), join(import.meta.dirname, 'public/pdfjs/LICENSE'));
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { sourcemap: true },
});
