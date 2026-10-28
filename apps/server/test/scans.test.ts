import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import type { Device, Job, ScanOptions } from '@openwebprint/shared';
import { DemoProvider } from '../src/providers/demo.js';
import { publicJob, storedScanPages } from '../src/store.js';
import { fixture } from './helpers.js';
import * as documents from '../src/documents.js';
import { AppError } from '../src/errors.js';
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
// Small numbered images keep page-removal tests independent of physical hardware.
class RemovalScanner extends DemoProvider {
  override async scan(_device: Device, output: string) {
    for (let i = 1; i <= 3; i++)
      await sharp({
        create: { width: 100 + i, height: 200, channels: 3, background: '#ffffff' },
      })
        .png()
        .toFile(output.replace('%d', String(i)));
  }
}
it('removes pages, publishes matching previews/PDFs, cleans obsolete files, and persists the remaining edits (stubbed scanner)', async () => {
  f = await fixture({ provider: new RemovalScanner() });
  const original = await start(undefined, { source: 'ADF', batch: true });
  const previous = f.service.job(original.id);
  const sources = storedScanPages(previous);
  const retained = [
    { ...original.pages![2], rotation: 90 as const, crop: { x: 2, y: 3, width: 70, height: 120 } },
    original.pages![1],
  ];
  const response = await edit(original, retained);
  expect(response.statusCode, response.body).toBe(200);
  const saved = response.json<Job>();
  expect(saved.pages).toEqual(retained);
  expect(saved.scanRevision).not.toBe(original.scanRevision);
  const pdf = await PDFDocument.load(await download(saved));
  expect(pdf.getPageCount()).toBe(2);
  expect(pdf.getPage(0).getRotation().angle).toBe(90);
  expect(pdf.getPage(0).getWidth()).toBeCloseTo((70 * 72) / 300, 6);
  expect(pdf.getPage(1).getWidth()).toBeCloseTo((102 * 72) / 300, 6);
  const preview = await f.app.inject({ url: `/api/jobs/${saved.id}/preview`, headers: f.headers });
  expect(preview.statusCode, preview.body).toBe(200);
  expect(await sharp(preview.rawPayload).metadata()).toMatchObject({ width: 120, height: 70 });
  for (const path of [previous.filePath!, previous.previewPath!, sources[0].path])
    await expect(access(path)).rejects.toThrow();
  for (const source of sources.slice(1)) await access(source.path);
  expect(
    (
      await f.app.inject({
        url: `/api/scans/${saved.id}/pages/${sources[0].id}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
  // A stale edit must not resurrect removed pages or remove more pages.
  expect((await edit(original, [original.pages![1]])).statusCode).toBe(409);
  const last = await edit(saved, [retained[1]]);
  expect(last.statusCode).toBe(200);
  const final = last.json<Job>();
  expect((await edit(final, [])).statusCode).toBe(400);
  expect(() => f!.service.editScan(final.id, final.scanRevision!, [])).toThrow('at least one');
  expect((await PDFDocument.load(await download(final))).getPageCount()).toBe(1);
  const directory = f.dataDir;
  await f.close(false);
  f = await fixture({ dataDir: directory });
  expect(publicJob(f.service.job(final.id)).pages).toEqual(final.pages);
  expect((await PDFDocument.load(await download(final))).getPageCount()).toBe(1);
  expect((await start(final.id)).pages).toHaveLength(2);
});

it.each(['conversion', 'storage'])(
  'preserves every original file on page-removal %s failure and locks concurrent operations',
  async (failure) => {
    f = await fixture({ provider: new RemovalScanner() });
    const job = await start(undefined, { source: 'ADF', batch: true });
    const stored = f.service.job(job.id);
    const paths = [
      stored.filePath!,
      stored.previewPath!,
      ...storedScanPages(stored).map((p) => p.path),
    ];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staged!: () => void;
    const started = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const exportPages = documents.exportScanPages;
    const exporter = vi
      .spyOn(documents, 'exportScanPages')
      .mockImplementationOnce(async (...args) => {
        await exportPages(...args);
        staged();
        await gate;
        if (failure === 'conversion') throw new AppError(422, 'Could not rebuild the document.');
      });
    const putJob = f.store.putJob.bind(f.store);
    let rejectPublication = failure === 'storage';
    const persistence = vi.spyOn(f.store, 'putJob').mockImplementation((next) => {
      if (
        rejectPublication &&
        next.status === 'completed' &&
        next.scanRevision !== job.scanRevision
      ) {
        rejectPublication = false;
        throw new AppError(500, 'Could not save the document.');
      }
      putJob(next);
    });
    const pending = edit(job, job.pages!.slice(1));
    try {
      await started;
      expect((await edit(job, job.pages!.slice(1))).statusCode).toBe(409);
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
      expect((await pending).statusCode).toBe(failure === 'conversion' ? 422 : 500);
      expect(publicJob(f.service.job(job.id))).toMatchObject({
        status: 'completed',
        pages: job.pages,
        scanRevision: job.scanRevision,
      });
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
      expect(await readdir(stored.scanDirectory!)).toHaveLength(1);
    } finally {
      release();
      await pending;
      exporter.mockRestore();
      persistence.mockRestore();
    }
  },
);

it('keeps a retained page source when removed pages share the same image (legacy fixture)', async () => {
  f = await fixture({ provider: new RemovalScanner() });
  const job = await start(undefined, { source: 'ADF', batch: true });
  const stored = f.service.job(job.id);
  const pages = storedScanPages(stored);
  stored.scanPages = [pages[0], { ...pages[0], id: pages[1].id }, pages[2]];
  f.store.putJob(stored);
  expect((await edit(job, job.pages!.slice(1))).statusCode).toBe(200);
  await access(pages[0].path);
  expect((await PDFDocument.load(await download(job))).getPageCount()).toBe(2);
});
it('keeps a successfully published deletion when an obsolete file cannot be unlinked (storage fixture)', async () => {
  f = await fixture({ provider: new RemovalScanner() });
  const job = await start(undefined, { source: 'ADF', batch: true });
  const stored = f.service.job(job.id);
  // An unexpected directory at the previous preview path simulates a cleanup error.
  const previousPreview = stored.previewPath!;
  await unlink(previousPreview);
  await mkdir(previousPreview);
  await writeFile(join(previousPreview, 'blocked'), 'cleanup fixture');
  const response = await edit(job, job.pages!.slice(1));
  expect(response.statusCode, response.body).toBe(200);
  const saved = response.json<Job>();
  expect(saved.pages).toEqual(job.pages!.slice(1));
  expect(saved.error).toContain('document was saved');
  expect(saved.error).not.toContain(f.dataDir);
  expect((await PDFDocument.load(await download(saved))).getPageCount()).toBe(2);
  expect(publicJob(f.service.job(job.id))).toMatchObject({
    pages: saved.pages,
    scanRevision: saved.scanRevision,
  });
  await f.service.deleteJob(job.id);
  expect(await readdir(f.service.filesDir)).toEqual([]);
});
it('keeps per-page physical dimensions across mixed-resolution appends, edits, and restart (stubbed scanner)', async () => {
  const sizes = [
    { widthMm: 148, heightMm: 210 },
    { widthMm: 215.9, heightMm: 279.4 },
    { widthMm: 210, heightMm: 297 },
  ];
  class SizedScanner extends DemoProvider {
    page = 0;
    override async scan(_device: Device, output: string, options: ScanOptions) {
      const size = sizes[this.page++];
      await sharp({
        create: {
          width: Math.round((size.widthMm * options.resolution) / 25.4),
          height: Math.round((size.heightMm * options.resolution) / 25.4),
          channels: 3,
          background: '#fff',
        },
      })
        .png() // No image DPI: acquisition settings must be captured per page.
        .toFile(output);
    }
  }
  f = await fixture({ provider: new SizedScanner() });
  let job = await start(undefined, { resolution: 150 });
  const firstSize = (await PDFDocument.load(await download(job))).getPage(0).getSize();
  job = await start(job.id, { resolution: 300 });
  job = await start(job.id, { resolution: 150 });
  const pdf = await PDFDocument.load(await download(job));
  expect(pdf.getPage(0).getSize()).toEqual(firstSize);
  for (const [index, page] of pdf.getPages().entries()) {
    expect((page.getWidth() * 25.4) / 72).toBeCloseTo(sizes[index].widthMm, 1);
    expect((page.getHeight() * 25.4) / 72).toBeCloseTo(sizes[index].heightMm, 1);
  }
  expect(storedScanPages(f.service.job(job.id)).map((page) => page.resolution)).toEqual([
    150, 300, 150,
  ]);
  expect(job.pages!.every((page) => !('resolution' in page))).toBe(true);
  const directory = f.dataDir;
  await f.close(false);
  f = undefined;
  f = await fixture({ dataDir: directory });
  const crop = { x: 12, y: 24, width: 300, height: 450 };
  const reordered = [...job.pages!].reverse();
  reordered[1] = { ...reordered[1], crop, rotation: 90 };
  const response = await edit(job, reordered);
  expect(response.statusCode, response.body).toBe(200);
  job = response.json<Job>();
  const edited = await PDFDocument.load(await download(job));
  expect(edited.getPage(0).getSize()).toEqual(pdf.getPage(2).getSize());
  expect(edited.getPage(2).getSize()).toEqual(firstSize);
  expect(edited.getPage(1).getWidth()).toBeCloseTo((crop.width * 72) / 300, 6);
  expect(edited.getPage(1).getHeight()).toBeCloseTo((crop.height * 72) / 300, 6);
  expect(edited.getPage(1).getRotation().angle).toBe(90);
  expect(storedScanPages(f.service.job(job.id)).map((page) => page.resolution)).toEqual([
    150, 300, 150,
  ]);
  // Editing cannot supply a new acquisition resolution for an existing page.
  const tampered = await edit(
    job,
    job.pages!.map((page) => ({ ...page, resolution: 600 })),
  );
  expect(tampered.statusCode).toBe(200);
  expect((await PDFDocument.load(await download(job))).getPage(1).getSize()).toEqual(
    edited.getPage(1).getSize(),
  );
});

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
    [],
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
    error: 'The operation failed. Check the server logs.',
  });
  expect(await download(job)).toEqual(before);
  expect(failed.recovery?.pageNumbers).toEqual([1]);
  await f.service.resolveRecovery(job.id, failed.recovery!.revision, 'discard');
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
  const legacySize = (await PDFDocument.load(await download(legacy))).getPage(0).getSize();
  const appended = await start(job.id, { resolution: 150 });
  expect(appended.pages).toHaveLength(2);
  expect((await PDFDocument.load(await download(legacy))).getPage(0).getSize()).toEqual(legacySize);
  expect(storedScanPages(f.service.job(job.id))[0].path).toBe(legacyPreview);
  expect(storedScanPages(f.service.job(job.id))[0].resolution).toBeUndefined();
  expect((await edit(appended, appended.pages!.slice(1))).statusCode).toBe(200);
  await expect(access(legacyPreview)).rejects.toThrow();
  expect((await PDFDocument.load(await download(appended))).getPageCount()).toBe(1);
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
  const job = await start((await start()).id);
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
    expect((await edit(job, job.pages!.slice(1))).statusCode).toBe(409);
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
    expect((await PDFDocument.load(await download(job))).getPageCount()).toBe(2);
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

it('crops original pixels before every rotation, persists edits on restart, and resets without degrading the source (stubbed scanner)', async () => {
  const width = 120;
  const height = 160;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = x;
      pixels[offset + 1] = y;
      pixels[offset + 2] = (x + y) % 256;
    }
  const original = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  class PatternScanner extends DemoProvider {
    override async scan(_device: Device, output: string) {
      await writeFile(output, original);
    }
  }
  f = await fixture({ provider: new PatternScanner() });
  let job = await start();
  const source = storedScanPages(f.service.job(job.id))[0].path;
  const crop = { x: 13, y: 23, width: 61, height: 101 };
  const cropped = sharp(original).extract({
    left: crop.x,
    top: crop.y,
    width: crop.width,
    height: crop.height,
  });
  const expectedPixels = await cropped.clone().raw().toBuffer();
  const originalPdf = await download(job);
  for (const rotation of [0, 90, 180, 270] as const) {
    const previous = job;
    const response = await edit(job, [{ ...job.pages![0], crop, rotation }]);
    expect(response.statusCode, response.body).toBe(200);
    job = response.json<Job>();
    expect(job.pages![0]).toMatchObject({ crop, rotation });
    expect((await edit(previous)).statusCode).toBe(409);
    const preview = await f.app.inject({ url: `/api/jobs/${job.id}/preview`, headers: f.headers });
    expect(preview.statusCode, preview.body).toBe(200);
    const expected = await cropped
      .clone()
      .rotate(rotation)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(await sharp(preview.rawPayload).raw().toBuffer({ resolveWithObject: true })).toEqual(
      expected,
    );
    const thumbnail = await f.app.inject({
      url: `/api/scans/${job.id}/pages/${job.pages![0].id}?rendered=1`,
      headers: f.headers,
    });
    expect(await sharp(thumbnail.rawPayload).raw().toBuffer()).toEqual(expected.data);
    const pdf = await PDFDocument.load(await download(job));
    const page = pdf.getPage(0);
    const scale = 72 / 300;
    expect(page.getWidth()).toBeCloseTo(crop.width * scale);
    expect(page.getHeight()).toBeCloseTo(crop.height * scale);
    expect(page.getRotation().angle).toBe(rotation);
    const images = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const image = images.lookup(images.keys()[0]) as PDFRawStream;
    expect(image.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(crop.width);
    expect(image.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()).toBe(crop.height);
    expect(inflateSync(image.contents)).toEqual(expectedPixels);
    expect(await readFile(source)).toEqual(original);
  }
  const directory = f.dataDir;
  await f.close(false);
  f = undefined;
  f = await fixture({ dataDir: directory });
  expect(publicJob(f.service.job(job.id))).toEqual(job);
  const reset = await edit(job, [{ id: job.pages![0].id, rotation: 0 }]);
  expect(reset.statusCode).toBe(200);
  job = reset.json<Job>();
  expect(job.pages![0]).not.toHaveProperty('crop');
  const resetPdf = await PDFDocument.load(await download(job));
  const initialPdf = await PDFDocument.load(originalPdf);
  expect(resetPdf.getPage(0).getSize()).toEqual(initialPdf.getPage(0).getSize());
  const resetPreview = await f.app.inject({
    url: `/api/jobs/${job.id}/preview`,
    headers: f.headers,
  });
  expect(await sharp(resetPreview.rawPayload).raw().toBuffer()).toEqual(pixels);
  expect(await readFile(source)).toEqual(original);
  const expired = f.service.job(job.id);
  expired.createdAt = new Date(Date.now() - 8 * 86400_000).toISOString();
  f.store.putJob(expired);
  await f.service.expireFiles();
  expect(await readdir(f.service.filesDir)).toEqual([]);
});

it('rejects invalid crops without publishing changes and preserves the previous document on conversion failure', async () => {
  f = await fixture();
  let job = await start();
  const source = storedScanPages(f.service.job(job.id))[0].path;
  const original = await readFile(source);
  const { width, height } = await sharp(original).metadata();
  const crop = { x: 1, y: 2, width: width! - 2, height: height! - 4 };
  const saved = await edit(job, [{ ...job.pages![0], crop }]);
  expect(saved.statusCode).toBe(200);
  job = saved.json<Job>();
  const before = await download(job);
  for (const invalid of [
    { ...crop, x: -1 },
    { ...crop, y: -1 },
    { ...crop, width: 0 },
    { ...crop, height: -1 },
    { ...crop, x: 0.5 },
    { ...crop, width: null },
    { ...crop, y: 'NaN' },
    { ...crop, x: Number.MAX_VALUE },
    { ...crop, width: Infinity },
    { ...crop, x: width! },
    { ...crop, y: height! },
    { ...crop, width: width! },
    { ...crop, height: height! },
  ]) {
    const response = await edit(job, [{ ...job.pages![0], crop: invalid } as never]);
    expect(response.statusCode, response.body).toBe(400);
    expect(publicJob(f.service.job(job.id))).toMatchObject({
      pages: job.pages,
      scanRevision: job.scanRevision,
      status: 'completed',
    });
  }
  expect(await download(job)).toEqual(before);
  expect(await readFile(source)).toEqual(original);
  await unlink(source);
  const failed = await edit(job, [{ ...job.pages![0], crop: { ...crop, width: 1 } }]);
  expect(failed.statusCode).toBe(422);
  expect(failed.body).not.toContain(f.dataDir);
  expect(await download(job)).toEqual(before);
  expect(publicJob(f.service.job(job.id))).toMatchObject({
    pages: job.pages,
    scanRevision: job.scanRevision,
    status: 'completed',
  });
  await f.service.deleteJob(job.id);
  expect(await readdir(f.service.filesDir)).toEqual([]);
});

it('locks a crop while exporting and discards staged output if publication fails', async () => {
  f = await fixture();
  const job = await start();
  const before = await download(job);
  const previewPath = f.service.job(job.id).previewPath!;
  const beforePreview = await readFile(previewPath);
  const exportPages = documents.exportScanPages;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let staged!: () => void;
  const started = new Promise<void>((resolve) => {
    staged = resolve;
  });
  const exporter = vi
    .spyOn(documents, 'exportScanPages')
    .mockImplementationOnce(async (...args) => {
      // Fail after generating complete staged files, but before committing the new revision.
      await exportPages(...args);
      staged();
      await gate;
      throw new AppError(422, 'Could not publish the cropped document.');
    });
  const pending = edit(job, [{ ...job.pages![0], crop: { x: 1, y: 2, width: 30, height: 40 } }]);
  try {
    await started;
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
    expect((await pending).statusCode).toBe(422);
    expect(publicJob(f.service.job(job.id))).toMatchObject({
      status: 'completed',
      pages: job.pages,
      scanRevision: job.scanRevision,
    });
    expect(await download(job)).toEqual(before);
    expect(await readFile(previewPath)).toEqual(beforePreview);
    expect(await readdir(f.service.job(job.id).scanDirectory!)).toHaveLength(1);
  } finally {
    release();
    exporter.mockRestore();
    await pending;
  }
});
