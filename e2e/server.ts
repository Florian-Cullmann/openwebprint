import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'openwebprint-e2e-'));
// Exercise the shipped bundle, not a TypeScript-only server entry point.
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    MODE: 'demo',
    DATA_DIR: dir,
    PORT: '4173',
    APP_ORIGIN: 'http://127.0.0.1:4173',
    COOKIE_SECURE: 'false',
  },
});
let stopping = false;
server.once('error', async (error) => {
  console.error(error.message);
  await rm(dir, { recursive: true, force: true });
  process.exit(1);
});
server.once('exit', async (code) => {
  await rm(dir, { recursive: true, force: true });
  process.exit(stopping ? 0 : (code ?? 1));
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    stopping = true;
    server.kill('SIGTERM');
  });
