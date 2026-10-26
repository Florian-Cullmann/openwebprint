import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { DemoProvider } from '../src/providers/demo.js';
import { fixture, credentials, pdf } from './helpers.js';
import type { StoredJob } from '../src/store.js';
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
it('allows only one anonymous first-user request to succeed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owp-users-'));
  const { app, auth } = await createApp(readConfig({ DATA_DIR: dir }), { background: false });
  try {
    expect((await app.inject('/api/snapshot')).statusCode).toBe(200);
    const request = {
      method: 'POST' as const,
      url: '/api/users',
      headers: { 'x-openwebprint': '1' },
      payload: credentials,
    };
    const results = await Promise.all([
      app.inject(request),
      app.inject({ ...request, payload: { ...credentials, username: 'second' } }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 401]);
    expect(auth.users()).toHaveLength(1);
    expect((await app.inject('/api/snapshot')).statusCode).toBe(401);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('does not resurrect a canceled and deleted job when an old poll resolves', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  class DelayedPoll extends DemoProvider {
    override async poll() {
      await pending;
      return { status: 'processing' as const };
    }
  }
  f = await fixture({ provider: new DelayedPoll() });
  const device = f.store.devices('demo').find((d) => d.kind === 'printer')!;
  const job = await f.service.print(device.id, await pdf(), 'application/pdf', 'Race test', {
    copies: 1,
    color: 'monochrome',
    sides: 'one-sided',
    media: 'iso_a4_210x297mm',
  });
  const polling = f.service.tick();
  try {
    await f.service.cancel(job.id);
    await f.service.deleteJob(job.id);
    release();
    await polling;
    expect(f.store.jobs('demo')).toEqual([]);
  } finally {
    release();
  }
});
it('expires files from both modes, even while only demo mode is selected', async () => {
  f = await fixture();
  const path = join(f.service.filesDir, randomUUID() + '.pdf');
  await writeFile(path, 'private data');
  const job: StoredJob = {
    id: randomUUID(),
    deviceId: randomUUID(),
    deviceName: 'Real scanner',
    kind: 'scan',
    title: 'Old real scan',
    mode: 'hardware',
    status: 'completed',
    hasFile: true,
    filePath: path,
    createdAt: new Date(Date.now() - 8 * 86400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    options: { resolution: 300, color: 'Color' },
  };
  f.store.putJob(job);
  await f.service.expireFiles();
  await expect(access(path)).rejects.toThrow();
  expect(f.store.job(job.id, 'hardware')!.hasFile).toBe(false);
  expect((await f.service.snapshot()).jobs).toEqual([]);
});
it('rejects expired sessions even when the browser still sends the cookie', async () => {
  f = await fixture();
  f.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() - 1);
  expect((await f.app.inject({ url: '/api/snapshot', headers: f.headers })).statusCode).toBe(401);
});
