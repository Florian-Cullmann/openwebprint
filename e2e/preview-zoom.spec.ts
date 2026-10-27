import { test, expect, type Page, type Locator } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import type { Job, JobPage, Snapshot } from '@openwebprint/shared';
import AxeBuilder from '@axe-core/playwright';

// Exercise the backing-store limits on a high-density display in both layouts.
test.use({ deviceScaleFactor: 2 });

async function fixture(page: Page) {
  const pdf = await PDFDocument.create();
  const pageSizes: [number, number][] = [
    [595, 842],
    [1440, 720],
  ];
  for (const size of pageSizes) {
    const sheet = pdf.addPage(size);
    sheet.drawText('Synthetic preview - small text inspection', {
      x: 24,
      y: size[1] - 30,
      size: 8,
      color: rgb(0.1, 0.3, 0.7),
    });
    for (let y = 40; y < size[1] - 50; y += 18)
      sheet.drawText('Small text: 0123456789. Scroll to inspect the whole page.', {
        x: 24,
        y,
        size: 6,
      });
  }
  const buffer = Buffer.from(await pdf.save());
  const snapshot: Snapshot = {
    mode: 'demo',
    devicesCheckedAt: new Date().toISOString(),
    warnings: [],
    jobs: [],
    devices: [
      {
        id: '00000000-0000-4000-8000-000000000042',
        kind: 'printer',
        name: 'Preview fixture',
        address: 'demo://preview',
        location: 'Browser fixture',
        mode: 'demo',
        provider: 'demo',
        status: 'ready',
        capabilities: {
          color: true,
          colorModes: ['monochrome', 'color'],
          sides: ['one-sided'],
          media: ['iso_a4_210x297mm'],
        },
      },
    ],
  };
  // Simulate API responses, but exercise the actual production dialog and PDF.js renderer.
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        mode: 'demo',
        onboardingRequired: false,
        authenticationRequired: false,
        authenticated: false,
      },
    }),
  );
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/jobs?**', (route) =>
    route.fulfill({
      json: { jobs: snapshot.jobs, total: snapshot.jobs.length, offset: 0 } satisfies JobPage,
    }),
  );
  await page.route('**/api/documents/preview', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: buffer }),
  );
  await page.goto('/overview');
  await page.getByRole('button', { name: 'Print', exact: true }).first().click();
  const upload = async (name: string) =>
    page
      .getByLabel('Select document', { exact: true })
      .setInputFiles({ name, mimeType: 'application/pdf', buffer });
  await upload('small-text.pdf');
  return { buffer, snapshot, upload };
}

async function ready(page: Page, number = 1) {
  const canvas = page.getByRole('img', { name: `Document page ${number}`, exact: true });
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await expect(canvas).toBeVisible();
  return canvas;
}
async function dimensions(canvas: Locator) {
  return canvas.evaluate((element) => {
    const c = element as HTMLCanvasElement;
    return { width: c.width, height: c.height, cssWidth: c.getBoundingClientRect().width };
  });
}
async function position(viewport: Locator) {
  return viewport.evaluate((e) => ({ x: e.scrollLeft, y: e.scrollTop }));
}

test('inspect small text with zoom, pan, reset, retained previews and invalid PDFs (browser fixtures)', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { upload, snapshot, buffer } = await fixture(page);
  const canvas = await ready(page);
  const fit = await dimensions(canvas);
  const viewport = page.getByRole('region', { name: 'Document page viewport', exact: true });
  const zoom = page.getByLabel('Preview zoom', { exact: true });
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
  await expect(zoom).toHaveText('100%');
  await expect(canvas).toHaveCSS('filter', 'grayscale(1)');
  for (let i = 0; i < 4; i++) await zoomIn.click();
  await ready(page);
  await expect(zoom).toHaveText('400%');
  await expect(zoomIn).toBeDisabled();
  await page.getByRole('radio', { name: 'Color', exact: true }).check();
  await expect(canvas).toHaveCSS('filter', 'none');
  await expect(zoom).toHaveText('400%');
  await page.getByRole('radio', { name: 'Black and white', exact: true }).check();
  await expect(canvas).toHaveCSS('filter', 'grayscale(1)');
  const enlarged = await dimensions(canvas);
  expect(enlarged.cssWidth).toBeGreaterThan(fit.cssWidth * 3.8);
  expect(enlarged.width).toBeGreaterThan(fit.width * 3);
  expect(enlarged.width).toBeLessThanOrEqual(4096);
  expect(enlarged.height).toBeLessThanOrEqual(4096);
  expect(enlarged.width * enlarged.height).toBeLessThanOrEqual(8_000_000);
  // The new bitmap contains rendered ink, not just a larger empty canvas.
  expect(
    await canvas.evaluate((e) => {
      const c = e as HTMLCanvasElement;
      return c
        .getContext('2d')!
        .getImageData(0, 0, c.width, c.height)
        .data.some((v, i) => i % 4 !== 3 && v < 200);
    }),
  ).toBe(true);
  await viewport.scrollIntoViewIfNeeded();
  const rect = (await viewport.boundingBox())!;
  const from = { x: rect.x + rect.width - 35, y: rect.y + rect.height - 40 };
  const to = { x: from.x - 100, y: from.y - 130 };
  if (info.project.name === 'mobile') {
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= 5; i++)
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: from.x - i * 20, y: from.y - i * 26 }],
      });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await position(viewport)).x).toBeGreaterThan(30);
  await expect.poll(async () => (await position(viewport)).y).toBeGreaterThan(30);
  await viewport.focus();
  const before = await position(viewport);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await position(viewport)).x).toBeGreaterThan(before.x);
  await expect.poll(async () => (await position(viewport)).y).toBeGreaterThan(before.y);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  const a11y = await new AxeBuilder({ page }).analyze();
  expect(a11y.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  await page.getByRole('button', { name: 'Fit page', exact: true }).click();
  await ready(page);
  await expect(zoom).toHaveText('100%');
  expect(await position(viewport)).toEqual({ x: 0, y: 0 });
  expect((await dimensions(canvas)).cssWidth).toBeCloseTo(fit.cssWidth, 0);
  await zoomOut.click();
  await zoomOut.click();
  await ready(page);
  await expect(zoom).toHaveText('50%');
  await expect(zoomOut).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await ready(page, 2);
  await expect(zoom).toHaveText('100%');
  await zoomIn.click();
  await ready(page, 2);
  await viewport.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await position(viewport)).x).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await ready(page);
  await expect(zoom).toHaveText('100%');
  expect(await position(viewport)).toEqual({ x: 0, y: 0 });
  for (let i = 0; i < 4; i++) await zoomIn.click();
  await ready(page);
  await viewport.scrollIntoViewIfNeeded();
  await page.getByRole('dialog').evaluate((dialog) => {
    dialog.scrollTop = 0;
  });
  await page.screenshot({
    path: `test-results/${info.project.name}-42-preview-zoom.png`,
    scale: 'css',
  });
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 700 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    const fitButton = (await page
      .getByRole('button', { name: 'Fit page', exact: true })
      .boundingBox())!;
    expect(fitButton.x + fitButton.width).toBeLessThanOrEqual(320);
  }
  await viewport.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await position(viewport)).y).toBeGreaterThan(0);
  await upload('replacement-small-text.pdf');
  await ready(page);
  await expect(zoom).toHaveText('100%');
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  expect(await position(viewport)).toEqual({ x: 0, y: 0 });
  expect(errors).toEqual([]);

  await test.step('retain the preview and preserve submitted print settings', async () => {
    for (let i = 0; i < 4; i++) await zoomIn.click();
    await ready(page);
    const now = new Date().toISOString();
    const job: Job = {
      id: '00000000-0000-4000-8000-000000000043',
      deviceId: snapshot.devices[0].id,
      deviceName: snapshot.devices[0].name,
      kind: 'print',
      title: 'small-text.pdf',
      mode: 'demo',
      status: 'completed',
      hasFile: true,
      createdAt: now,
      updatedAt: now,
      options: { copies: 1, color: 'monochrome', sides: 'one-sided', media: 'iso_a4_210x297mm' },
    };
    let submitted = '';
    await page.route('**/api/print', (route) => {
      submitted = route.request().postData() ?? '';
      return route.fulfill({ status: 201, json: job });
    });
    await page.getByRole('button', { name: 'Start demo print', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Demo job submitted.', exact: true }),
    ).toBeVisible();
    expect(submitted).toContain(JSON.stringify(job.options));
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    snapshot.jobs.push(job);
    await page.route(`**/api/jobs/${job.id}/document`, (route) =>
      route.fulfill({ contentType: 'application/pdf', body: buffer }),
    );
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Jobs/ })
      .click();
    await page.getByRole('button', { name: job.title, exact: true }).click();
    await ready(page);
    await expect(page.getByLabel('Preview zoom', { exact: true })).toHaveText('100%');
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    const retainedCanvas = await ready(page, 2);
    for (let i = 0; i < 4; i++)
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await ready(page, 2);
    const size = await dimensions(retainedCanvas);
    expect(size.width).toBeLessThanOrEqual(4096);
    expect(size.height).toBeLessThanOrEqual(4096);
    expect(size.width * size.height).toBeLessThanOrEqual(8_000_000);
    if (info.project.name === 'desktop') {
      expect(size.width * size.height).toBeGreaterThan(7_990_000);
      expect(size.width).toBeLessThan(size.cssWidth * 2);
    }
    await expect(page.getByRole('link', { name: 'Download PDF', exact: true })).toBeVisible();
  });

  await test.step('show loading and invalid-document errors', async () => {
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Print', exact: true }).first().click();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/documents/preview', async (route) => {
      await gate;
      await route.fulfill({ contentType: 'application/pdf', body: 'invalid pdf' });
    });
    await page.getByLabel('Select document', { exact: true }).setInputFiles({
      name: 'invalid.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('invalid pdf'),
    });
    await expect(page.getByText('Preparing preview…', { exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('alert')).toHaveText('Unable to display this document preview.');
    await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
  });
  expect(errors).toEqual([]);
});
