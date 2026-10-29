// Real UI recordings, called only by the disposable screenshot runner.
import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

const exec = promisify(execFile);
const viewport = { width: 1200, height: 1000 };
const pause = (page, milliseconds = 1500) => page.waitForTimeout(milliseconds);
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function click(page, locator) {
  await locator.hover();
  await pause(page, 300);
  await locator.click();
}

export async function captureDemos(browser, origin, directory) {
  // Fail before recording if the optional local conversion tools are missing.
  await exec('ffmpeg', ['-version']);
  await exec('ffprobe', ['-version']);
  const metadata = [];
  async function record(name, journey) {
    const context = await browser.newContext({
      baseURL: origin,
      viewport,
      deviceScaleFactor: 1,
      locale: 'en-GB',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      recordVideo: { dir: directory, size: viewport },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const video = page.video();
    try {
      await journey(page);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
    const source = await video.path();
    const output = `docs/images/${name}.gif`;
    // Keep native resolution so labels remain readable when opened at full size.
    // A single play avoids endlessly moving content next to installation instructions.
    await exec('ffmpeg', [
      '-y',
      '-i',
      source,
      '-filter_complex',
      '[0:v]fps=8,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
      '-loop',
      '-1',
      output,
    ]);
    const { stdout } = await exec('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=width,height,nb_frames',
      '-of',
      'json',
      output,
    ]);
    const info = JSON.parse(stdout);
    metadata.push({
      file: output,
      ...info.streams[0],
      seconds: Number(info.format.duration),
      bytes: (await stat(output)).size,
      framesPerSecond: 8,
      plays: 1,
    });
  }

  const pdf = await PDFDocument.create();
  for (const [index, title] of [
    'A small idea, on paper.',
    'Ready for your next meeting.',
    'Keep a copy.',
  ].entries()) {
    const sheet = pdf.addPage([595, 842]);
    sheet.drawText('openwebprint / sample document', { x: 48, y: 778, size: 13 });
    sheet.drawText(title, { x: 48, y: 690, size: 25 });
    sheet.drawText('A project-owned sample. No personal data.', { x: 48, y: 640, size: 12 });
    sheet.drawText(`Demo mode - simulated printing / Page ${index + 1}`, {
      x: 48,
      y: 80,
      size: 11,
    });
  }
  await record('demo-print', async (page) => {
    await page.goto('/overview');
    await click(page, button(page, 'Print').first());
    await pause(page, 1000);
    await page.getByLabel('Select document', { exact: true }).setInputFiles({
      name: 'sample-document.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 20000 },
    );
    await pause(page);
    await click(page, button(page, 'Next page'));
    await expect(page.getByRole('img', { name: 'Document page 2', exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await pause(page, 1000);
    await page.getByRole('combobox', { name: 'Pages', exact: true }).selectOption('custom');
    await page.getByRole('textbox', { name: 'Page range', exact: true }).fill('1-2');
    await pause(page, 1000);
    await page
      .getByRole('combobox', { name: 'Sides', exact: true })
      .selectOption('two-sided-long-edge');
    await pause(page, 1800);
    await page.screenshot({ path: 'docs/images/demo-print-still.png' });
    await click(page, button(page, 'Start demo print'));
    await expect(
      page.getByRole('heading', { name: 'Demo job submitted.', exact: true }),
    ).toBeVisible();
    await pause(page, 1500);
    await click(page, button(page, 'Done'));
    await click(
      page,
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Jobs', exact: true }),
    );
    const job = page.getByRole('row').filter({ hasText: 'sample-document.pdf' });
    await expect(job).toContainText('Completed', { timeout: 20000 });
    await pause(page, 2500);
  });

  await record('demo-scan', async (page) => {
    await page.goto('/scans');
    await click(page, button(page, 'New scan'));
    await pause(page, 1500);
    await click(page, button(page, 'Start demo scan'));
    await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible({
      timeout: 15000,
    });
    await pause(page);
    await click(page, button(page, 'Scan another page'));
    await expect(page.getByAltText('Scanned page 2', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await pause(page);
    await click(page, button(page, 'Rotate page 1 clockwise'));
    await expect
      .poll(() =>
        page
          .getByAltText('Scanned page 1', { exact: true })
          .evaluate((img) => img.naturalWidth > img.naturalHeight),
      )
      .toBe(true);
    await pause(page);
    await click(page, button(page, 'Move page 1 later'));
    await expect
      .poll(() =>
        page
          .getByAltText('Scanned page 2', { exact: true })
          .evaluate((img) => img.naturalWidth > img.naturalHeight),
      )
      .toBe(true);
    await pause(page);
    await page
      .getByRole('heading', { name: 'Scan complete', exact: true })
      .scrollIntoViewIfNeeded();
    await pause(page, 1000);
    await page.screenshot({ path: 'docs/images/demo-scan-still.png' });
    const downloaded = page.waitForEvent('download');
    await click(page, page.getByRole('link', { name: 'Download PDF', exact: true }));
    const download = await downloaded;
    const exported = await PDFDocument.load(await readFile(await download.path()));
    expect(exported.getPageCount()).toBe(2);
    expect(exported.getPages().map((sheet) => sheet.getRotation().angle)).toEqual([0, 90]);
    await pause(page, 2500);
  });
  await writeFile('docs/images/demo-metadata.json', `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(metadata);
}
