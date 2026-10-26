import { afterEach, expect, it } from 'vitest';
import { access, mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import type { Device, Job, ScanOptions } from '@openwebprint/shared';
import { DemoProvider } from '../src/providers/demo.js';
import { publicJob, storedScanPages } from '../src/store.js';
import { fixture } from './helpers.js';
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
async function start(jobId?: string, options: Partial<ScanOptions> = {}) {
  const device = f!.store.devices('demo').find((d) => d.kind === 'scanner')!;
  const response = await f!.app.inject({
    method: 'POST',
    url: '/api/scans',
    headers: f!.headers,
    payload: { deviceId: device.id, jobId, options },
  });
  expect(response.statusCode, response.body).toBe(202);
  await f!.service.close();
  return publicJob(f!.service.job(response.json<Job>().id));
}
async function edit(job: Job, pages = job.pages!, revision = job.scanRevision!) {
  return f!.app.inject({
    method: 'POST',
    url: `/api/scans/${job.id}/pages`,
    headers: f!.headers,
    payload: { pages, revision },
  });
}
async function download(job: Job) {
  const response = await f!.app.inject({ url: `/api/jobs/${job.id}/pdf`, headers: f!.headers });
  expect(response.statusCode).toBe(200);
  return response.rawPayload;
}
it('appends flatbed and feeder pages to one PDF and persists the actual page order and rotations (stubbed scanner)', async () => {
  class NumberedScanner extends DemoProvider {
    page = 0;
    override async scan(_device: Device, output: string, options: ScanOptions) {
      for (let i = 1; i <= (options.batch ? 3 : 1); i++)
        await sharp({
          create: { width: 100 + ++this.page, height: 200, channels: 3, background: '#ffffff' },
        })
          .png()
          .toFile(output.replace('%d', String(i)));
    }
  }
  f = await fixture({ provider: new NumberedScanner() });
  let job = await start();
  const id = job.id;
  job = await start(id);
  job = await start(id, { source: 'ADF', batch: true });
  expect(job.id).toBe(id);
  expect(job.pages).toHaveLength(5);
  expect(f.store.jobs('demo')).toHaveLength(1);
  expect(JSON.stringify(job)).not.toContain(f.dataDir);
  expect(job).not.toHaveProperty('scanPages');
  const reordered = [...job.pages!]
    .reverse()
    .map((page, i) => ({ ...page, rotation: i === 0 ? (90 as const) : (0 as const) }));
  const saved = await edit(job, reordered);
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json<Job>().pages).toEqual(reordered);
  const pdf = await PDFDocument.load(await download(job));
  expect(pdf.getPageCount()).toBe(5);
  expect(pdf.getPages().map((page) => page.getRotation().angle)).toEqual([90, 0, 0, 0, 0]);
  const widths = pdf.getPages().map((page) => {
    const images = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    return (images.lookup(images.keys()[0]) as PDFRawStream).dict
      .lookup(PDFName.of('Width'), PDFNumber)
      .asNumber();
  });
  expect(widths).toEqual([105, 104, 103, 102, 101]);
  const preview = await f.app.inject({ url: `/api/jobs/${id}/preview`, headers: f.headers });
  expect(await sharp(preview.rawPayload).metadata()).toMatchObject({ width: 200, height: 105 });
  expect((await edit(job, reordered)).statusCode).toBe(409);
  const latest = saved.json<Job>();
  for (const pages of [
    reordered.slice(1),
    [...reordered.slice(1), reordered[1]],
    [{ ...reordered[0], id: randomUUID() }, ...reordered.slice(1)],
  ])
    expect((await edit(latest, pages)).statusCode).toBe(400);
  expect(
    (await edit(latest, [{ ...reordered[0], rotation: 45 } as never, ...reordered.slice(1)]))
      .statusCode,
  ).toBe(400);
  const pageUrl = `/api/scans/${id}/pages/${reordered[0].id}`;
  expect((await f.app.inject(pageUrl)).statusCode).toBe(401);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/scans/${id}/pages`,
        headers: { 'x-openwebprint': '1' },
        payload: { pages: reordered, revision: latest.scanRevision },
      })
    ).statusCode,
  ).toBe(401);
  expect((await f.app.inject({ url: pageUrl, headers: f.headers })).statusCode).toBe(200);
  expect(
    (await f.app.inject({ url: `/api/scans/${id}/pages/${randomUUID()}`, headers: f.headers }))
      .statusCode,
  ).toBe(404);
  await f.service.deleteJob(id);
  expect(await readdir(f.service.filesDir)).toEqual([]);
  expect((await f.app.inject({ url: pageUrl, headers: f.headers })).statusCode).toBe(404);
});
it('keeps the previous PDF and all pages when a follow-up scan fails, including after writing an image', async () => {
  class DisconnectingScanner extends DemoProvider {
    fail = false;
    override async scan(device: Device, output: string, options: ScanOptions) {
      await super.scan(device, output, options);
      if (this.fail) throw new Error('Scanner disconnected');
    }
  }
  const provider = new DisconnectingScanner();
  f = await fixture({ provider });
  const job = await start();
  const before = await download(job);
  provider.fail = true;
  const failed = await start(job.id);
  expect(failed).toMatchObject({
    status: 'completed',
    hasFile: true,
    pages: job.pages,
    scanRevision: job.scanRevision,
    error: 'Scanner disconnected',
  });
  expect(await download(job)).toEqual(before);
  expect(await readdir(f.service.job(job.id).scanDirectory!)).toHaveLength(1);
  provider.fail = false;
  expect((await start(job.id)).pages).toHaveLength(2);
});
it('recovers an interrupted append after restart, preserving committed pages and removing partial files', async () => {
  f = await fixture();
  const job = await start();
  const before = await download(job);
  const stored = f.service.job(job.id);
  stored.status = 'processing';
  stored.scanWorkPath = join(stored.scanDirectory!, randomUUID());
  await mkdir(stored.scanWorkPath);
  await writeFile(join(stored.scanWorkPath, 'page-1.png.part'), 'private unfinished image');
  f.store.putJob(stored);
  const dir = f.dataDir;
  await f.close(false);
  f = undefined;
  f = await fixture({ dataDir: dir });
  expect(f.service.job(job.id)).toMatchObject({ status: 'completed', hasFile: true });
  expect(f.service.job(job.id).error).toContain('restarted');
  expect(await download(job)).toEqual(before);
  await expect(access(stored.scanWorkPath)).rejects.toThrow();
  const expired = f.service.job(job.id);
  expired.createdAt = new Date(Date.now() - 8 * 86400_000).toISOString();
  f.store.putJob(expired);
  await f.service.expireFiles();
  expect(await readdir(f.service.filesDir)).toEqual([]);
});
it('opens and edits legacy single-page scans and removes their original files with demo data', async () => {
  f = await fixture();
  const original = await start();
  const job = f.service.job(original.id);
  const legacyPdf = join(f.service.filesDir, `${job.id}.pdf`);
  const legacyPreview = join(f.service.filesDir, `${job.id}.png`);
  await writeFile(legacyPdf, await readFile(job.filePath!));
  await writeFile(legacyPreview, await readFile(job.previewPath!));
  await f.service.removeFiles(job);
  Object.assign(job, {
    filePath: legacyPdf,
    previewPath: legacyPreview,
    hasFile: true,
    scanRevision: undefined,
  });
  f.store.putJob(job);
  const legacy = publicJob(job);
  expect(legacy.pages).toEqual([{ id: job.id, rotation: 0 }]);
  expect((await edit(legacy, [{ id: job.id, rotation: 90 }])).statusCode).toBe(200);
  expect((await start(job.id)).pages).toHaveLength(2);
  expect(storedScanPages(f.service.job(job.id))[0].path).toBe(legacyPreview);
  await f.workspace.removeDemo();
  expect(await readdir(f.service.filesDir)).toEqual([]);
});
it('limits feeder requests to the remaining document capacity (stubbed scanner)', async () => {
  class TinyScanner extends DemoProvider {
    requestedLimit = 0;
    override async scan(_device: Device, output: string, _options: ScanOptions, pageLimit = 100) {
      this.requestedLimit = pageLimit;
      for (let i = 1; i <= Math.min(3, pageLimit); i++)
        await sharp({ create: { width: 10, height: 20, channels: 3, background: '#fff' } })
          .png()
          .toFile(output.replace('%d', String(i)));
    }
  }
  const provider = new TinyScanner();
  f = await fixture({ provider });
  let job = await start(undefined, { source: 'ADF', batch: true });
  // Reusing the same private image keeps this boundary test small.
  const stored = f.service.job(job.id);
  const page = storedScanPages(stored)[0];
  stored.scanPages = Array.from({ length: 99 }, () => ({ ...page, id: randomUUID() }));
  f.store.putJob(stored);
  job = await start(job.id, { source: 'ADF Duplex', batch: true });
  expect(provider.requestedLimit).toBe(1);
  expect(job.pages).toHaveLength(100);
  expect((await PDFDocument.load(await download(job))).getPageCount()).toBe(100);
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/scans',
    headers: f.headers,
    payload: { deviceId: job.deviceId, jobId: job.id, options: {} },
  });
  expect(response.statusCode).toBe(400);
});

it('rejects concurrent edits/deletion during an append and rejects empty batches without losing pages', async () => {
  let release!: () => void;
  let block = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class EmptyScanner extends DemoProvider {
    override async scan(device: Device, output: string, options: ScanOptions) {
      if (block) {
        await gate;
        return;
      }
      await super.scan(device, output, options);
    }
  }
  f = await fixture({ provider: new EmptyScanner() });
  const job = await start();
  block = true;
  try {
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/scans',
          headers: f.headers,
          payload: {
            deviceId: job.deviceId,
            jobId: job.id,
            options: { source: 'ADF', batch: true },
          },
        })
      ).statusCode,
    ).toBe(202);
    expect((await edit(job)).statusCode).toBe(409);
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/scans',
          headers: f.headers,
          payload: { deviceId: job.deviceId, jobId: job.id, options: {} },
        })
      ).statusCode,
    ).toBe(409);
    release();
    await f.service.close();
    expect(publicJob(f.service.job(job.id))).toMatchObject({
      status: 'completed',
      pages: job.pages,
      scanRevision: job.scanRevision,
    });
    expect(f.service.job(job.id).error).toContain('No pages');
    expect((await PDFDocument.load(await download(job))).getPageCount()).toBe(1);
  } finally {
    release();
  }
});

it('preserves the saved PDF and keeps private file paths out of conversion failures', async () => {
  f = await fixture();
  const job = await start();
  const before = await download(job);
  await unlink(storedScanPages(f.service.job(job.id))[0].path);
  const response = await edit(job, [{ ...job.pages![0], rotation: 90 }]);
  expect(response.statusCode).toBe(422);
  expect(response.body).not.toContain(f.dataDir);
  expect(response.json().error).toContain('could not be converted');
  expect(publicJob(f.service.job(job.id))).toMatchObject({
    status: 'completed',
    pages: job.pages,
    scanRevision: job.scanRevision,
  });
  expect(await download(job)).toEqual(before);
  expect(f.service.job(job.id).error).not.toContain(f.dataDir);
});
