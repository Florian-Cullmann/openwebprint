import { expect } from '@playwright/test';
import { isolatedTest } from './isolated-server';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { Store, type StoredJob } from '../apps/server/src/store.js';

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const test = isolatedTest(async (directory) => {
  // Only the fixture setup writes SQLite. The journey uses the actual production bundle/API.
  const store = new Store(directory);
  try {
    store.set('mode', 'demo');
    store.set('onboarding-phase', 'complete');
    const document = await PDFDocument.create();
    document.addPage().drawText('Synthetic archive sample');
    const filePath = join(directory, 'sample.pdf');
    const previewPath = join(directory, 'sample.png');
    await writeFile(filePath, await document.save());
    await writeFile(
      previewPath,
      await sharp(
        Buffer.from(
          '<svg width="300" height="400"><rect width="300" height="400" fill="white"/><text x="25" y="70" font-size="20">Archive demo sample</text></svg>',
        ),
      )
        .png()
        .toBuffer(),
    );
    for (let index = 1; index <= 302; index++) {
      const scan = index > 240 && index !== 301;
      const createdAt = new Date(
        Date.now() -
          (index <= 240 ? index * 1000 : (index === 302 ? 8 : 6) * 86400_000 + index * 1000),
      ).toISOString();
      const job: StoredJob = {
        id: id(index),
        deviceId: id(999),
        deviceName: 'Archive demo device',
        kind: scan ? 'scan' : 'print',
        title:
          index === 302
            ? 'Expired archive scan'
            : index === 301
              ? 'Old archive print'
              : `${scan ? 'Archive scan' : 'Recent print'} ${index}`,
        status: 'completed',
        createdAt,
        updatedAt: createdAt,
        mode: 'demo',
        options: scan
          ? { resolution: 150, color: 'Color' }
          : { copies: 1, color: 'monochrome', sides: 'one-sided', media: 'iso_a4_210x297mm' },
        hasFile: index === 300 || index === 301,
        ...(index === 300 || index === 301 ? { filePath, ...(scan ? { previewPath } : {}) } : {}),
      };
      store.putJob(job);
    }
  } finally {
    store.close();
  }
});

test('navigate beyond 200 jobs and open/download older scans (synthetic archive, production server)', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/jobs');
  const pages = page.getByRole('navigation', { name: 'Job history pages' });
  await expect(pages.getByRole('status')).toHaveText('Page 1 · 50 jobs');
  for (let number = 2; number <= 7; number++) {
    await pages.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(pages.getByRole('status')).toHaveText(
      `Page ${number} · ${number === 7 ? 2 : 50} jobs`,
    );
  }
  await expect(pages.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Old archive print', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(pages.getByRole('status')).toHaveText('Page 7 · 2 jobs');
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await pages.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(pages.getByRole('status')).toHaveText('Page 6 · 50 jobs');
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(pages.getByRole('status')).toHaveText('Page 1 · 0 jobs');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(pages.getByRole('status')).toHaveText('Page 1 · 50 jobs');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Scans', exact: true })
    .click();
  const scans = page.getByRole('navigation', { name: 'Scan history pages' });
  await expect(scans.getByRole('status')).toHaveText('Page 1 · 50 scans');
  await expect(page.getByRole('heading', { name: 'Archive scan 241', exact: true })).toBeVisible();
  await scans.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(scans.getByRole('status')).toHaveText('Page 2 · 11 scans');
  const retained = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Archive scan 300', exact: true }) });
  const downloadEvent = page.waitForEvent('download');
  await retained.getByRole('link', { name: 'Save PDF', exact: true }).click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  await retained
    .getByRole('button', { name: 'Open scan preview: Archive scan 300', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible();
  await expect(page.getByAltText('Scanned page 1')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const expired = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Expired archive scan', exact: true }) });
  await expect(expired.getByText('File already deleted', { exact: true })).toBeVisible();
  await expect(expired.getByRole('link', { name: 'Save PDF' })).toHaveCount(0);
  await expect(scans.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  // Simulate a temporary proxy failure only for page requests, then exercise Retry.
  await page.route('**/api/jobs?**', (route) =>
    route.fulfill({ status: 503, json: { error: 'History temporarily unavailable.' } }),
  );
  await scans.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('History temporarily unavailable.');
  await page.unroute('**/api/jobs?**');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(scans.getByRole('status')).toHaveText('Page 1 · 50 scans');
  await scans.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(scans.getByRole('status')).toHaveText('Page 2 · 11 scans');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/${info.project.name}-history-pagination.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
