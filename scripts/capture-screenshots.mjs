// Capture only synthetic demo content on a disposable, loopback-only instance.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';

const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const directory = await mkdtemp(join(tmpdir(), 'openwebprint-screenshots-'));
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: directory,
    APP_ORIGIN: origin,
    COOKIE_SECURE: 'false',
  },
});
const exited = once(server, 'exit');
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch {}
    if (server.exitCode !== null || attempt >= 100)
      throw new Error('Screenshot server failed to start.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  const page = await browser.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-GB',
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mkdir('docs/images', { recursive: true });
  async function capture(name) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `docs/images/${name}.png`, animations: 'disabled' });
  }
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Welcome to openwebprint' })).toBeVisible();
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove demo data', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Brother MFC-L2750DW', exact: true }),
  ).toBeVisible();
  await capture('overview');

  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('link', { name: 'Devices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
  await page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Brother MFC-L2750DW', exact: true }) })
    .getByRole('button', { name: 'Print', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Print document' })).toBeVisible();
  const document = await PDFDocument.create();
  const first = document.addPage([595, 842]);
  first.drawText('openwebprint', { x: 48, y: 778, size: 13 });
  first.drawText('Your next print, ready.', { x: 48, y: 700, size: 26 });
  first.drawText('Choose your printer. Review every page. Print.', { x: 48, y: 666, size: 12 });
  first.drawText('This is a sample document in demo mode.', { x: 48, y: 570, size: 11 });
  first.drawText('Your files stay on your server.', { x: 48, y: 100, size: 11 });
  document
    .addPage([595, 842])
    .drawText('A second page, just one click away.', { x: 48, y: 700, size: 22 });
  await page.getByLabel('Select document', { exact: true }).setInputFiles({
    name: 'sample-document.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await document.save()),
  });
  await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 20000 },
  );
  await capture('printing');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await navigation.getByRole('link', { name: 'Scans', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scans', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New scan', exact: true }).click();
  await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByAltText('Scanned document preview').evaluate((image) => image.decode());
  await capture('scanning');
  expect(errors).toEqual([]);
  console.log('Captured overview.png, printing.png and scanning.png from an isolated demo.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await exited;
  await rm(directory, { recursive: true, force: true });
}
