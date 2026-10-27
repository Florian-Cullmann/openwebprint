import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Job, JobPage, Snapshot } from '@openwebprint/shared';
import { PDFDocument } from 'pdf-lib';
import { isolatedTest } from './isolated-server';

const test = isolatedTest();
const mutationHeaders = { 'x-openwebprint': '1' };
async function startDemo(page: Page) {
  await page.goto('/overview');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}
async function savedScan(page: Page) {
  await startDemo(page);
  await page.goto('/scans');
  await page.getByRole('button', { name: 'New scan', exact: true }).click();
  await page.getByRole('slider', { name: 'Resolution', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeEnabled({
    timeout: 15_000,
  });
  const snapshot: Snapshot = await (await page.request.get('/api/snapshot')).json();
  return snapshot.jobs.find((job) => job.kind === 'scan')!;
}
async function readyPrint(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Print', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Print document', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.getByLabel('Select document', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start demo print', exact: true })).toBeEnabled();
}

test('scan → print → retained PDF reprint with explicit destination/options (demo providers)', async ({
  page,
}, info) => {
  let uploads = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/(print|documents\/preview)$/.test(new URL(request.url()).pathname)
    )
      uploads++;
  });
  const source = await savedScan(page);
  const original = await (await page.request.get(`/api/jobs/${source.id}/pdf`)).body();
  await readyPrint(page);
  await page
    .getByRole('combobox', { name: 'Printer', exact: true })
    .selectOption({ label: 'Epson EcoTank ET-4850' });
  await page.getByRole('radio', { name: 'Color', exact: true }).check();
  await page
    .getByRole('combobox', { name: 'Sides', exact: true })
    .selectOption('two-sided-short-edge');
  await page.getByLabel('Copies', { exact: true }).fill('2');
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
    path: `test-results/${info.project.name}-31-saved-print.png`,
    fullPage: true,
  });
  const response = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/jobs/${source.id}/print`) && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start demo print', exact: true }).click();
  const first: Job = await (await response).json();
  expect(first).toMatchObject({
    deviceName: 'Epson EcoTank ET-4850',
    options: { copies: 2, color: 'color', sides: 'two-sided-short-edge' },
  });
  expect(first.id).not.toBe(source.id);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const snapshot: Snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(snapshot.jobs.find((job) => job.id === source.id)).toEqual(source);
  await page.goto('/jobs');
  await page.getByRole('button', { name: `Open preview: ${first.title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Document preview', exact: true })).toBeVisible();
  await readyPrint(page);
  const reprint = page.waitForResponse(
    (res) => res.url().endsWith(`/api/jobs/${first.id}/print`) && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start demo print', exact: true }).click();
  const second: Job = await (await reprint).json();
  expect(new Set([source.id, first.id, second.id]).size).toBe(3);
  expect(
    (await page.request.delete(`/api/jobs/${source.id}`, { headers: mutationHeaders })).ok(),
  ).toBe(true);
  for (const job of [first, second])
    expect(await (await page.request.get(`/api/jobs/${job.id}/pdf`)).body()).toEqual(original);
  expect(uploads).toBe(0);
});

test('source deletion between preview and submission produces a recoverable error and no print', async ({
  page,
}) => {
  const source = await savedScan(page);
  await readyPrint(page);
  expect(
    (await page.request.delete(`/api/jobs/${source.id}`, { headers: mutationHeaders })).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Start demo print', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Upload it again or create a new scan.');
  const snapshot: Snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(snapshot.jobs).toEqual([]);
});

for (const outcome of ['unknown job', 'lost response']) {
  test(`warns about duplicate output for an unknown source and never retries a ${outcome} (controlled responses)`, async ({
    page,
  }) => {
    await page.clock.install();
    await startDemo(page);
    const snapshot: Snapshot = await (await page.request.get('/api/snapshot')).json();
    const document = await PDFDocument.create();
    document.addPage().drawText('Controlled retained PDF');
    const uploaded = await page.request.post('/api/print', {
      headers: mutationHeaders,
      multipart: {
        deviceId: snapshot.devices.find((d) => d.kind === 'printer')!.id,
        options: '{}',
        file: {
          name: 'retained.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(await document.save()),
        },
      },
    });
    expect(uploaded.status()).toBe(201);
    const source: Job = { ...(await uploaded.json()), status: 'unknown' };
    // Render the real UI using an explicitly unknown history fixture.
    await page.route('**/api/jobs?*', (route) =>
      route.fulfill({
        json: { jobs: [source], total: 1, offset: 0 } satisfies JobPage,
      }),
    );
    await page.goto('/jobs');
    await page.getByRole('button', { name: 'Open preview: retained.pdf', exact: true }).click();
    await readyPrint(page);
    await expect(page.getByRole('alert')).toContainText('may produce duplicate output');
    let submissions = 0;
    await page.route(`**/api/jobs/${source.id}/print`, (route) => {
      submissions++;
      return outcome === 'unknown job'
        ? route.fulfill({
            status: 201,
            json: {
              ...source,
              id: '00000000-0000-4000-8000-999999999999',
              error: 'Submission unconfirmed. Check the printer.',
            },
          })
        : route.abort('failed');
    });
    expect(submissions).toBe(0);
    await page.getByRole('button', { name: 'Start demo print', exact: true }).click();
    if (outcome === 'unknown job')
      await expect(
        page.getByRole('heading', { name: 'Submission unconfirmed', exact: true }),
      ).toBeVisible();
    else {
      await expect(
        page.getByText('The submission could not be confirmed.', { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Start demo print', exact: true }),
      ).toBeDisabled();
    }
    await page.clock.runFor(10_000);
    expect(submissions).toBe(1);
  });
}
