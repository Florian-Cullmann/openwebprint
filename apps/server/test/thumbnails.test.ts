import { afterEach, expect, it, vi } from 'vitest';
import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import type { Device, Job, ScanPage } from '@openwebprint/shared';
import { DemoProvider } from '../src/providers/demo.js';
import { storedScanPages } from '../src/store.js';
import * as documents from '../src/documents.js';
import { fixture } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
  vi.restoreAllMocks();
});

// Large synthetic pages, with distinct colored regions to detect crop/rotation
// errors. No physical scanner or performance benchmark is involved.
class ThumbnailScanner extends DemoProvider {
  override async scan(_device: Device, output: string) {
    for (const [i, [width, height]] of [
      [2400, 3200],
      [3200, 1600],
    ].entries()) {
      await sharp({ create: { width, height, channels: 3, background: '#fafafa' } })
        .composite([
          {
            input: await sharp({
              create: { width: 800, height: 1200, channels: 3, background: '#2376a2' },
            })
              .png()
              .toBuffer(),
            left: 200,
            top: 100,
          },
        ])
        .png()
        .toFile(output.replace('%d', String(i + 1)));
    }
  }
}
async function start() {
  f = await fixture({ provider: new ThumbnailScanner() });
  const device = f.store.devices('demo').find((device) => device.kind === 'scanner')!;
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/scans',
    headers: f.headers,
    payload: { deviceId: device.id, options: { source: 'ADF', batch: true, resolution: 600 } },
  });
  expect(response.statusCode, response.body).toBe(202);
  await f.service.close();
  return (
    await f.app.inject({
      url: `/api/jobs/${response.json<Job>().id}`,
      headers: f.headers,
    })
  ).json<Job>();
}
async function thumbnail(job: Job, page = job.pages![0]) {
  const response = await f!.app.inject({
    url: `/api/scans/${job.id}/pages/${page.id}?thumbnail=1`,
    headers: f!.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.rawPayload;
}
async function edit(job: Job, pages: ScanPage[]) {
  const response = await f!.app.inject({
    method: 'POST',
    url: `/api/scans/${job.id}/pages`,
    headers: f!.headers,
    payload: { revision: job.scanRevision, pages },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Job>();
}
const cacheDirectory = (job: Job) => join(f!.service.filesDir, `${job.id}.thumbnails`);

it('bounds and coalesces on-demand thumbnails, retains originals and full-resolution PDF dimensions (synthetic multi-page scanner)', async () => {
  const job = await start();
  const stored = f!.service.job(job.id);
  const sources = storedScanPages(stored);
  expect(await sharp(stored.previewPath!).metadata()).toMatchObject({ width: 384, height: 512 });
  await expect(access(cacheDirectory(job))).rejects.toThrow();
  const render = vi.spyOn(documents, 'renderScanPage');
  const images = await Promise.all([thumbnail(job), thumbnail(job), thumbnail(job, job.pages![1])]);
  expect(render).toHaveBeenCalledTimes(2);
  expect(images[0]).toEqual(images[1]);
  for (const [image, size] of [
    [images[0], [384, 512]],
    [images[2], [512, 256]],
  ] as const)
    expect(await sharp(image).metadata()).toMatchObject({ width: size[0], height: size[1] });
  expect(await readFile(stored.previewPath!)).toEqual(images[0]);
  const gallery = await f!.app.inject({ url: `/api/jobs/${job.id}/preview`, headers: f!.headers });
  expect(gallery.rawPayload).toEqual(images[0]);
  expect(render).toHaveBeenCalledTimes(2);
  for (const name of await readdir(cacheDirectory(job)))
    expect((await stat(join(cacheDirectory(job), name))).mode & 0o777).toBe(0o600);
  expect((await stat(cacheDirectory(job))).mode & 0o777).toBe(0o700);
  const original = await f!.app.inject({
    url: `/api/scans/${job.id}/pages/${job.pages![0].id}`,
    headers: f!.headers,
  });
  expect(original.rawPayload).toEqual(await readFile(sources[0].path));
  expect(await sharp(original.rawPayload).metadata()).toMatchObject({ width: 2400, height: 3200 });
  const rendered = await f!.app.inject({
    url: `/api/scans/${job.id}/pages/${job.pages![0].id}?rendered=1`,
    headers: f!.headers,
  });
  expect(await sharp(rendered.rawPayload).metadata()).toMatchObject({ width: 2400, height: 3200 });
  const pdf = await PDFDocument.load(await readFile(stored.filePath!));
  expect(pdf.getPageCount()).toBe(2);
  const page = pdf.getPage(0);
  expect(page.getWidth()).toBeCloseTo((2400 * 72) / 600, 6);
  expect(page.getHeight()).toBeCloseTo((3200 * 72) / 600, 6);
  const resources = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const embedded = resources.lookup(resources.keys()[0]) as PDFRawStream;
  expect(embedded.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(2400);
  expect(embedded.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()).toBe(3200);
});

it('reuses unchanged pages across reorder/restart and prunes only edited or removed variants (synthetic multi-page scanner)', async () => {
  let job = await start();
  const original = storedScanPages(f!.service.job(job.id))[0];
  await thumbnail(job);
  await thumbnail(job, job.pages![1]);
  const cached = await readdir(cacheDirectory(job));
  const times = await Promise.all(
    cached.map(async (name) => (await stat(join(cacheDirectory(job), name))).mtimeMs),
  );
  job = await edit(job, [...job.pages!].reverse());
  const render = vi.spyOn(documents, 'renderScanPage');
  await thumbnail(job);
  await thumbnail(job, job.pages![1]);
  expect(render).not.toHaveBeenCalled();
  expect(await readdir(cacheDirectory(job))).toEqual(cached);
  expect(
    await Promise.all(
      cached.map(async (name) => (await stat(join(cacheDirectory(job), name))).mtimeMs),
    ),
  ).toEqual(times);
  const appended = await f!.app.inject({
    method: 'POST',
    url: '/api/scans',
    headers: f!.headers,
    payload: {
      deviceId: job.deviceId,
      jobId: job.id,
      options: { source: 'ADF', batch: true, resolution: 600 },
    },
  });
  expect(appended.statusCode, appended.body).toBe(202);
  await f!.service.close();
  job = (await f!.app.inject({ url: `/api/jobs/${job.id}`, headers: f!.headers })).json<Job>();
  expect(job.pages).toHaveLength(4);
  await thumbnail(job);
  await thumbnail(job, job.pages![1]);
  expect(render).not.toHaveBeenCalled();
  expect(await readdir(cacheDirectory(job))).toEqual(cached);
  const rejected = await f!.app.inject({
    method: 'POST',
    url: `/api/scans/${job.id}/pages`,
    headers: f!.headers,
    payload: {
      revision: job.scanRevision,
      pages: [
        { ...job.pages![0], crop: { x: 0, y: 0, width: 9999, height: 9999 } },
        ...job.pages!.slice(1),
      ],
    },
  });
  expect(rejected.statusCode).toBe(400);
  expect(await readdir(cacheDirectory(job))).toEqual(cached);
  await thumbnail(job);
  expect(render).not.toHaveBeenCalled();
  const crop = { x: 200, y: 100, width: 1200, height: 1800 };
  job = await edit(job, [job.pages![0], { ...job.pages![1], rotation: 90, crop }]);
  expect(await readdir(cacheDirectory(job))).toHaveLength(1);
  await thumbnail(job);
  expect(render).not.toHaveBeenCalled();
  const image = await thumbnail(job, job.pages![1]);
  expect(render).toHaveBeenCalledTimes(1);
  const cropped = await sharp(original.path)
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .png()
    .toBuffer();
  const expected = await sharp(cropped)
    .rotate(90)
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const pixels = await sharp(image).raw().toBuffer();
  const expectedPixels = await sharp(expected).raw().toBuffer();
  expect(pixels.length).toBe(expectedPixels.length);
  // Resize-before-rotation can round/interpolate edge pixels differently from
  // the independent rotate-before-resize reference, but content must agree.
  const meanDifference =
    pixels.reduce((sum, value, i) => sum + Math.abs(value - expectedPixels[i]), 0) / pixels.length;
  expect(meanDifference).toBeLessThan(0.5);
  expect(await sharp(image).metadata()).toMatchObject({ width: 512, height: 341 });
  expect(await sharp(original.path).metadata()).toMatchObject({ width: 2400, height: 3200 });
  const directory = f!.dataDir;
  await writeFile(join(cacheDirectory(job), 'abandoned.tmp'), 'incomplete cache write');
  await f!.close(false);
  f = undefined;
  f = await fixture({ dataDir: directory });
  expect(await readdir(cacheDirectory(job))).toHaveLength(2);
  render.mockClear();
  expect(await thumbnail(job, job.pages![1])).toEqual(image);
  expect(render).not.toHaveBeenCalled();
  job = await edit(job, [job.pages![0]]);
  expect(await readdir(cacheDirectory(job))).toHaveLength(1);
  const missing = await f.app.inject({
    url: `/api/scans/${job.id}/pages/${original.id}?thumbnail=1`,
    headers: f.headers,
  });
  expect(missing.statusCode).toBe(404);
});

it('bounds old full-size gallery previews and caches legacy pages without replacing their originals', async () => {
  const job = await start();
  const stored = f!.service.job(job.id);
  const original = storedScanPages(stored)[0].path;
  stored.scanPages = undefined;
  stored.previewPath = original;
  f!.store.putJob(stored);
  const render = vi.spyOn(documents, 'renderScanPage');
  const legacyPage = { id: job.id, rotation: 0 as const };
  const image = await thumbnail(job, legacyPage);
  const preview = await f!.app.inject({ url: `/api/jobs/${job.id}/preview`, headers: f!.headers });
  expect(preview.rawPayload).toEqual(image);
  expect(render).toHaveBeenCalledTimes(1);
  expect(await sharp(image).metadata()).toMatchObject({ width: 384, height: 512 });
  expect(await sharp(original).metadata()).toMatchObject({ width: 2400, height: 3200 });
});

it.each(['delete', 'expire', 'demo removal'])(
  'removes all generated assets on %s (synthetic multi-page scanner)',
  async (action) => {
    const job = await start();
    await Promise.all(job.pages!.map((page) => thumbnail(job, page)));
    if (action === 'delete') await f!.service.deleteJob(job.id);
    else if (action === 'demo removal') await f!.workspace.removeDemo();
    else {
      const stored = f!.service.job(job.id);
      stored.createdAt = new Date(Date.now() - 8 * 86400_000).toISOString();
      f!.store.putJob(stored);
      await f!.service.expireFiles();
    }
    expect(await readdir(join(f!.dataDir, 'files'))).toEqual([]);
  },
);

it('waits for an in-flight thumbnail before deleting and cannot recreate deleted assets', async () => {
  const job = await start();
  const realRender = documents.renderScanPage;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(documents, 'renderScanPage').mockImplementation(async (...args) => {
    await gate;
    return realRender(...args);
  });
  const pending = f!.service.scanThumbnail(job.id);
  const deleting = f!.service.deleteJob(job.id);
  try {
    expect(() => f!.service.scanThumbnail(job.id)).toThrow('Page unavailable');
  } finally {
    release();
  }
  await pending;
  await deleting;
  expect(await readdir(f!.service.filesDir)).toEqual([]);
  expect(() => f!.service.scanThumbnail(job.id)).toThrow();
});
