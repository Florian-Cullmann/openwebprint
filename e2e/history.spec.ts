import { publicErrorBody } from '@openwebprint/shared';
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
  await expect(pages.getByRole('status')).toHaveText('1–50 of 302 jobs Page 1 of 7');
  for (let number = 2; number <= 7; number++) {
    await pages.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(pages.getByRole('status')).toHaveText(
      `${(number - 1) * 50 + 1}–${Math.min(number * 50, 302)} of 302 jobs Page ${number} of 7`,
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
  await expect(pages.getByRole('status')).toHaveText('301–302 of 302 jobs Page 7 of 7');
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await pages.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(pages.getByRole('status')).toHaveText('251–300 of 302 jobs Page 6 of 7');
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(pages.getByRole('status')).toHaveText('0–0 of 0 jobs Page 1 of 1');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(pages.getByRole('status')).toHaveText('1–50 of 302 jobs Page 1 of 7');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Scans', exact: true })
    .click();
  const scans = page.getByRole('navigation', { name: 'Scan history pages' });
  const scanRows = page.getByRole('table').locator('tbody').getByRole('row');
  const listView = page.getByRole('button', { name: 'List view', exact: true });
  const gridView = page.getByRole('button', { name: 'Grid view', exact: true });
  async function checkLayout() {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    const result = await new AxeBuilder({ page }).analyze();
    expect(
      result.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? ''),
      ),
    ).toEqual([]);
  }
  await expect(scans.getByRole('status')).toHaveText('1–30 of 61 scans Page 1 of 3');
  await expect(page.getByRole('article')).toHaveCount(30);
  await expect(page.getByRole('heading', { name: 'Archive scan 241', exact: true })).toBeVisible();
  await listView.click();
  await expect(listView).toHaveAttribute('aria-pressed', 'true');
  await expect(scanRows).toHaveCount(30);
  await checkLayout();
  await page.reload();
  await expect(listView).toHaveAttribute('aria-pressed', 'true');
  await expect(scans.getByRole('status')).toHaveText('1–30 of 61 scans Page 1 of 3');
  await expect(scanRows).toHaveCount(30);
  await gridView.click();
  await expect(gridView).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('article')).toHaveCount(30);
  await scans.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(scans.getByRole('status')).toHaveText('31–60 of 61 scans Page 2 of 3');
  const retained = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Archive scan 300', exact: true }) });
  const downloadEvent = page.waitForEvent('download');
  await retained.getByRole('link', { name: 'Save PDF', exact: true }).click();
  expect(await (await downloadEvent).failure()).toBeNull();
  await retained
    .getByRole('button', { name: 'Open scan preview: Archive scan 300', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible();
  await expect(page.getByAltText('Scanned page 1')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await listView.click();
  // Changing the layout keeps the current page and all of its document actions.
  await expect(scans.getByRole('status')).toHaveText('31–60 of 61 scans Page 2 of 3');
  await expect(scanRows).toHaveCount(30);
  const retainedRow = page.getByRole('row').filter({ hasText: 'Archive scan 300' });
  const listDownload = page.waitForEvent('download');
  await retainedRow.getByRole('link', { name: 'Save PDF: Archive scan 300', exact: true }).click();
  expect(await (await listDownload).failure()).toBeNull();
  await retainedRow.getByRole('button', { name: 'Archive scan 300', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible();
  await expect(page.getByAltText('Scanned page 1')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await checkLayout();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/${info.project.name}-history-list.png`,
    fullPage: false,
  });
  await scans.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(scans.getByRole('status')).toHaveText('61–61 of 61 scans Page 3 of 3');
  const expired = page.getByRole('row').filter({ hasText: 'Expired archive scan' });
  await expect(expired).toContainText('File already deleted');
  await expect(expired.getByRole('link', { name: /Save PDF/ })).toHaveCount(0);
  await expired
    .getByRole('button', { name: 'Delete scan: Expired archive scan', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep', exact: true }).click();
  await gridView.click();
  await expect(scans.getByRole('status')).toHaveText('61–61 of 61 scans Page 3 of 3');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByText('File already deleted', { exact: true })).toBeVisible();
  await expect(scans.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  // Simulate a temporary proxy failure only for page requests, then exercise Retry.
  await page.route('**/api/jobs?**', (route) =>
    route.fulfill({
      status: 503,
      json: publicErrorBody('The operation failed. Check the server logs.'),
    }),
  );
  await scans.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'The operation failed. Check the server logs.',
  );
  await page.unroute('**/api/jobs?**');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(scans.getByRole('status')).toHaveText('31–60 of 61 scans Page 2 of 3');
  await scans.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(scans.getByRole('status')).toHaveText('61–61 of 61 scans Page 3 of 3');
  await checkLayout();
  await page.screenshot({
    path: `test-results/${info.project.name}-history-pagination.png`,
    fullPage: true,
  });
  await listView.click();
  await page
    .getByRole('button', { name: 'Delete scan: Expired archive scan', exact: true })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(scans.getByRole('status')).toHaveText('31–60 of 60 scans Page 2 of 2');
  await expect(scanRows).toHaveCount(30);
  await expect(scans.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('search scan titles live across pages, clear with the keyboard, and recover from errors (synthetic archive, production server)', async ({
  page,
}, info) => {
  await page.goto('/scans');
  const scans = page.getByRole('navigation', { name: 'Scan history pages' });
  const search = page.getByRole('searchbox', { name: 'Search scans', exact: true });
  const summary = scans.getByRole('status');
  await expect(summary).toHaveText('1–30 of 61 scans Page 1 of 3');
  await scans.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(summary).toHaveText('31–60 of 61 scans Page 2 of 3');
  await scans.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(summary).toHaveText('61–61 of 61 scans Page 3 of 3');
  // This title is absent from the loaded page; search must find it server-side.
  await search.pressSequentially('Archive scan 300');
  await expect(summary).toHaveText('1–1 of 1 scan Page 1 of 1');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Archive scan 300', exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Save PDF', exact: true }).click();
  expect(await (await download).failure()).toBeNull();
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/${info.project.name}-scan-search.png`,
    fullPage: true,
  });

  // Both layouts use the same search and preserve the matching result.
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(summary).toHaveText('1–1 of 1 scan Page 1 of 1');
  await expect(page.getByRole('table').locator('tbody').getByRole('row')).toHaveCount(1);
  await search.fill('scan 2');
  await expect(summary).toHaveText('1–30 of 59 scans Page 1 of 2');
  const next = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/jobs' && url.searchParams.has('cursor');
  });
  await scans.getByRole('button', { name: 'Next', exact: true }).click();
  expect(new URL((await next).url()).searchParams.get('search')).toBe('scan 2');
  await expect(summary).toHaveText('31–59 of 59 scans Page 2 of 2');
  await search.fill('missing document');
  await expect(
    page.getByRole('status').filter({ hasText: 'No scans match your search.' }),
  ).toBeVisible();
  await expect(summary).toHaveText('0–0 of 0 scans Page 1 of 1');
  await search.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await expect(summary).toHaveText('1–30 of 61 scans Page 1 of 3');

  await page.route('**/api/jobs?**', (route) =>
    route.fulfill({ status: 503, json: { error: 'Search temporarily unavailable.' } }),
  );
  await search.fill('expired');
  // Legacy responses without public codes use the safe HTTP fallback.
  await expect(page.getByRole('alert')).toContainText('The request failed (HTTP 503).');
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.unroute('**/api/jobs?**');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(search).toHaveValue('expired');
  await expect(summary).toHaveText('1–1 of 1 scan Page 1 of 1');
  await expect(page.getByRole('table')).toContainText('Expired archive scan');
  await search.fill('');
  await expect(summary).toHaveText('1–30 of 61 scans Page 1 of 3');
});

test('ignores late search responses during debounce and after a newer result (controlled network fixtures)', async ({
  page,
}) => {
  // Deliberately ignore transport cancellation so the stale-response guard is tested too.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) =>
      originalFetch(
        input,
        String(input).startsWith('/api/jobs?') ? { ...init, signal: undefined } : init,
      );
  });
  await page.goto('/scans');
  const search = page.getByRole('searchbox', { name: 'Search scans', exact: true });
  const summary = page.getByRole('navigation', { name: 'Scan history pages' }).getByRole('status');
  await expect(summary).toHaveText('1–30 of 61 scans Page 1 of 3');

  for (const [duringDebounce, staleError] of [
    [true, false],
    [false, false],
    [false, true],
  ]) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseLatest!: () => void;
    const latestHeld = new Promise<void>((resolve) => {
      releaseLatest = resolve;
    });
    let received!: () => void;
    const started = new Promise<void>((resolve) => {
      received = resolve;
    });
    await page.route('**/api/jobs?**', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('search');
      if (query === 'scan 300' && duringDebounce) await latestHeld;
      if (query !== 'scan 250') return route.continue();
      const response = await route.fetch();
      received();
      await held;
      await route.fulfill(
        staleError ? { status: 503, json: { error: 'Stale search failure.' } } : { response },
      );
    });
    try {
      await search.fill('scan 250');
      await started;
      await expect(page.getByRole('status').filter({ hasText: 'Searching scans…' })).toBeVisible();
      await search.fill('scan 300');
      if (!duringDebounce) await expect(summary).toHaveText('1–1 of 1 scan Page 1 of 1');
      const late = page.waitForResponse(
        (response) => new URL(response.url()).searchParams.get('search') === 'scan 250',
      );
      release();
      await (await late).finished();
      // Let the browser consume and render the released response before checking it.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (duringDebounce) {
        await expect(
          page.getByRole('status').filter({ hasText: 'Searching scans…' }),
        ).toBeVisible();
        await expect(page.getByRole('article')).toHaveCount(0);
      }
      releaseLatest();
      await expect(summary).toHaveText('1–1 of 1 scan Page 1 of 1');
      await expect(
        page.getByRole('heading', { name: 'Archive scan 300', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Archive scan 250', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      release();
      releaseLatest();
      await page.unroute('**/api/jobs?**');
    }
  }
});

test('combine history filters, rename a retained scan, and keep the title after reload (synthetic archive)', async ({
  page,
}, info) => {
  await page.goto('/scans');
  const pagination = page.getByRole('navigation', { name: 'Scan history pages' });
  await expect(pagination.getByRole('status')).toHaveText('1–30 of 61 scans Page 1 of 3');
  await pagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pagination.getByRole('status')).toContainText('Page 2 of 3');
  await page.getByText('Filter history', { exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Device', exact: true })
    .selectOption({ label: 'Archive demo device' });
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('completed');
  await expect(pagination.getByRole('status')).toContainText('Page 1 of 3');
  const search = page.getByRole('searchbox', { name: 'Search scans', exact: true });
  await search.fill('Archive scan 300');
  await expect(pagination.getByRole('status')).toHaveText('1–1 of 1 scan Page 1 of 1');
  const record = await (await page.request.get(`/api/jobs/${id(300)}`)).json();
  const day = await page.evaluate((createdAt) => {
    const date = new Date(createdAt);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }, record.createdAt);
  await page.getByLabel('Created from', { exact: true }).fill(day);
  await page.getByLabel('Created through', { exact: true }).fill(day);
  await expect(pagination.getByRole('status')).toHaveText('1–1 of 1 scan Page 1 of 1');
  await page
    .getByRole('button', { name: 'Open scan preview: Archive scan 300', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Rename scan', exact: true }).click();
  const title = dialog.getByRole('textbox', { name: 'Scan title', exact: true });
  await expect(title).toBeFocused();
  await title.fill('  ');
  await expect(dialog.getByRole('button', { name: 'Save title', exact: true })).toBeDisabled();
  await title.fill('Übersicht <Rechnungen> 2026');
  await title.press('Enter');
  await expect(dialog.getByRole('status').filter({ hasText: 'Title saved.' })).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Übersicht <Rechnungen> 2026', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Rename scan', exact: true })).toBeFocused();
  await page.screenshot({ path: `test-results/${info.project.name}-scan-rename.png` });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'No jobs match your search and filters.' }),
  ).toBeVisible();
  await search.fill('übersicht');
  await expect(
    page.getByRole('heading', { name: 'Übersicht <Rechnungen> 2026', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Übersicht <Rechnungen> 2026', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/${info.project.name}-history-filters.png`,
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  // Collapsing the controls keeps the complete filter selection and matching results.
  const filterToggle = page.getByRole('button', { name: 'Filter history (active)', exact: true });
  await expect(filterToggle).toHaveAttribute('aria-expanded', 'true');
  await filterToggle.focus();
  await page.keyboard.press('Enter');
  await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Created from', { exact: true })).toBeHidden();
  await expect(pagination.getByRole('status')).toHaveText('1–1 of 1 scan Page 1 of 1');
  await page.screenshot({
    path: `test-results/${info.project.name}-history-compact.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Change color scheme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const compactAccessibility = await new AxeBuilder({ page }).analyze();
  expect(
    compactAccessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/${info.project.name}-history-compact-dark.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Change color scheme', exact: true }).click();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(search).toBeFocused();
  await expect(pagination.getByRole('status')).toHaveText(/^1–\d+ of \d+ scans? Page 1 of \d+$/);
  await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
  await search.fill('übersicht');
  await expect(pagination.getByRole('status')).toHaveText('1–1 of 1 scan Page 1 of 1');
  await filterToggle.press('Space');
  await expect(page.getByRole('combobox', { name: 'Device', exact: true })).toHaveValue(id(999));
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue(
    'completed',
  );
  await expect(page.getByLabel('Created from', { exact: true })).toHaveValue(day);
  await expect(page.getByLabel('Created through', { exact: true })).toHaveValue(day);
  await page.getByLabel('Created from', { exact: true }).fill('2099-01-01');
  await expect(page.getByRole('alert')).toHaveText(
    'Choose an end date on or after the start date.',
  );
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(pagination.getByRole('status')).toHaveText('1–1 of 1 scan Page 1 of 1');
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search scans', exact: true }).fill('übersicht');
  await expect(
    page.getByRole('button', { name: 'Übersicht <Rechnungen> 2026', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Jobs', exact: true })
    .click();
  await page.getByRole('searchbox', { name: 'Search jobs', exact: true }).fill('übersicht');
  await expect(
    page.getByRole('navigation', { name: 'Job history pages' }).getByRole('status'),
  ).toHaveText('1–1 of 1 job Page 1 of 1');
  await page.screenshot({
    path: `test-results/${info.project.name}-jobs-compact.png`,
    fullPage: true,
  });
});

test.describe('calendar date boundaries', () => {
  test.use({ timezoneId: 'Europe/Berlin' });
  test('includes the complete local day over both daylight-saving changes', async ({ page }) => {
    await page.goto('/jobs');
    await page.getByText('Filter history', { exact: true }).click();
    for (const [day, from, until] of [
      ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
      ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
    ]) {
      await page.getByLabel('Created from', { exact: true }).fill(day);
      const request = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/jobs' &&
          url.searchParams.get('from') === from &&
          url.searchParams.get('until') === until
        );
      });
      await page.getByLabel('Created through', { exact: true }).fill(day);
      expect((await request).status()).toBe(200);
      await expect(
        page.getByRole('navigation', { name: 'Job history pages' }).getByRole('status'),
      ).toHaveText('0–0 of 0 jobs Page 1 of 1');
    }
  });
});
