import { publicErrorBody } from '@openwebprint/shared';
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { Device, ScanOptions } from '@openwebprint/shared';
import { createApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { DemoProvider } from '../apps/server/src/providers/demo.js';

// Actual API, persistence and built frontend; only acquisition is controlled.
class JamScanner extends DemoProvider {
  override async scan(device: Device, output: string, options: ScanOptions) {
    if (!options.batch) return super.scan(device, output, options);
    const image = await sharp(
      Buffer.from(
        '<svg width="300" height="400"><rect width="300" height="400" fill="white"/><text x="20" y="60" font-size="20">Recovery sample page</text></svg>',
      ),
    )
      .png()
      .toBuffer();
    for (const number of [1, 2]) await writeFile(output.replace('%d', String(number)), image);
    await writeFile(output.replace('%d', '3'), image.subarray(0, -12));
    throw new Error('Paper jam (controlled provider).');
  }
}
const test = base.extend({
  baseURL: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'owp-recovery-browser-'));
    const config = readConfig({ DATA_DIR: directory, MODE: 'demo', COOKIE_SECURE: 'false' });
    const { app, workspace } = await createApp(config, {
      provider: new JamScanner(),
      background: false,
    });
    try {
      await workspace.tryDemo();
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      config.origin = origin;
      await use(origin);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});
for (const append of [false, true])
  for (const action of ['keep', 'discard']) {
    test(`${action} recovered pages from ${append ? 'an append' : 'a first batch'} (controlled provider)`, async ({
      page,
    }, info) => {
      await page.goto('/scans');
      await page.getByRole('button', { name: 'New scan', exact: true }).click();
      const cards = page.getByRole('list', { name: 'Scanned pages' }).locator('[data-page-id]');
      if (append) {
        await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
        await expect(cards).toHaveCount(1);
      }
      await page.getByRole('combobox', { name: 'Paper source', exact: true }).selectOption('ADF');
      await page.getByRole('button', { name: 'Scan multiple pages', exact: true }).click();
      const recovery = page.getByRole('region', { name: 'Recover scanned pages' });
      await expect(recovery).toBeVisible({ timeout: 15000 });
      await expect(recovery).toContainText('2 pages ready to recover');
      await expect(
        page.getByRole('heading', { name: 'Scan incomplete', exact: true }),
      ).toBeVisible();
      // Unknown provider diagnostics never reach the browser, including persisted jobs.
      await expect(page.getByRole('alert')).toHaveText(
        'The operation failed. Check the server logs.',
      );
      await expect(page.getByText('Paper jam (controlled provider).')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Scan multiple pages', exact: true }),
      ).toHaveCount(0);
      await expect(recovery.getByText('1, 2', { exact: true })).toBeVisible();
      await recovery.getByText('Recovery details', { exact: true }).click();
      await expect(
        recovery.getByText('Only complete pages are included.', { exact: false }),
      ).toBeVisible();
      await recovery.getByText('Recovery details', { exact: true }).click();
      if (append) {
        await expect(cards).toHaveCount(1);
        await expect(page.getByRole('link', { name: 'Download PDF', exact: true })).toHaveAttribute(
          'href',
          /\/pdf$/,
        );
      }
      await page.getByRole('button', { name: 'Decide later', exact: true }).click();
      await page.reload();
      await page.getByRole('button', { name: /^Open scan preview:/ }).click();
      await expect(recovery).toBeVisible();
      if (action === 'keep') {
        const screenshot = `test-results/${info.project.name}-41-${append ? 'append' : 'first'}-recovery.png`;
        if (info.project.name === 'mobile') {
          await recovery.scrollIntoViewIfNeeded();
          await page.screenshot({ path: screenshot });
        } else await page.getByRole('dialog').screenshot({ path: screenshot });
        const axe = await new AxeBuilder({ page }).analyze();
        expect(
          axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
        ).toEqual([]);
        // The browser keeps the decision available after a rejected request.
        await page.route('**/api/scans/*/recovery', (route) =>
          route.fulfill({
            status: 422,
            json: publicErrorBody(
              'The scanned pages could not be converted to PDF. Check scan storage and try again.',
            ),
          }),
        );
        await page.getByRole('button', { name: 'Keep 2 pages', exact: true }).click();
        await expect(page.getByRole('alert')).toHaveText(
          'The scanned pages could not be converted to PDF. Check scan storage and try again.',
        );
        await expect(recovery).toBeVisible();
        await page.unroute('**/api/scans/*/recovery');
        await page.getByRole('button', { name: 'Keep 2 pages', exact: true }).click();
        await expect(recovery).toHaveCount(0);
        await expect(cards).toHaveCount(append ? 3 : 2);
        await expect(page.getByRole('alert')).toContainText(
          'Acquisition incomplete. Kept 2 recovered pages.',
        );
        const event = page.waitForEvent('download');
        await page.getByRole('link', { name: 'Download PDF', exact: true }).click();
        const pdf = await PDFDocument.load(await readFile((await (await event).path())!));
        expect(pdf.getPageCount()).toBe(append ? 3 : 2);
      } else {
        await page.getByRole('button', { name: 'Discard recovered pages', exact: true }).click();
        await expect(recovery).toHaveCount(0);
        if (append) await expect(cards).toHaveCount(1);
        else
          await expect(page.getByRole('link', { name: 'Download PDF', exact: true })).toHaveCount(
            0,
          );
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
    });
  }
