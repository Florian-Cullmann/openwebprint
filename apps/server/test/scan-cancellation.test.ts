import { afterEach, expect, it, vi } from 'vitest';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Device, Job, ScanOptions } from '@openwebprint/shared';
import sharp from 'sharp';
import { DemoProvider } from '../src/providers/demo.js';
import { fixture } from './helpers.js';
import * as documents from '../src/documents.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
class ControlledScanner extends DemoProvider {
  pause = true;
  entered = gate();
  aborted = gate();
  stopped = gate();
  signal?: AbortSignal;
  override async scan(
    _device: Device,
    output: string,
    _options: ScanOptions,
    _limit?: number,
    signal?: AbortSignal,
  ) {
    this.signal = signal;
    await writeFile(
      output.replace('%d', '1'),
      await sharp({
        create: { width: 100, height: 200, channels: 3, background: '#fff' },
      })
        .png()
        .toBuffer(),
    );
    if (!this.pause) return;
    await writeFile(output.replace('%d', '2') + '.part', 'incomplete image');
    this.entered.release();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    this.aborted.release();
    await this.stopped.promise;
    // Deliberately resolve instead of throwing: the service must check cancellation itself.
  }
}
let f: Awaited<ReturnType<typeof fixture>> | undefined;
let cleanup = () => {};
afterEach(async () => {
  cleanup();
  await f?.close();
  f = undefined;
  vi.restoreAllMocks();
});
async function setup() {
  const scanner = new ControlledScanner();
  f = await fixture({ provider: scanner });
  cleanup = () => {
    scanner.stopped.release();
    for (const job of f!.store.jobs('demo')) void f!.service.cancel(job.id);
  };
  return scanner;
}
function start(jobId?: string) {
  const scanner = f!.store.devices('demo').find((device) => device.kind === 'scanner')!;
  return f!.service.scan(
    scanner.id,
    { resolution: 150, color: 'Color', source: 'ADF', batch: true },
    jobId,
  );
}
function cancel(id: string) {
  return f!.app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: f!.headers });
}
async function get(url: string) {
  const response = await f!.app.inject({ url, headers: f!.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.rawPayload;
}

it('waits for the provider to stop before releasing the lock and discarding the entire new batch (controlled scanner)', async () => {
  const scanner = await setup();
  const job = start();
  await scanner.entered.promise;
  const directory = f!.service.job(job.id).scanWorkPath!;
  expect(
    (
      await f!.app.inject({
        method: 'POST',
        url: `/api/jobs/${job.id}/cancel`,
        headers: { 'x-openwebprint': '1' },
      })
    ).statusCode,
  ).toBe(401);
  expect(scanner.signal!.aborted).toBe(false);
  const pending = cancel(job.id);
  // inject() is lazy until awaited/then'ed.
  const response = Promise.resolve(pending);
  await scanner.aborted.promise;
  const duplicate = Promise.resolve(cancel(job.id));
  let drained = false;
  const drain = f!.service.close().then(() => {
    drained = true;
  });
  expect(drained).toBe(false);
  expect(f!.service.job(job.id).status).toBe('processing');
  expect(() => start()).toThrow('already in use');
  await expect(f!.service.deleteJob(job.id)).rejects.toThrow('Active jobs');
  await access(directory);
  scanner.stopped.release();
  const result = await response;
  await drain;
  expect(drained).toBe(true);
  expect((await duplicate).json<Job>()).toEqual(result.json<Job>());
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json<Job>()).toMatchObject({ status: 'canceled', hasFile: false });
  expect(result.json<Job>().error).toContain('discarded');
  await expect(access(directory)).rejects.toThrow();
  expect(await readdir(f!.service.filesDir)).toEqual([]);
  expect((await cancel(job.id)).json<Job>().status).toBe('canceled');
  scanner.pause = false;
  const retry = start();
  await f!.service.close();
  expect(f!.service.job(retry.id).status).toBe('completed');
});

it('keeps saved originals, revision, preview and PDF during and after canceling an append (controlled scanner)', async () => {
  const scanner = await setup();
  scanner.pause = false;
  const job = start();
  await f!.service.close();
  const before = f!.service.job(job.id);
  const pdf = await get(`/api/jobs/${job.id}/pdf`);
  const preview = await get(`/api/jobs/${job.id}/preview`);
  const page = await get(`/api/scans/${job.id}/pages/${before.scanPages![0].id}`);
  scanner.pause = true;
  start(job.id);
  await scanner.entered.promise;
  expect(await get(`/api/jobs/${job.id}/pdf`)).toEqual(pdf);
  const response = Promise.resolve(cancel(job.id));
  await scanner.aborted.promise;
  scanner.stopped.release();
  expect((await response).json<Job>()).toMatchObject({
    status: 'completed',
    hasFile: true,
    scanRevision: before.scanRevision,
    pages: before.scanPages!.map(({ id, rotation }) => ({ id, rotation })),
  });
  expect(await get(`/api/jobs/${job.id}/pdf`)).toEqual(pdf);
  expect(await get(`/api/jobs/${job.id}/preview`)).toEqual(preview);
  expect(await get(`/api/scans/${job.id}/pages/${before.scanPages![0].id}`)).toEqual(page);
  expect(await readdir(before.scanDirectory!)).toHaveLength(1);
  scanner.pause = false;
  start(job.id);
  await f!.service.close();
  expect(f!.service.job(job.id).scanPages).toHaveLength(2);
});

it.each([false, true])(
  'rolls back a cancel during PDF export, with saved pages=%s (controlled export boundary)',
  async (append) => {
    const scanner = await setup();
    scanner.pause = false;
    let original: Job | undefined;
    let pdf: Buffer | undefined;
    if (append) {
      original = start();
      await f!.service.close();
      pdf = await get(`/api/jobs/${original.id}/pdf`);
    }
    const exported = gate();
    const finish = gate();
    const exportPages = documents.exportScanPages;
    vi.spyOn(documents, 'exportScanPages').mockImplementation(async (...args) => {
      await exportPages(...args);
      exported.release();
      await finish.promise;
    });
    const previousCleanup = cleanup;
    cleanup = () => {
      finish.release();
      previousCleanup();
    };
    const job = start(original?.id);
    await exported.promise;
    const directory = f!.service.job(job.id).scanWorkPath!;
    await access(`${directory}/document.pdf`);
    const canceled = Promise.resolve(cancel(job.id));
    await vi.waitFor(() => expect(scanner.signal!.aborted).toBe(true));
    finish.release();
    expect((await canceled).json<Job>().status).toBe(append ? 'completed' : 'canceled');
    await expect(access(directory)).rejects.toThrow();
    if (append) expect(await get(`/api/jobs/${job.id}/pdf`)).toEqual(pdf);
    else expect(f!.service.job(job.id).hasFile).toBe(false);
  },
);

it('lets synchronous publication win a late cancel without a false canceled state (controlled persistence boundary)', async () => {
  const scanner = await setup();
  scanner.pause = false;
  const save = f!.store.putJob.bind(f!.store);
  let cancellation: Promise<Job> | undefined;
  vi.spyOn(f!.store, 'putJob').mockImplementation((job) => {
    save(job);
    if (job.kind === 'scan' && job.status === 'completed') cancellation = f!.service.cancel(job.id);
  });
  const job = start();
  await f!.service.close();
  expect(await cancellation).toMatchObject({ status: 'completed', hasFile: true });
  expect(scanner.signal!.aborted).toBe(false);
  expect((await cancel(job.id)).json<Job>().status).toBe('completed');
  expect((await get(`/api/jobs/${job.id}/pdf`)).subarray(0, 5).toString()).toBe('%PDF-');
  expect(await readFile(f!.service.job(job.id).scanPages![0].path)).not.toHaveLength(0);
});
