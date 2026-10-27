import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { exportScanPages } from '../src/documents.js';
import type { StoredScanPage } from '../src/store.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'owp-dimensions-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function exportPage(source: Partial<StoredScanPage> = {}) {
  const pdfPath = join(directory, 'document.pdf');
  await exportScanPages(
    [{ id: 'page', rotation: 0, path: join(directory, 'page.png'), ...source }],
    pdfPath,
    join(directory, 'preview.png'),
  );
  return (await PDFDocument.load(await readFile(pdfPath))).getPage(0);
}

it.each([
  { paper: 'A5', widthMm: 148, heightMm: 210, resolution: 150 },
  { paper: 'A4', widthMm: 210, heightMm: 297, resolution: 300 },
  { paper: 'Letter', widthMm: 215.9, heightMm: 279.4, resolution: 600 },
])('exports $paper at its physical size at $resolution dpi (synthetic PNG)', async (size) => {
  const width = Math.round((size.widthMm * size.resolution) / 25.4);
  const height = Math.round((size.heightMm * size.resolution) / 25.4);
  await sharp({ create: { width, height, channels: 3, background: '#fff' } })
    .png()
    .toFile(join(directory, 'page.png'));
  const page = await exportPage({ resolution: size.resolution });
  expect(page.getWidth()).toBeCloseTo((width * 72) / size.resolution, 6);
  expect(page.getHeight()).toBeCloseTo((height * 72) / size.resolution, 6);
  expect((page.getWidth() * 25.4) / 72).toBeCloseTo(size.widthMm, 1);
  expect((page.getHeight() * 25.4) / 72).toBeCloseTo(size.heightMm, 1);
});

it('uses embedded DPI for legacy pages and prefers recorded acquisition DPI (synthetic A5 PNG)', async () => {
  await sharp({
    create: { width: 1748, height: 2480, channels: 3, background: '#fff' },
  })
    .withMetadata({ density: 300 })
    .png()
    .toFile(join(directory, 'page.png'));
  const legacy = await exportPage();
  expect((legacy.getWidth() * 25.4) / 72).toBeCloseTo(148, 1);
  expect((legacy.getHeight() * 25.4) / 72).toBeCloseTo(210, 1);
  const recorded = await exportPage({ resolution: 600 });
  expect(recorded.getWidth()).toBeCloseTo(legacy.getWidth() / 2, 6);
  expect(recorded.getHeight()).toBeCloseTo(legacy.getHeight() / 2, 6);
});

it.each([undefined, 0, -300, NaN, Infinity, 10_000])(
  'keeps the legacy A4 scale through crop and rotation when DPI is missing or invalid (%s)',
  async (resolution) => {
    await sharp({ create: { width: 120, height: 160, channels: 3, background: '#fff' } })
      .withMetadata({ density: 10_000 }) // Out-of-range image DPI must not override the fallback.
      .png()
      .toFile(join(directory, 'page.png'));
    const crop = { x: 10, y: 20, width: 60, height: 80 };
    const scale = Math.min(595.28 / 120, 841.89 / 160);
    const page = await exportPage({ resolution, crop, rotation: 90 });
    expect(page.getWidth()).toBeCloseTo(crop.width * scale, 6);
    expect(page.getHeight()).toBeCloseTo(crop.height * scale, 6);
    expect(page.getRotation().angle).toBe(90);
    expect(await sharp(join(directory, 'preview.png')).metadata()).toMatchObject({
      width: crop.height,
      height: crop.width,
    });
  },
);

it('retains the legacy A4 fit when there is no image DPI metadata', async () => {
  await sharp({ create: { width: 120, height: 160, channels: 3, background: '#fff' } })
    .png()
    .toFile(join(directory, 'page.png'));
  const page = await exportPage();
  expect(page.getWidth()).toBeCloseTo(595.28, 6);
  expect(page.getHeight()).toBeCloseTo((160 * 595.28) / 120, 6);
});
