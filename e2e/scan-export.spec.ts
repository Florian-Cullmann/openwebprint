import { expect } from '@playwright/test';
import { isolatedTest } from './isolated-server';
import AxeBuilder from '@axe-core/playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { Store } from '../apps/server/src/store.js';
import { readArchive } from '../apps/server/test/archive.js';

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const test = isolatedTest(async (directory) => {
  // Synthetic retained scans; the journey uses the production UI/server and ZIP.
  const store = new Store(directory);
  try {
    store.set('mode', 'demo');
    store.set('onboarding-phase', 'complete');
    const document = await PDFDocument.create();
    document.addPage().drawText('Synthetic receipt for ZIP export');
    const pdf = await document.save();
    const png = await sharp({
      create: { width: 300, height: 400, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    for (let index = 1; index <= 35; index++) {
      const filePath = join(directory, `${id(index)}.pdf`);
      const previewPath = join(directory, `${id(index)}.png`);
      await writeFile(filePath, pdf);
      await writeFile(previewPath, png);
      const createdAt = new Date(Date.now() - index * 1000).toISOString();
      store.putJob({
        id: id(index),
        deviceId: id(999),
        deviceName: 'Receipt scanner fixture',
        title: [1, 31].includes(index) ? 'Büro · 東京' : `Receipt ${index}`,
        kind: 'scan',
        mode: 'demo',
        status: 'completed',
        hasFile: index !== 35,
        createdAt,
        updatedAt: createdAt,
        scanRevision: id(index),
        options: { resolution: 300, color: 'Color' },
        filePath,
        previewPath,
        scanPages: [{ id: id(index), rotation: 0, path: previewPath, resolution: 300 }],
      });
    }
  } finally {
    store.close();
  }
});

test('selects across history pages and layouts, downloads actual PDFs, and reports a changed selection', async ({
  page,
}, info) => {
  await page.goto('/scans');
  const selection = page.getByRole('region', { name: 'Export selected scans' });
  const count = selection.getByRole('status').first();
  const pages = page.getByRole('navigation', { name: 'Scan history pages' });
  await expect(selection).toHaveCount(0);
  await expect(page.getByText('Select PDF', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(30);
  await page.screenshot({ path: `test-results/${info.project.name}-84-scan-overview.png` });
  await page.getByRole('button', { name: 'Change color scheme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const normal = await new AxeBuilder({ page }).analyze();
  expect(normal.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  await page.screenshot({ path: `test-results/${info.project.name}-84-scan-overview-dark.png` });
  await page.getByRole('button', { name: 'Change color scheme', exact: true }).click();
  const first = page.getByRole('checkbox', { name: 'Select scan: Büro · 東京', exact: true });
  await first.focus();
  await page.keyboard.press('Space');
  await expect(first).toBeChecked();
  await expect(count).toHaveText('1 selected');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(selection).toHaveCount(0);
  await expect(first).toBeFocused();
  await page.keyboard.press('Space');
  await expect(count).toHaveText('1 selected');
  await pages.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pages.getByRole('status')).toHaveText('31–35 of 35 scans Page 2 of 2');
  await page.getByRole('checkbox', { name: 'Select scan: Büro · 東京', exact: true }).check();
  await expect(count).toHaveText('2 selected');
  await expect(
    page.getByRole('checkbox', { name: 'Select scan: Receipt 35', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(
    page
      .getByRole('table')
      .getByRole('checkbox', { name: 'Select scan: Büro · 東京', exact: true }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await selection.scrollIntoViewIfNeeded();
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/${info.project.name}-84-scan-export.png` });
  const event = page.waitForEvent('download');
  await selection.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe('openwebprint-scans.zip');
  const entries = await readArchive(await readFile((await download.path())!));
  expect(entries.size).toBe(2);
  for (const [name, data] of entries) {
    expect(name).toContain('Büro · 東京');
    expect([id(1), id(31)].some((id) => name.endsWith(`${id}.pdf`))).toBe(true);
    expect((await PDFDocument.load(data)).getPageCount()).toBe(1);
  }
  // A real document edit after selection must be rejected, not silently replaced.
  const edited = await page.request.post(`/api/scans/${id(1)}/pages`, {
    headers: { 'x-openwebprint': '1' },
    data: { revision: id(1), pages: [{ id: id(1), rotation: 90 }] },
  });
  expect(edited.status()).toBe(200);
  await selection.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  await expect(selection.getByRole('alert')).toContainText('has changed');
  await expect(count).toHaveText('2 selected');
  await selection.getByText('Review selected scans (2)', { exact: true }).click();
  await selection
    .getByRole('button', { name: 'Remove selection: Büro · 東京', exact: true })
    .first()
    .click();
  await expect(count).toHaveText('1 selected'); // Removal also works for an off-page scan.
  await selection.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(selection).toHaveCount(0);
  const visible = page.getByRole('checkbox', { name: 'Select scan: Büro · 東京', exact: true });
  await expect(visible).toBeFocused();
  await page.keyboard.press('Space');
  await expect(count).toHaveText('1 selected');
  await page.keyboard.press('Space');
  await expect(selection).toHaveCount(0);
  await expect(visible).toBeFocused();
});

test('cancels ZIP preparation, retains selection for retry and clears it when leaving Scans', async ({
  page,
}) => {
  await page.goto('/scans');
  const selection = page.getByRole('region', { name: 'Export selected scans' });
  await page.getByRole('checkbox', { name: 'Select scan: Büro · 東京', exact: true }).check();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/scans/export', async (route) => {
    await gate;
    await route
      .fulfill({ status: 409, json: { error: 'Delayed browser fixture.' } })
      .catch(() => {});
  });
  await selection.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  await selection.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(
    selection.getByText('ZIP export canceled. Your selection is kept.', { exact: true }),
  ).toBeVisible();
  await expect(selection.getByRole('status').first()).toHaveText('1 selected');
  release();
  await page.unroute('**/api/scans/export');
  const event = page.waitForEvent('download');
  await selection.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  expect((await event).suggestedFilename()).toBe('openwebprint-scans.zip');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Jobs', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Scans', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Export selected scans' })).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: 'Select scan: Büro · 東京', exact: true }),
  ).not.toBeChecked();
});
