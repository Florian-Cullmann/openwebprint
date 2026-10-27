import { expect } from '@playwright/test';
import { isolatedTest } from './isolated-server';
import type { Job } from '@openwebprint/shared';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

const test = isolatedTest();
const expectScan = expect.configure({ timeout: 15_000 });

test('remove pages, recover from a failed edit, reopen, and download the remaining page (demo scanner)', async ({
  page,
}, info) => {
  await page.goto('/scans');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.goto('/scans');
  await page.getByRole('button', { name: 'New scan', exact: true }).click();
  await page.getByRole('slider', { name: 'Resolution', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
  const list = page.getByRole('list', { name: 'Scanned pages' });
  const cards = list.locator('[data-page-id]');
  await expectScan(cards).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Remove page 1', exact: true })).toBeDisabled();
  await expect(
    page.getByText('A scan must keep at least one page.', { exact: false }),
  ).toBeVisible();
  for (const count of [2, 3]) {
    await page.getByRole('button', { name: 'Scan another page', exact: true }).click();
    await expectScan(cards).toHaveCount(count);
    await expectScan(list).toHaveAttribute('aria-busy', 'false');
  }
  await page.getByRole('button', { name: 'Rotate page 3 clockwise', exact: true }).click();
  await expectScan(list).toHaveAttribute('aria-busy', 'false');
  const ids = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-page-id')),
  );
  // A rejected rebuild leaves all thumbnails and the count in place.
  const editUrl = '**/api/scans/*/pages';
  await page.route(editUrl, (route) =>
    route.fulfill({ status: 422, json: { error: 'Could not rebuild the document.' } }),
  );
  await page.getByRole('button', { name: 'Remove page 2', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Could not rebuild the document.');
  await expect(cards).toHaveCount(3);
  await expect(page.getByText('3 pages', { exact: true })).toBeVisible();
  await page.unroute(editUrl);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(editUrl, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Remove page 2', exact: true }).click();
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Remove page 1', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Scan another page$/ })).toBeDisabled();
    await expect(page.locator('a').filter({ hasText: 'Download PDF' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  } finally {
    release();
  }
  await expectScan(cards).toHaveCount(2);
  await expectScan(list).toHaveAttribute('aria-busy', 'false');
  await page.unroute(editUrl);
  expect(
    await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-page-id'))),
  ).toEqual([ids[0], ids[2]]);
  await expect(page.getByRole('button', { name: 'Crop page 2', exact: true })).toBeFocused();
  await expect(page.getByText('2 pages', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const download = async () => {
    const event = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download PDF', exact: true }).click();
    return PDFDocument.load(await readFile((await (await event).path())!));
  };
  expect((await download()).getPageCount()).toBe(2);
  await page.screenshot({
    path: `test-results/${info.project.name}-page-removal.png`,
    fullPage: true,
  });
  // Keyboard removal moves focus to the retained page; the last page cannot be removed.
  await page.getByRole('button', { name: 'Remove page 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expectScan(cards).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Crop page 1', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Remove page 1', exact: true })).toBeDisabled();
  await expect(page.getByText('1 page', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /^Open scan preview:/ }).click();
  await expect(cards).toHaveCount(1);
  expect(await cards.first().getAttribute('data-page-id')).toBe(ids[2]);
  const thumbnail = page.getByAltText('Scanned page 1', { exact: true });
  await expectScan
    .poll(() =>
      thumbnail.evaluate((img) => [
        (img as HTMLImageElement).naturalWidth,
        (img as HTMLImageElement).naturalHeight,
      ]),
    )
    .toEqual([512, 362]);
  const pdf = await download();
  expect(pdf.getPageCount()).toBe(1);
  expect(pdf.getPage(0).getRotation().angle).toBe(90);
  const scan = (await (await page.request.get('/api/snapshot')).json()).jobs.find(
    (job: Job) => job.kind === 'scan',
  ) as Job;
  const preview = await page.request.get(`/api/jobs/${scan.id}/preview`);
  const rendered = await page.request.get(`/api/scans/${scan.id}/pages/${ids[2]}?thumbnail=1`);
  expect(await preview.body()).toEqual(await rendered.body());
  const a11y = await new AxeBuilder({ page }).analyze();
  expect(a11y.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/${info.project.name}-last-page.png`,
    fullPage: true,
  });
});
