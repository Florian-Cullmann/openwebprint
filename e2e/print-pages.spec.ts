import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from 'pdf-lib';
import type { Job } from '@openwebprint/shared';
import { isolatedTest } from './isolated-server';

const test = isolatedTest();
async function sample(pages: number) {
  const pdf = await PDFDocument.create();
  for (let number = 1; number <= pages; number++)
    pdf
      .addPage([400 + number, 600])
      .drawText(`Sample document - page ${number}`, { x: 40, y: 540, size: 18 });
  return {
    name: 'page-selection.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  };
}

test('validates ranges, combines parity and submits only selected pages (real API, demo provider)', async ({
  page,
}, info) => {
  await page.goto('/overview');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.getByRole('button', { name: 'Print', exact: true }).first().click();
  const upload = page.getByLabel('Select document', { exact: true });
  await upload.setInputFiles(await sample(7));
  const summary = page.getByRole('status').filter({ hasText: 'pages per copy' });
  await expect(summary).toHaveText('7 of 7 pages per copy · Pages 1-7 · 1 copy');
  const submit = page.getByRole('button', { name: 'Start demo print', exact: true });
  const pages = page.getByRole('combobox', { name: 'Pages', exact: true });
  const filter = page.getByRole('combobox', { name: 'Page filter', exact: true });
  await pages.selectOption('custom');
  const range = page.getByRole('textbox', { name: 'Page range', exact: true });
  await expect(submit).toBeDisabled();
  await range.fill('1,,2');
  await expect(page.getByRole('alert')).toContainText('separated by commas');
  await range.fill('1-8');
  await filter.selectOption('odd');
  await expect(page.getByRole('alert')).toContainText('between 1 and 7');
  await expect(submit).toBeDisabled();
  await range.fill('2,4');
  await expect(page.getByRole('alert')).toContainText('no pages');
  await range.fill('7, 1-3, 3');
  await expect(summary).toHaveText('3 of 7 pages per copy · Pages 1, 3, 7 · 1 copy');
  await filter.selectOption('even');
  await expect(summary).toHaveText('1 of 7 pages per copy · Pages 2 · 1 copy');
  await filter.selectOption('odd');
  await page
    .getByRole('combobox', { name: 'Sides', exact: true })
    .selectOption('two-sided-long-edge');
  await page.getByLabel('Copies', { exact: true }).fill('2');
  await expect(
    page.getByText('Duplex pairs consecutive selected pages', { exact: false }),
  ).toBeVisible();
  // Replacing the document must invalidate the old count and selection.
  await upload.setInputFiles(await sample(1));
  await expect(page.getByRole('alert')).toContainText('between 1 and 1');
  await expect(submit).toBeDisabled();
  await upload.setInputFiles(await sample(7));
  await expect(summary).toHaveText('3 of 7 pages per copy · Pages 1, 3, 7 · 2 copies');
  await expect(submit).toBeEnabled();
  await summary.scrollIntoViewIfNeeded();
  const a11y = await new AxeBuilder({ page }).analyze();
  expect(a11y.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/${info.project.name}-23-page-selection.png`,
    fullPage: true,
  });
  const response = page.waitForResponse(
    (res) => res.url().endsWith('/api/print') && res.request().method() === 'POST',
  );
  await submit.click();
  const result = await response;
  expect(result.status()).toBe(201);
  const job: Job = await result.json();
  expect(job.options).toMatchObject({
    pageRanges: '7, 1-3, 3',
    pageParity: 'odd',
    copies: 2,
    sides: 'two-sided-long-edge',
  });
  await expect(
    page.getByRole('heading', { name: 'Demo job submitted.', exact: true }),
  ).toBeVisible();
  const retained = await PDFDocument.load(
    await (await page.request.get(`/api/jobs/${job.id}/pdf`)).body(),
  );
  expect(retained.getPages().map((p) => p.getWidth() - 400)).toEqual([1, 3, 7]);
});
