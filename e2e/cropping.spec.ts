import { test, expect } from '@playwright/test';
import type { Job } from '@openwebprint/shared';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

test('crop a rotated scan with pointer and numeric controls, reopen, download, and reset (demo scanner)', async ({
  page,
}, info) => {
  await page.goto('/scans');
  if ((await (await page.request.get('/api/session')).json()).onboardingRequired)
    await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.goto('/scans');
  await page.getByRole('button', { name: 'New scan', exact: true }).click();
  await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Rotate page 1 clockwise', exact: true }).click();
  const thumbnail = page.getByAltText('Scanned page 1', { exact: true });
  await expect
    .poll(() => thumbnail.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(1754);
  const scan = (await (await page.request.get('/api/snapshot')).json()).jobs.find(
    (job: Job) => job.kind === 'scan',
  ) as Job;
  const latest = async () =>
    (await (await page.request.get('/api/snapshot')).json()).jobs.find(
      (job: Job) => job.id === scan.id,
    ) as Job;
  await page.getByRole('button', { name: 'Crop page 1', exact: true }).click();
  const left = page.getByRole('spinbutton', { name: 'Left (px)', exact: true });
  const top = page.getByRole('spinbutton', { name: 'Top (px)', exact: true });
  const width = page.getByRole('spinbutton', { name: 'Width (px)', exact: true });
  const height = page.getByRole('spinbutton', { name: 'Height (px)', exact: true });
  await width.fill('600');
  await height.fill('900');
  await left.fill('100');
  await top.fill('200');
  const canvas = page.getByRole('img', { name: 'Crop selection for page 1', exact: true });
  await canvas.scrollIntoViewIfNeeded();
  const rect = (await canvas.boundingBox())!;
  // Coordinates on the 90° clockwise view, converted from known original pixels.
  const position = (x: number, y: number) => ({
    x: rect.x + ((1754 - y) / 1754) * rect.width,
    y: rect.y + (x / 1240) * rect.height,
  });
  const touch =
    info.project.name === 'mobile' ? await page.context().newCDPSession(page) : undefined;
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    if (touch) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 5 });
      await page.mouse.up();
    }
  };
  // Resize the bottom-right original corner, then move and draw a new rectangle.
  await drag(position(700, 1100), position(800, 1300));
  expect(Math.abs(Number(await width.inputValue()) - 700)).toBeLessThanOrEqual(6);
  expect(Math.abs(Number(await height.inputValue()) - 1100)).toBeLessThanOrEqual(6);
  await drag(position(300, 500), position(320, 530));
  expect(Math.abs(Number(await left.inputValue()) - 120)).toBeLessThanOrEqual(6);
  expect(Math.abs(Number(await top.inputValue()) - 230)).toBeLessThanOrEqual(6);
  await drag(position(20, 30), position(500, 1000));
  expect(Math.abs(Number(await width.inputValue()) - 480)).toBeLessThanOrEqual(6);
  expect(Math.abs(Number(await height.inputValue()) - 970)).toBeLessThanOrEqual(6);
  await touch?.detach();
  // Numeric controls also work with a keyboard and keep invalid drafts local.
  await width.fill('0');
  await expect(page.getByRole('button', { name: 'Apply crop', exact: true })).toBeDisabled();
  await width.fill('600');
  await height.fill('900');
  await left.fill('100');
  await top.fill('200');
  await left.focus();
  await page.keyboard.press('ArrowUp');
  await expect(left).toHaveValue('101');
  await page.keyboard.press('ArrowDown');
  await expect(left).toHaveValue('100');
  const a11y = await new AxeBuilder({ page }).analyze();
  expect(
    a11y.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? '')),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/${info.project.name}-scan-crop.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Apply crop', exact: true }).click();
  await expect
    .poll(() =>
      thumbnail.evaluate((img) => [
        (img as HTMLImageElement).naturalWidth,
        (img as HTMLImageElement).naturalHeight,
      ]),
    )
    .toEqual([900, 600]);
  await expect(page.getByRole('button', { name: 'Crop page 1', exact: true })).toBeFocused();
  expect((await latest()).pages![0].crop).toEqual({ x: 100, y: 200, width: 600, height: 900 });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download PDF', exact: true }).click();
  const pdf = await PDFDocument.load(await readFile((await (await downloadEvent).path())!));
  const pdfPage = pdf.getPage(0);
  expect(pdfPage.getRotation().angle).toBe(90);
  expect(pdfPage.getWidth() / pdfPage.getHeight()).toBeCloseTo(600 / 900);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page
    .getByRole('button', { name: /^Open scan preview:/ })
    .first()
    .click();
  await expect
    .poll(() =>
      thumbnail.evaluate((img) => [
        (img as HTMLImageElement).naturalWidth,
        (img as HTMLImageElement).naturalHeight,
      ]),
    )
    .toEqual([900, 600]);
  await page.getByRole('button', { name: 'Crop page 1', exact: true }).click();
  await expect(left).toHaveValue('100');
  await expect(height).toHaveValue('900');
  // Cancelling a draft leaves the published document alone.
  await width.fill('500');
  await page.getByRole('button', { name: 'Cancel crop', exact: true }).click();
  expect((await latest()).pages![0].crop!.width).toBe(600);
  await page.getByRole('button', { name: 'Crop page 1', exact: true }).click();
  await page.getByRole('button', { name: 'Reset crop', exact: true }).click();
  await expect
    .poll(() =>
      thumbnail.evaluate((img) => [
        (img as HTMLImageElement).naturalWidth,
        (img as HTMLImageElement).naturalHeight,
      ]),
    )
    .toEqual([1754, 1240]);
  expect((await latest()).pages![0]).not.toHaveProperty('crop');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  expect(
    (
      await page.request.delete(`/api/jobs/${scan.id}`, { headers: { 'x-openwebprint': '1' } })
    ).status(),
  ).toBe(200);
});
