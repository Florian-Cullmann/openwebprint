import { expect } from '@playwright/test';
import { isolatedTest } from './isolated-server';
const test = isolatedTest();
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import AxeBuilder from '@axe-core/playwright';

test('download dropdown exports a selected page or the full PDF (demo scanner)', async ({
  page,
}, info) => {
  await page.goto('/scans');
  if ((await (await page.request.get('/api/session')).json()).onboardingRequired)
    await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.goto('/scans');
  await page.getByRole('button', { name: 'New scan', exact: true }).click();
  await page.getByRole('slider', { name: 'Resolution', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Scan another page', exact: true }).click();
  await expect(page.getByAltText('Scanned page 2', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  const button = page.getByRole('button', { name: 'Download', exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await expect(page.getByRole('dialog')).toBeVisible();
  await button.click();
  await page.getByLabel('Page for image download').selectOption({ label: 'Page 2' });
  await page.getByLabel('JPEG quality').selectOption('75');
  await page.screenshot({ path: `test-results/${info.project.name}-scan-download.png` });
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  for (const format of ['PNG', 'JPEG', 'PDF']) {
    const event = page.waitForEvent('download');
    await page.getByRole('link', { name: `Download ${format}`, exact: true }).click();
    const download = await event;
    const data = await readFile((await download.path())!);
    if (format === 'PDF') expect((await PDFDocument.load(data)).getPageCount()).toBe(2);
    else {
      expect(download.suggestedFilename()).toMatch(
        new RegExp(`page-2\\.${format === 'PNG' ? 'png' : 'jpg'}$`),
      );
      expect((await sharp(data).metadata()).format).toBe(format.toLowerCase());
    }
  }
  await page.getByRole('heading', { name: 'Scan complete', exact: true }).click();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
});
