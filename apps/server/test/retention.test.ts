import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, Mode, RetentionPolicy } from '@openwebprint/shared';
import type { StoredJob } from '../src/store.js';
import { fixture } from './helpers.js';
import * as documents from '../src/documents.js';

const DAY = 86400_000;
const START = Date.parse('2026-10-01T12:00:00.000Z');
let f: Awaited<ReturnType<typeof fixture>> | undefined;
const external: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await f?.close();
  f = undefined;
  await Promise.all(external.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function clock(time = START) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
}
async function retained(kind: Job['kind'], mode: Mode = 'demo', directory = f!.service.filesDir) {
  const id = randomUUID();
  const scanDirectory = join(directory, `${id}.pages`);
  await mkdir(scanDirectory, { recursive: true });
  const filePath = join(scanDirectory, 'document.pdf');
  const previewPath = join(scanDirectory, 'preview.png');
  const pagePath = join(scanDirectory, 'page.png');
  // Include an unreferenced obsolete file to verify recursive scan-directory cleanup.
  for (const path of [filePath, previewPath, pagePath, join(scanDirectory, 'obsolete.png')])
    await writeFile(path, 'synthetic private document');
  const job: StoredJob = {
    id,
    mode,
    kind,
    title: 'Retention sample',
    deviceId: randomUUID(),
    deviceName: 'Fixture',
    status: 'completed',
    hasFile: true,
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    options: { resolution: 150, color: 'Gray' },
    filePath,
    previewPath,
    scanDirectory,
    scanPages: [{ id: randomUUID(), path: pagePath, rotation: 0 }],
  };
  f!.store.putJob(job);
  return job;
}
function change(policy: RetentionPolicy, confirm = false) {
  return f!.app.inject({
    method: 'PUT',
    url: '/api/retention',
    headers: f!.headers,
    payload: { ...policy, confirm },
  });
}
async function scan(jobId?: string) {
  const scanner = f!.store.devices('demo').find((d) => d.kind === 'scanner')!;
  const result = f!.service.scan(scanner.id, { resolution: 150, color: 'Gray' }, jobId);
  await f!.service.close();
  return f!.service.publicJob(f!.service.job(result.id));
}

it('keeps the seven-day upgrade default and deletes at the exact boundary, preserving records', async () => {
  clock();
  f = await fixture({ users: false });
  expect((await f.app.inject('/api/retention')).json()).toEqual({ scanDays: 7, printDays: 7 });
  const job = await retained('scan');
  expect(f.service.publicJob(job).expiresAt).toBe(new Date(START + 7 * DAY).toISOString());
  vi.setSystemTime(START + 7 * DAY - 1);
  await f.workspace.expireFiles();
  await access(job.filePath!);
  vi.setSystemTime(START + 7 * DAY);
  await Promise.all([f.workspace.expireFiles(), f.workspace.expireFiles()]);
  await expect(access(job.scanDirectory!)).rejects.toThrow();
  expect(f.service.job(job.id)).toMatchObject({
    id: job.id,
    title: job.title,
    status: 'completed',
    hasFile: false,
  });
  expect(f.service.job(job.id).scanPages).toBeUndefined();
});

it('uses separate policies in both modes and removes all managed files in an external scan folder', async () => {
  clock();
  f = await fixture({ users: false });
  const directory = await mkdtemp(join(tmpdir(), 'owp-external-retention-'));
  external.push(directory);
  const hardware = await retained('scan', 'hardware', directory);
  const demo = await retained('scan');
  const print = await retained('print');
  expect((await change({ scanDays: 2, printDays: 3 })).statusCode).toBe(200);
  vi.setSystemTime(START + 2 * DAY);
  await f.workspace.expireFiles();
  for (const job of [hardware, demo]) {
    await expect(access(job.scanDirectory!)).rejects.toThrow();
    expect(f.store.job(job.id, job.mode)!.hasFile).toBe(false);
  }
  await access(print.filePath!);
  vi.setSystemTime(START + 3 * DAY);
  await f.workspace.expireFiles();
  expect(f.service.job(print.id).hasFile).toBe(false);
});

it('requires confirmation before a shorter policy affects existing documents and never restores deleted files', async () => {
  clock();
  f = await fixture({ users: false });
  const scan = await retained('scan');
  const print = await retained('print');
  vi.setSystemTime(START + 3 * DAY);
  const policy = { scanDays: 2, printDays: 1 };
  const preview = await f.app.inject({
    method: 'POST',
    url: '/api/retention/preview',
    headers: f.headers,
    payload: policy,
  });
  expect(preview.json()).toEqual({ scans: 1, prints: 1 });
  expect((await change(policy)).statusCode).toBe(409);
  expect((await f.app.inject('/api/retention')).json()).toEqual({ scanDays: 7, printDays: 7 });
  expect((await change(policy, true)).statusCode).toBe(200);
  for (const url of [
    `/api/jobs/${scan.id}/pdf`,
    `/api/jobs/${scan.id}/preview`,
    `/api/jobs/${print.id}/document`,
    `/api/scans/${scan.id}/pages/${scan.scanPages![0].id}`,
    `/api/scans/${scan.id}/pages/${scan.scanPages![0].id}?rendered=1`,
    `/api/scans/${scan.id}/pages/${scan.scanPages![0].id}?thumbnail=1`,
  ])
    expect((await f.app.inject(url)).statusCode).toBe(410);
  await f.workspace.expireFiles();
  expect((await change({ scanDays: 3650, printDays: 3650 })).statusCode).toBe(200);
  expect(f.service.job(scan.id).hasFile).toBe(false);
  expect((await f.app.inject(`/api/jobs/${scan.id}/pdf`)).statusCode).toBe(404);
});

it('applies extensions to existing files and persists the policy across restart and startup cleanup', async () => {
  clock();
  f = await fixture({ users: false });
  const job = await retained('scan');
  expect((await change({ scanDays: 10, printDays: 12 })).statusCode).toBe(200);
  const directory = f.dataDir;
  await f.close(false);
  f = undefined;
  vi.setSystemTime(START + 8 * DAY);
  f = await fixture({ users: false, dataDir: directory });
  expect((await f.app.inject('/api/retention')).json()).toEqual({ scanDays: 10, printDays: 12 });
  expect((await f.app.inject(`/api/jobs/${job.id}`)).json().expiresAt).toBe(
    new Date(START + 10 * DAY).toISOString(),
  );
  await access(job.filePath!);
  await f.close(false);
  f = undefined;
  vi.setSystemTime(START + 10 * DAY);
  f = await fixture({ users: false, dataDir: directory });
  expect(f.service.job(job.id).hasFile).toBe(false);
  await expect(access(job.scanDirectory!)).rejects.toThrow();
});

it('keeps the original expiry through successful edits/appends and failed appends (demo scanner)', async () => {
  clock();
  f = await fixture({ users: false });
  const original = await scan();
  vi.setSystemTime(START + DAY);
  const appended = await scan(original.id);
  expect(appended.pages).toHaveLength(2);
  const edited = await f.service.editScan(appended.id, appended.scanRevision!, [
    { ...appended.pages![0], rotation: 90 },
  ]);
  vi.spyOn(f.service.provider, 'scan').mockRejectedValueOnce(
    new Error('Synthetic scanner failure'),
  );
  const failed = await scan(edited.id);
  for (const result of [appended, edited, failed])
    expect(result.expiresAt).toBe(original.expiresAt);
  expect(failed.pages).toEqual(edited.pages);
  const thumbnailUrl = `/api/scans/${failed.id}/pages/${failed.pages![0].id}?thumbnail=1`;
  expect((await f.app.inject(thumbnailUrl)).statusCode).toBe(200);
  const thumbnailDirectory = join(f.service.filesDir, `${failed.id}.thumbnails`);
  await access(thumbnailDirectory);
  vi.setSystemTime(START + 7 * DAY);
  expect((await f.app.inject(thumbnailUrl)).statusCode).toBe(410);
  expect(() =>
    f!.service.scan(failed.deviceId, { resolution: 150, color: 'Gray' }, failed.id),
  ).toThrow('expired');
  expect(() => f!.service.editScan(failed.id, failed.scanRevision!, failed.pages!)).toThrow(
    'expired',
  );
});

it.each(['append', 'edit'])(
  'skips an %s crossing expiry until publication, even when cleanup starts in the other mode (demo scanner)',
  async (operation) => {
    clock();
    f = await fixture({ users: false });
    const original = await scan();
    const exporter = documents.exportScanPages;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publishing = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(documents, 'exportScanPages').mockImplementationOnce(async (...args) => {
      started();
      await gate;
      return exporter(...args);
    });
    const pending =
      operation === 'append'
        ? f.service.scan(original.deviceId, { resolution: 150, color: 'Gray' }, original.id)
        : f.service.editScan(original.id, original.scanRevision!, [
            { ...original.pages![0], rotation: 90 },
          ]);
    try {
      await publishing;
      vi.setSystemTime(START + 7 * DAY);
      await f.workspace.hardware.expireFiles();
      await f.workspace.expireFiles();
      await access(f.service.job(original.id).filePath!);
      expect(f.service.job(original.id).hasFile).toBe(true);
    } finally {
      release();
    }
    await pending;
    await f.service.close();
    expect(f.service.job(original.id).scanPages).toHaveLength(operation === 'append' ? 2 : 1);
    await f.workspace.expireFiles();
    expect(f.service.job(original.id).hasFile).toBe(false);
  },
);

it('skips active print jobs and expires unconfirmed submissions once no operation is using them', async () => {
  clock();
  f = await fixture({ users: false });
  const queued = await retained('print');
  const processing = await retained('print');
  const unknown = await retained('print');
  for (const [job, status] of [
    [queued, 'queued'],
    [processing, 'processing'],
    [unknown, 'unknown'],
  ] as const)
    f.store.putJob({ ...job, status });
  vi.setSystemTime(START + 7 * DAY);
  await f.workspace.expireFiles();
  await access(queued.filePath!);
  await access(processing.filePath!);
  expect(f.service.job(unknown.id).hasFile).toBe(false);
  f.store.putJob({ ...processing, status: 'completed' });
  await f.workspace.expireFiles();
  expect(f.service.job(processing.id).hasFile).toBe(false);
});

it('validates policy bounds, strict input, authentication, and request origin', async () => {
  f = await fixture();
  for (const scanDays of [0, -1, 3651, 1.5, null, '7'])
    expect((await change({ scanDays, printDays: 7 } as RetentionPolicy)).statusCode).toBe(400);
  expect((await change({ scanDays: 1, printDays: 0 })).statusCode).toBe(400);
  expect((await change({ scanDays: 1, printDays: 3650 })).statusCode).toBe(200);
  for (const method of ['GET', 'PUT', 'POST'] as const) {
    const url = method === 'POST' ? '/api/retention/preview' : '/api/retention';
    const request = {
      method,
      url,
      payload: method === 'GET' ? undefined : { scanDays: 7, printDays: 7 },
    };
    expect(
      (await f.app.inject({ ...request, headers: { 'x-openwebprint': '1' } })).statusCode,
    ).toBe(401);
    if (method !== 'GET') {
      expect((await f.app.inject({ ...request, headers: { cookie: f.cookie } })).statusCode).toBe(
        403,
      );
      expect(
        (
          await f.app.inject({
            ...request,
            headers: { ...f.headers, origin: 'https://evil.example' },
          })
        ).statusCode,
      ).toBe(403);
    }
  }
  expect(
    (
      await f.app.inject({
        method: 'PUT',
        url: '/api/retention',
        headers: f.headers,
        payload: { scanDays: 1, printDays: 1, extra: true },
      })
    ).statusCode,
  ).toBe(400);
});

it.each(['poll', 'cancel'])(
  'does not restore expired file references when an earlier %s resolves (stubbed printer)',
  async (operation) => {
    clock();
    f = await fixture({ users: false });
    const job = await retained('print');
    job.deviceId = f.store.devices('demo').find((d) => d.kind === 'printer')!.id;
    job.externalId = 'stubbed-print';
    job.status = 'unknown';
    f.store.putJob(job);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (operation === 'poll')
      vi.spyOn(f.service.provider, 'poll').mockImplementationOnce(async () => {
        entered();
        await gate;
        return { status: 'completed' };
      });
    else
      vi.spyOn(f.service.provider, 'cancel').mockImplementationOnce(async () => {
        entered();
        await gate;
      });
    const pending = operation === 'poll' ? f.service.tick() : f.service.cancel(job.id);
    try {
      await started;
      vi.setSystemTime(START + 7 * DAY);
      await f.workspace.expireFiles();
      expect(f.service.job(job.id).hasFile).toBe(false);
    } finally {
      release();
    }
    await pending;
    expect(f.service.job(job.id)).toMatchObject({
      hasFile: false,
      status: operation === 'poll' ? 'completed' : 'canceled',
    });
    expect(f.service.job(job.id).filePath).toBeUndefined();
  },
);
