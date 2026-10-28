import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { readArchive } from './archive.js';
import { MAX_SCAN_EXPORT_BYTES, type ScanExportSelection } from '@openwebprint/shared';
import { SCAN_EXPORT_TIMEOUT } from '../src/scan-export.js';
import { fixture, pdf } from './helpers.js';
import type { StoredJob } from '../src/store.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await f?.close();
  f = undefined;
});
async function scan(title = 'Sample scan', extra: Partial<StoredJob> = {}) {
  const id = randomUUID();
  const filePath = join(f!.dataDir, `${id}.pdf`);
  await writeFile(filePath, await pdf());
  const job: StoredJob = {
    id,
    title,
    deviceId: randomUUID(),
    deviceName: 'Synthetic archive',
    kind: 'scan',
    mode: 'demo',
    status: 'completed',
    hasFile: true,
    filePath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scanRevision: randomUUID(),
    options: { resolution: 300, color: 'Color' },
    ...extra,
  };
  f!.store.putJob(job);
  return job;
}
const selection = (job: StoredJob): ScanExportSelection => ({
  id: job.id,
  revision: job.scanRevision ?? job.updatedAt,
});
function download(jobs: StoredJob[], headers = f!.headers) {
  return f!.app.inject({
    method: 'POST',
    url: '/api/scans/export',
    headers,
    payload: { scans: jobs.map(selection) },
  });
}

it('exports exact saved revisions with stable, safe Unicode names and collision handling without changing source data', async () => {
  f = await fixture();
  const jobs = [
    await scan('../Résumé\\帳簿:\u202E.pdf'),
    await scan('../Résumé\\帳簿:\u202E.pdf'),
    await scan('CON.pdf', { scanRevision: undefined }),
  ]; // Compatible legacy revision.
  const originals = await Promise.all(
    jobs.map(async (job) => ({
      job: f!.store.job(job.id, 'demo'),
      data: await readFile(job.filePath!),
      mtime: (await stat(job.filePath!)).mtimeMs,
    })),
  );
  const first = await download(jobs);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.headers['content-type']).toContain('application/zip');
  expect(first.headers['content-disposition']).toContain('openwebprint-scans.zip');
  expect(first.headers['cache-control']).toBe('no-store');
  const entries = await readArchive(first.rawPayload);
  expect(entries.size).toBe(3);
  const names = [...entries.keys()];
  expect(names[0]).toContain('Résumé_帳簿');
  for (const [index, name] of names.entries()) {
    expect(name).not.toMatch(/[/\\\u202E:]/);
    expect(Buffer.byteLength(name)).toBeLessThan(255);
    expect(name.endsWith(`${jobs[index].id}.pdf`)).toBe(true);
    expect(entries.get(name)).toEqual(originals[index].data);
    expect(first.rawPayload.includes(Buffer.from(jobs[index].filePath!))).toBe(false);
  }
  const second = await download([...jobs].reverse());
  expect([...(await readArchive(second.rawPayload)).keys()].sort()).toEqual(names.sort());
  await f.service.scanExports.close();
  for (const [index, job] of jobs.entries()) {
    expect(f.store.job(job.id, 'demo')).toEqual(originals[index].job);
    expect(await readFile(job.filePath!)).toEqual(originals[index].data);
    expect((await stat(job.filePath!)).mtimeMs).toBe(originals[index].mtime);
  }
});

it('rejects unauthenticated requests, wrong origins, invalid selections, print jobs and another mode', async () => {
  f = await fixture();
  const job = await scan();
  expect((await download([job], { 'x-openwebprint': '1' } as typeof f.headers)).statusCode).toBe(
    401,
  );
  expect(
    (await download([job], { ...f.headers, origin: 'https://other.example' } as typeof f.headers))
      .statusCode,
  ).toBe(403);
  expect((await download([job], { cookie: f.cookie } as typeof f.headers)).statusCode).toBe(403);
  expect((await download([])).statusCode).toBe(400);
  expect((await download([job, job])).statusCode).toBe(400);
  const hardware = await scan('Private mode title', { mode: 'hardware' });
  const wrongMode = await download([job, hardware]);
  expect(wrongMode.statusCode).toBe(404);
  expect(wrongMode.body).not.toContain('Private mode title');
  const print = await scan('Print job', { kind: 'print' });
  expect((await download([print])).statusCode).toBe(404);
  await f.service.deleteJob(job.id); // A failed selection released earlier locks.
});

it('reports changed, expired, missing and busy selections before sending a ZIP', async () => {
  f = await fixture();
  const job = await scan('Receipt');
  const changed = await download([{ ...job, scanRevision: randomUUID() }]);
  expect(changed.statusCode).toBe(409);
  expect(changed.json().error).toContain('Receipt');
  expect(changed.json().error).toContain('has changed');
  const expired = await scan('Old receipt', {
    createdAt: new Date(Date.now() - 8 * 86400_000).toISOString(),
  });
  expect((await download([job, expired])).statusCode).toBe(410);
  const busy = await scan('Pending receipt', { status: 'processing' });
  expect((await download([busy])).statusCode).toBe(409);
  const missing = await scan('Missing receipt');
  await unlink(missing.filePath!);
  const response = await download([job, missing]);
  expect(response.statusCode).toBe(410);
  expect(response.json().error).toContain('Missing receipt');
  expect(response.body).not.toContain(f.dataDir);
  expect((await download([{ ...job, id: randomUUID() }])).statusCode).toBe(404);
  await f.service.deleteJob(job.id);
});

it('bounds document count and total original bytes, including a full 50-document ZIP', async () => {
  f = await fixture();
  const jobs = await Promise.all(Array.from({ length: 51 }, (_, i) => scan(`Receipt ${i}`)));
  expect((await download(jobs)).statusCode).toBe(400);
  const response = await download(jobs.slice(0, 50));
  expect(response.statusCode).toBe(200);
  expect((await readArchive(response.rawPayload)).size).toBe(50);
  await truncate(jobs[50].filePath!, MAX_SCAN_EXPORT_BYTES + 1); // Sparse synthetic oversized PDF.
  const oversized = await download([jobs[0], jobs[50]]);
  expect(oversized.statusCode).toBe(413);
  expect(oversized.json().error).toContain('100 MiB');
  await f.service.deleteJob(jobs[0].id);
});

it('releases locks and export capacity after canceled, failed and unconsumed streams', async () => {
  f = await fixture();
  const jobs = await Promise.all(Array.from({ length: 3 }, () => scan()));
  for (const job of jobs) await truncate(job.filePath!, 2 * 1024 * 1024);
  const controller = new AbortController();
  const first = await f.service.scanExports.create([selection(jobs[0])], controller.signal);
  const second = await f.service.scanExports.create([selection(jobs[1])]);
  await expect(f.service.scanExports.create([selection(jobs[2])])).rejects.toThrow(
    'Two ZIP exports',
  );
  await expect(f.service.deleteJob(jobs[0].id)).rejects.toThrow('Active jobs');
  expect(() =>
    f!.service.editScan(jobs[0].id, jobs[0].scanRevision!, [{ id: jobs[0].id, rotation: 0 }]),
  ).toThrow('Wait for a completed scan');
  controller.abort();
  second.destroy();
  await f.service.scanExports.close();
  expect(first.destroyed).toBe(true);
  await f.service.deleteJob(jobs[0].id);
  const retry = await f.service.scanExports.create([selection(jobs[2])]);
  const archive = await buffer(retry);
  expect((await readArchive(archive)).size).toBe(1);
  await f.service.scanExports.close();
  await f.service.deleteJob(jobs[2].id);
});

it('aborts and releases an unconsumed export when retention is shortened, without extending creation time', async () => {
  f = await fixture();
  const job = await scan('Aging receipt', {
    createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
  });
  await truncate(job.filePath!, 2 * 1024 * 1024);
  const stream = await f.service.scanExports.create([selection(job)]);
  f.workspace.saveRetention({ scanDays: 1, printDays: 7 }, true);
  await f.service.scanExports.close();
  expect(stream.destroyed).toBe(true);
  expect(f.store.job(job.id, 'demo')!.createdAt).toBe(job.createdAt);
  await f.service.expireFiles();
  expect(f.store.job(job.id, 'demo')!.hasFile).toBe(false);
});

it('expires a stalled stream at the source deadline and drains it during mode removal', async () => {
  f = await fixture();
  const now = Date.now();
  const job = await scan('Expiring receipt', {
    createdAt: new Date(now - 7 * 86400_000 + 5000).toISOString(),
  });
  await truncate(job.filePath!, 2 * 1024 * 1024);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(now);
  const stream = await f.service.scanExports.create([selection(job)]);
  await vi.advanceTimersByTimeAsync(5001);
  expect(stream.destroyed).toBe(true);
  await f.service.scanExports.close();
  vi.useRealTimers();
  const another = await scan();
  await truncate(another.filePath!, 2 * 1024 * 1024);
  const pending = await f.service.scanExports.create([selection(another)]);
  await f.workspace.removeDemo();
  expect(pending.destroyed).toBe(true);
  expect(f.store.job(another.id, 'demo')).toBeUndefined();
});

it('cleans up an interrupted real HTTP download and permits editing/deletion afterward', async () => {
  f = await fixture();
  const job = await scan();
  await truncate(job.filePath!, 8 * 1024 * 1024);
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/scans/export`, {
    method: 'POST',
    signal: controller.signal,
    headers: { ...f.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ scans: [selection(job)] }),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  controller.abort();
  await reader.cancel().catch(() => {});
  await vi.waitFor(async () => {
    await f!.service.deleteJob(job.id);
  });
  expect(f.store.job(job.id, 'demo')).toBeUndefined();
});

it('bounds stalled exports by time even when sources remain retained and fails on unexpectedly truncated output', async () => {
  f = await fixture();
  const job = await scan();
  await truncate(job.filePath!, 2 * 1024 * 1024);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const stalled = await f.service.scanExports.create([selection(job)]);
  await vi.advanceTimersByTimeAsync(SCAN_EXPORT_TIMEOUT + 1);
  expect(stalled.destroyed).toBe(true);
  await f.service.scanExports.close();
  vi.useRealTimers();
  expect(f.store.job(job.id, 'demo')!.hasFile).toBe(true);
  const truncated = await f.service.scanExports.create([selection(job)]);
  await truncate(job.filePath!, 0); // Simulated external storage change, not an application edit.
  await expect(buffer(truncated)).rejects.toThrow('could not be read');
  await f.service.scanExports.close();
  await f.service.deleteJob(job.id);
});
