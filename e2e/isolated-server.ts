import { test as base } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Give long or seeded journeys their own database and rate-limit budget.
// Exercise the shipped server bundle with the normal production limits.
export function isolatedTest(seed?: (directory: string) => Promise<void>) {
  return base.extend({
    baseURL: async ({}, use) => {
      const directory = await mkdtemp(join(tmpdir(), 'openwebprint-e2e-isolated-'));
      let stop: (() => Promise<void>) | undefined;
      try {
        await seed?.(directory);
        const listener = createServer().listen(0, '127.0.0.1');
        await once(listener, 'listening');
        const address = listener.address();
        if (!address || typeof address === 'string') throw new Error('Missing temporary port');
        const port = address.port;
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        const origin = `http://127.0.0.1:${port}`;
        const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
          stdio: ['ignore', 'ignore', 'inherit'],
          env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            DATA_DIR: directory,
            APP_ORIGIN: origin,
            COOKIE_SECURE: 'false',
            MODE: 'demo',
          },
        });
        const exited = once(server, 'exit');
        stop = async () => {
          server.kill('SIGTERM');
          await exited;
        };
        for (let attempt = 0; ; attempt++) {
          try {
            if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok)
              break;
          } catch {}
          if (server.exitCode !== null || attempt >= 100)
            throw new Error('Isolated server failed to start');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await use(origin);
      } finally {
        await stop?.();
        await rm(directory, { recursive: true, force: true });
      }
    },
  });
}
