import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
const dir = await mkdtemp(join(tmpdir(), 'openwebprint-e2e-'));
const { app } = await createApp(
  readConfig({
    MODE: 'demo',
    DATA_DIR: dir,
    PORT: '4173',
    APP_ORIGIN: 'http://127.0.0.1:4173',
    SETUP_TOKEN: 'browser-test-setup-token-000000',
  }),
);
await app.listen({ port: 4173, host: '127.0.0.1' });
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => rm(dir, { recursive: true, force: true }))
      .then(() => process.exit(0));
  });
