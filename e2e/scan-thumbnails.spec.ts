import { expect } from '@playwright/test';
import { isolatedTest } from './isolated-server';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { Store, type StoredScanPage } from '../apps/server/src/store.js';

const id = (index: number) => `61000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const jobId = id(0);
const test = isolatedTest(async (directory) => {
  const store = new Store(directory);
  try {
    store.set('mode', 'demo');
    store.set('onboarding-phase', 'complete');
    store.putDevice({
      id: id(100),
      name: 'Synthetic scanner',
      kind: 'scanner',
      address: 'demo://thumbnail-scanner',
      location: 'Test fixture',
      provider: 'demo',
      mode: 'demo',
      status: 'ready',
    });
    const scanDirectory = join(directory, 'files', `${jobId}.pages`);
    await mkdir(scanDirectory, { recursive: true });
    const image = await sharp(
      Buffer.from(
        '<svg width="1200" height="1600"><rect width="1200" height="1600" fill="white"/><rect x="80" y="80" width="1040" height="200" rx="20" fill="#e3f1f4"/><text x="130" y="200" font-family="sans-serif" font-size="52" fill="#23596a">Synthetic scan sample</text><path d="M130 430h940M130 550h940M130 670h700" stroke="#c4ced3" stroke-width="24"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const pages: StoredScanPage[] = [];
    const pdf = await PDFDocument.create();
    const embedded = await pdf.embedPng(image);
    for (let number = 1; number <= 30; number++) {
      const path = join(scanDirectory, `page-${number}.png`);
      await writeFile(path, image);
      pages.push({ id: id(number), rotation: 0, path, resolution: 300 });
      pdf.addPage([288, 384]).drawImage(embedded, { x: 0, y: 0, width: 288, height: 384 });
    }
    const filePath = join(scanDirectory, 'document.pdf');
    const previewPath = join(scanDirectory, 'preview.png');
    await writeFile(filePath, await pdf.save());
    // Also exercises an existing full-size gallery preview after an upgrade.
    await writeFile(previewPath, image);
    store.putJob({
      id: jobId,
      deviceId: id(100),
      deviceName: 'Synthetic scanner',
      kind: 'scan',
      title: 'Thirty-page synthetic scan',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: 'demo',
      options: { resolution: 300, color: 'Color' },
      hasFile: true,
      filePath,
      previewPath,
      scanDirectory,
      scanPages: pages,
      scanRevision: 'synthetic-original',
    });
  } finally {
    store.close();
  }
});

test('loads bounded editor images on demand, keeps unchanged URLs, and crops original pixels (synthetic scan)', async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/api/scans/${jobId}/pages/`)) requests.push(request.url());
  });
  await page.goto('/scans');
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  const gallery = page.locator(`img[src^="/api/jobs/${jobId}/preview?"]`);
  await expect
    .poll(() => gallery.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(384);
  await page.getByRole('button', { name: /^Open scan preview:/ }).click();
  const first = page.getByAltText('Scanned page 1', { exact: true });
  const last = page.getByAltText('Scanned page 30', { exact: true });
  await expect
    .poll(() => first.evaluate((img) => (img as HTMLImageElement).naturalHeight))
    .toBe(512);
  expect(requests.every((url) => new URL(url).searchParams.get('thumbnail') === '1')).toBe(true);
  expect(requests.some((url) => url.includes(`/pages/${id(30)}?`))).toBe(false);
  const firstUrl = await first.getAttribute('src');
  const secondUrl = await page.getByAltText('Scanned page 2', { exact: true }).getAttribute('src');
  await page.getByRole('button', { name: 'Rotate page 1 clockwise', exact: true }).click();
  await expect
    .poll(() => first.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(512);
  expect(await first.getAttribute('src')).not.toBe(firstUrl);
  expect(await page.getByAltText('Scanned page 2', { exact: true }).getAttribute('src')).toBe(
    secondUrl,
  );
  // A successful save does not refetch other mounted page images.
  expect(requests.filter((url) => url.includes(`/pages/${id(2)}?`))).toHaveLength(1);
  await expect(page.getByRole('slider', { name: 'Resolution', exact: true })).toBeEnabled();
  await page.screenshot({
    path: `test-results/${info.project.name}-scan-thumbnails.png`,
    fullPage: false,
  });
  await last.scrollIntoViewIfNeeded();
  await expect
    .poll(() => last.evaluate((img) => (img as HTMLImageElement).naturalHeight))
    .toBe(512);
  expect(requests.some((url) => url.includes(`/pages/${id(30)}?`))).toBe(true);
  await page.getByRole('button', { name: 'Crop page 30', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Width (px)', exact: true })).toHaveValue(
    '1200',
  );
  await expect(page.getByRole('spinbutton', { name: 'Height (px)', exact: true })).toHaveValue(
    '1600',
  );
  expect(
    requests.some(
      (url) => new URL(url).pathname.endsWith(`/pages/${id(30)}`) && !new URL(url).search,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Cancel crop', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect
    .poll(() => gallery.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(512);
});
