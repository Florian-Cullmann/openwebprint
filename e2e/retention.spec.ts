import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { Store, type StoredJob } from '../apps/server/src/store.js';
import { DemoProvider, demoDevices } from '../apps/server/src/providers/demo.js';
import { isolatedTest } from './isolated-server';

const test = isolatedTest(async (directory) => {
  const store = new Store(directory);
  try {
    store.set('mode', 'demo');
    store.set('onboarding-phase', 'complete');
    store.set('demo-seeded', 'true');
    const provider = new DemoProvider();
    for (const input of demoDevices) store.putDevice(await provider.add(input, randomUUID()));
    for (const kind of ['scan', 'print'] as const) {
      const id = randomUUID();
      const createdAt = new Date(Date.now() - 3 * 86400_000).toISOString();
      const scanDirectory = join(directory, 'files', `${id}.pages`);
      await mkdir(scanDirectory, { recursive: true });
      const filePath = join(scanDirectory, 'document.pdf');
      const previewPath = join(scanDirectory, 'preview.png');
      const pdf = await PDFDocument.create();
      pdf.addPage().drawText('Synthetic retention sample', { x: 48, y: 740, size: 20 });
      await writeFile(filePath, await pdf.save());
      await sharp({ create: { width: 300, height: 400, channels: 3, background: '#ffffff' } })
        .png()
        .toFile(previewPath);
      const device = store
        .devices('demo')
        .find((device) => device.kind === (kind === 'scan' ? 'scanner' : 'printer'))!;
      const job: StoredJob = {
        id,
        kind,
        mode: 'demo',
        status: 'completed',
        createdAt,
        updatedAt: createdAt,
        deviceId: device.id,
        deviceName: device.name,
        title: `${kind === 'scan' ? 'Scan' : 'Print'} retention sample`,
        hasFile: true,
        filePath,
        previewPath,
        scanDirectory,
        options:
          kind === 'scan'
            ? { resolution: 150, color: 'Gray' }
            : { copies: 1, color: 'monochrome', sides: 'one-sided', media: 'iso_a4_210x297mm' },
      };
      store.putJob(job);
    }
  } finally {
    store.close();
  }
});

test('review expiry and confirm a shorter retention policy (synthetic demo documents)', async ({
  page,
}, info) => {
  await page.goto('/jobs');
  await page.getByRole('button', { name: 'Print retention sample', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Document preview' });
  await expect(preview.getByText('Retained until', { exact: false })).toBeVisible();
  await expect(preview.locator('time')).toHaveAttribute('datetime', /T/);
  await expect(preview.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.screenshot({
    path: `test-results/${info.project.name}-30-document-expiry.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Scan retention sample', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('Retained until', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await page.goto('/settings/general');
  // The semantic heading identifies the actual settings card on desktop and mobile.
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Document retention', exact: true }) });
  await expect(page.getByLabel('Keep scans (days)', { exact: true })).toHaveValue('7');
  await expect(page.getByLabel('Keep print PDFs (days)', { exact: true })).toHaveValue('7');
  await page.getByLabel('Keep scans (days)', { exact: true }).fill('2');
  await page.getByLabel('Keep print PDFs (days)', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save retention', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('1 scan and 1 print PDF');
  expect(await (await page.request.get('/api/retention')).json()).toEqual({
    scanDays: 7,
    printDays: 7,
  });
  await page.getByRole('button', { name: 'Cancel change', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save retention', exact: true }).click();
  await page
    .getByRole('button', { name: 'Confirm shorter retention', exact: true })
    .scrollIntoViewIfNeeded();
  const a11y = await new AxeBuilder({ page }).analyze();
  expect(a11y.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  await card.screenshot({ path: `test-results/${info.project.name}-30-retention-warning.png` });
  await page.getByRole('button', { name: 'Confirm shorter retention', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Document retention updated.');
  await page.reload();
  await expect(page.getByLabel('Keep scans (days)', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Keep print PDFs (days)', { exact: true })).toHaveValue('1');
});
