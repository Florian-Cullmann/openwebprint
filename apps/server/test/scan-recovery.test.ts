import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import type { Device, Job, ScanOptions } from '@openwebprint/shared';
import { DemoProvider } from '../src/providers/demo.js';
import { fixture } from './helpers.js';
import * as documents from '../src/documents.js';

// Controlled acquisition writes complete PNGs, then a truncated final page and
// fails. These tests do not simulate the transport or certify a physical feeder.
class JamScanner extends DemoProvider {
  fail = true;
  count = 2;
  override async scan(_device: Device, output: string) {
    for (let number = 1; number <= this.count; number++)
      await sharp({ create: { width: 100 + number, height: 200, channels: 3, background: '#fff' } })
        .png()
        .toFile(output.replace('%d', String(number)));
    if (this.fail) {
      const complete = await readFile(output.replace('%d', '1')).catch(() => Buffer.alloc(0));
      // Missing IEND can pass metadata reads; it must never become recoverable.
      await writeFile(output.replace('%d', String(this.count + 1)), complete.subarray(0, -12));
      await writeFile(output.replace('%d', '9') + '.part', 'unfinished');
      throw new Error('Paper jam (controlled provider).');
    }
  }
}
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await f?.close();
  f = undefined;
});
const options: ScanOptions = { resolution: 150, color: 'Color', batch: true, source: 'ADF' };
async function start(jobId?: string) {
  const scanner = f!.store.devices('demo').find((device) => device.kind === 'scanner')!;
  const job = f!.service.scan(scanner.id, options, jobId);
  await f!.service.close();
  return f!.service.publicJob(f!.service.job(job.id));
}
function resolve(job: Job, action = 'keep', revision = job.recovery!.revision) {
  return f!.app.inject({
    method: 'POST',
    url: `/api/scans/${job.id}/recovery`,
    headers: f!.headers,
    payload: { action, revision },
  });
}
async function pdf(id: string) {
  const response = await f!.app.inject({ url: `/api/jobs/${id}/pdf`, headers: f!.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.rawPayload;
}

it.each([false, true])(
  'recovers only complete images in order after a failed %s append, retaining the original until commit',
  async (append) => {
    const scanner = new JamScanner();
    f = await fixture({ provider: scanner });
    scanner.fail = false;
    const original = append ? await start() : undefined;
    const before = original && (await pdf(original.id));
    scanner.fail = true;
    const job = await start(original?.id);
    expect(job).toMatchObject({
      status: append ? 'completed' : 'failed',
      hasFile: append,
      error: 'The operation failed. Check the server logs.',
      errorMessages: [{ code: 'operation_failed', params: {} }],
      recovery: { pageNumbers: [1, 2] },
    });
    expect(JSON.stringify(job)).not.toContain(f.dataDir);
    expect(JSON.stringify(job)).not.toContain('Paper jam');
    if (original) {
      expect(job.scanRevision).toBe(original.scanRevision);
      expect(job.pages).toEqual(original.pages);
      expect(await pdf(job.id)).toEqual(before);
      expect(() => f!.service.scan(job.deviceId, options, job.id)).toThrow('Keep or discard');
      expect(() => f!.service.editScan(job.id, job.scanRevision!, job.pages!)).toThrow();
    }
    const recovery = f.service.job(job.id).scanRecovery!;
    expect(await readdir(recovery.directory)).toEqual(['page-1.png', 'page-2.png']);
    expect((await resolve(job, 'keep', 'stale')).statusCode).toBe(409);
    const response = await resolve(job);
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<Job>();
    expect(saved.recovery).toBeUndefined();
    expect(saved.error).toContain('Acquisition incomplete');
    expect(saved.pages).toHaveLength(append ? 4 : 2);
    expect(saved.pages!.slice(append ? 2 : 0).map((page) => page.id)).toEqual(
      recovery.pages.map((page) => page.id),
    );
    expect((await PDFDocument.load(await pdf(job.id))).getPageCount()).toBe(append ? 4 : 2);
    expect((await resolve(job)).statusCode).toBe(409);
  },
);

it('offers no recovery when the failed provider produced no decodable pages', async () => {
  const scanner = new JamScanner();
  scanner.count = 0;
  f = await fixture({ provider: scanner });
  const job = await start();
  expect(job).toMatchObject({ status: 'failed', hasFile: false });
  expect(job.recovery).toBeUndefined();
  expect(f.service.job(job.id).scanDirectory).toBeUndefined();
});

it.each(['export', 'commit'])(
  'keeps the previous PDF and retryable recovery on %s failure, and locks concurrent mutations',
  async (failure) => {
    const scanner = new JamScanner();
    scanner.fail = false;
    f = await fixture({ provider: scanner });
    const original = await start();
    const before = await pdf(original.id);
    scanner.fail = true;
    const job = await start(original.id);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exporting = new Promise<void>((r) => {
      entered = r;
    });
    const exportPages = documents.exportScanPages;
    vi.spyOn(documents, 'exportScanPages').mockImplementationOnce(async (...args) => {
      await exportPages(...args);
      entered();
      await gate;
      if (failure === 'export') throw new Error('Controlled export failure');
    });
    const put = f.store.putJob.bind(f.store);
    vi.spyOn(f.store, 'putJob').mockImplementation((next) => {
      if (
        failure === 'commit' &&
        next.scanRevision !== job.scanRevision &&
        next.status === 'completed'
      )
        throw new Error('Controlled persistence failure');
      put(next);
    });
    const pending = Promise.resolve(resolve(job));
    try {
      await exporting;
      expect((await resolve(job, 'discard')).statusCode).toBe(409);
      expect(
        (await f.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers: f.headers }))
          .statusCode,
      ).toBe(409);
      expect(await pdf(job.id)).toEqual(before);
    } finally {
      release();
    }
    expect((await pending).statusCode).toBe(500);
    const retained = f.service.publicJob(f.service.job(job.id));
    expect(retained).toMatchObject({
      scanRevision: job.scanRevision,
      pages: job.pages,
      recovery: job.recovery,
    });
    expect(await pdf(job.id)).toEqual(before);
    vi.restoreAllMocks();
    expect((await resolve(job)).statusCode).toBe(200);
  },
);

it.each(['discard', 'delete', 'expiry'])(
  'cleans recovery assets on %s, including a failed first scan without a PDF',
  async (action) => {
    f = await fixture({ provider: new JamScanner() });
    const job = await start();
    const directory = f.service.job(job.id).scanRecovery!.directory;
    if (action === 'discard') expect((await resolve(job, 'discard')).statusCode).toBe(200);
    if (action === 'delete') await f.service.deleteJob(job.id);
    if (action === 'expiry') {
      const stored = f.service.job(job.id);
      stored.createdAt = new Date(Date.now() - 8 * 86400_000).toISOString();
      f.store.putJob(stored);
      expect((await resolve(job)).statusCode).toBe(410);
      await f.service.expireFiles();
    }
    await expect(access(directory)).rejects.toThrow();
    if (action !== 'delete') expect(f.service.job(job.id).scanRecovery).toBeUndefined();
  },
);

it.each([false, true])(
  'persists pending recovery across restart, including an interrupted recovery export (%s)',
  async (interrupted) => {
    f = await fixture({ provider: new JamScanner() });
    const job = await start();
    if (interrupted) {
      const stored = f.service.job(job.id);
      stored.status = 'processing';
      stored.scanWorkPath = join(stored.scanDirectory!, 'interrupted-export');
      await mkdir(stored.scanWorkPath!);
      await writeFile(join(stored.scanWorkPath, 'document.pdf'), 'partial');
      f.store.putJob(stored);
    }
    const dataDir = f.dataDir;
    await f.close(false);
    f = undefined;
    f = await fixture({ dataDir, provider: new JamScanner() });
    const restored = f.service.publicJob(f.service.job(job.id));
    expect(restored.recovery).toEqual(job.recovery);
    expect((await resolve(restored)).statusCode).toBe(200);
    expect((await PDFDocument.load(await pdf(job.id))).getPageCount()).toBe(2);
  },
);

it('requires authentication and validates recovery actions', async () => {
  f = await fixture({ provider: new JamScanner() });
  const job = await start();
  const url = `/api/scans/${job.id}/recovery`;
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url,
        headers: { 'x-openwebprint': '1' },
        payload: { revision: job.recovery!.revision, action: 'keep' },
      })
    ).statusCode,
  ).toBe(401);
  expect((await resolve(job, 'invalid')).statusCode).toBe(400);
});

it('excludes corrupt PNGs and gaps while preserving numeric acquisition order (controlled scanner)', async () => {
  class GappedScanner extends DemoProvider {
    override async scan(_device: Device, output: string) {
      for (const number of [10, 2])
        await sharp({
          create: { width: 100 + number, height: 200, channels: 3, background: '#fff' },
        })
          .png()
          .toFile(output.replace('%d', String(number)));
      const bad = await readFile(output.replace('%d', '2'));
      // Corrupt compressed IDAT bytes while retaining complete PNG framing/IEND.
      const idat = bad.indexOf(Buffer.from('IDAT'));
      bad.fill(0, idat + 4, idat + 10);
      await writeFile(output.replace('%d', '1'), bad);
      throw new Error('Controlled failure');
    }
  }
  f = await fixture({ provider: new GappedScanner() });
  const job = await start();
  expect(job.recovery?.pageNumbers).toEqual([2, 10]);
  expect((await resolve(job)).statusCode).toBe(200);
  const saved = await PDFDocument.load(await pdf(job.id));
  expect(saved.getPages().map((page) => page.getWidth())).toEqual([
    (102 * 72) / 150,
    (110 * 72) / 150,
  ]);
});

it('revalidates recovery originals before publishing and preserves the prior PDF if they are damaged', async () => {
  const scanner = new JamScanner();
  scanner.fail = false;
  f = await fixture({ provider: scanner });
  const original = await start();
  const before = await pdf(original.id);
  scanner.fail = true;
  const job = await start(original.id);
  await writeFile(f.service.job(job.id).scanRecovery!.pages[0].path, 'damaged after acquisition');
  const response = await resolve(job);
  expect(response.statusCode).toBe(422);
  expect(response.body).not.toContain(f.dataDir);
  expect(await pdf(job.id)).toEqual(before);
  expect(f.service.publicJob(f.service.job(job.id)).recovery).toEqual(job.recovery);
  expect((await resolve(job, 'discard')).statusCode).toBe(200);
  expect(await pdf(job.id)).toEqual(before);
});

it('discards new pages when cancellation arrives during recovery validation (controlled scanner)', async () => {
  f = await fixture({ provider: new JamScanner() });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const validating = new Promise<void>((r) => {
    entered = r;
  });
  const validate = documents.validateScanImage;
  vi.spyOn(documents, 'validateScanImage').mockImplementationOnce(async (path) => {
    await validate(path);
    entered();
    await gate;
  });
  const scanner = f.store.devices('demo').find((device) => device.kind === 'scanner')!;
  const job = f.service.scan(scanner.id, options);
  await validating;
  const directory = f.service.job(job.id).scanWorkPath!;
  const cancel = f.service.cancel(job.id);
  release();
  expect(await cancel).toMatchObject({ status: 'canceled', hasFile: false });
  expect(f.service.publicJob(f.service.job(job.id)).recovery).toBeUndefined();
  await expect(access(directory)).rejects.toThrow();
});
