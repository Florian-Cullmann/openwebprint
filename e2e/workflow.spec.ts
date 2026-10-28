import { expect, type Page } from '@playwright/test';
import { isolatedTest } from './isolated-server';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
const test = isolatedTest();
// Publishing full-resolution multi-page PDFs can exceed Playwright's default 5s on CI.
const expectScan = expect.configure({ timeout: 15_000 });
async function navigate(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: new RegExp(`^${name}`) })
    .click();
}
async function category(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Settings categories' })
    .getByRole('link', { name, exact: true })
    .click();
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}
async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations
      .filter((v) => ['critical', 'serious'].includes(v.impact ?? ''))
      .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
  ).toEqual([]);
}
async function addUser(page: Page, username: string, password: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
}
async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('open access → routes → print → scans → users → login → settings tabs', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const username = `${info.project.name}-user`;
  const second = `${info.project.name}-second`;
  const password = 'a';
  await page.goto('/overview');
  const status = await (await page.request.get('/api/session')).json();
  if (status.onboardingRequired) {
    await expect(page.getByRole('heading', { name: 'Welcome to openwebprint' })).toBeVisible();
    await accessible(page);
    await page.getByRole('button', { name: 'Try demo', exact: true }).click();
    await expect(page).toHaveURL(/\/overview$/);
  }
  const existingScans = (await (await page.request.get('/api/snapshot')).json()).jobs.filter(
    (job: { kind: string }) => job.kind === 'scan',
  ).length;
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Brother MFC-L2750DW', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await noOverflow(page);
  await accessible(page);
  await page.screenshot({
    path:
      info.project.name === 'desktop'
        ? 'test-results/desktop-overview.png'
        : 'test-results/mobile-dashboard.png',
    fullPage: true,
  });
  await navigate(page, 'Devices');
  await expect(page).toHaveURL(/\/devices$/);
  await navigate(page, 'Jobs');
  await expect(page).toHaveURL(/\/jobs$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/devices$/);
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/jobs$/);
  await navigate(page, 'Overview');
  await page.getByRole('button', { name: 'Print', exact: true }).first().click();
  const png = await sharp({
    create: { width: 200, height: 300, channels: 3, background: '#eeeeef' },
  })
    .png()
    .toBuffer();
  const filename = `${info.project.name}-${Date.now()}-document.png`;
  await page
    .getByLabel('Select document', { exact: true })
    .setInputFiles({ name: filename, mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 20000 },
  );
  expect(
    await page.getByRole('img', { name: 'Document page 1', exact: true }).evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return [
        ...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
      ].some((value, index) => index % 4 !== 3 && value < 240);
    }),
  ).toBe(true);
  const multiple = await PDFDocument.create();
  multiple.addPage().drawText('First preview page');
  multiple.addPage().drawText('Second preview page');
  await page.getByLabel('Select document', { exact: true }).setInputFiles({
    name: 'two-pages.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await multiple.save()),
  });
  await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Document page 2', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page
    .getByLabel('Select document', { exact: true })
    .setInputFiles({ name: filename, mimeType: 'image/png', buffer: png });
  await expect(page.getByText('Page 1 of 1', { exact: true })).toBeVisible();
  await page.getByLabel('Copies', { exact: true }).fill('2');
  await accessible(page);
  await page.getByRole('button', { name: 'Start demo print', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Job submitted', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await navigate(page, 'Jobs');
  const row = page.getByRole('row').filter({ hasText: filename });
  await expect(row).toContainText('2 Copies');
  await expect(row).toContainText('Completed', { timeout: 20_000 });
  await row.getByRole('button', { name: filename, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Document preview', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page
    .getByRole('row')
    .filter({ hasText: filename })
    .getByRole('button', { name: filename, exact: true })
    .click();
  await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await noOverflow(page);
  await navigate(page, 'Scans');
  await expect(page).toHaveURL(/\/scans$/);
  const scanner = (await (await page.request.get('/api/snapshot')).json()).devices.find(
    (device: { kind: string }) => device.kind === 'scanner',
  );
  await page.request.delete(`/api/devices/${scanner.id}`, { headers: { 'x-openwebprint': '1' } });
  await page.reload();
  await page.getByRole('button', { name: 'New scan', exact: true }).click();
  await page.getByRole('button', { name: 'Find and add a scanner', exact: true }).click();
  await page.getByRole('button', { name: 'Search devices', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Brother MFC-L2750DW · Scanner', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connected', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Scanner', exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: 'New scan', exact: true }).click();
    await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByAltText('Scanned page 1')).toBeVisible();
    if (index === 0) {
      await accessible(page);
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download PDF' }).click();
      const download = await downloadEvent;
      expect(
        (await PDFDocument.load(await readFile((await download.path())!))).getPageCount(),
      ).toBe(1);
      await page.getByRole('button', { name: 'Scan another page', exact: true }).click();
      await expectScan(page.getByAltText('Scanned page 2')).toBeVisible();
      await page
        .getByRole('combobox', { name: 'Paper source', exact: true })
        .selectOption('ADF Duplex');
      await page.getByRole('button', { name: 'Scan multiple pages', exact: true }).click();
      await expectScan(page.getByAltText('Scanned page 6')).toBeVisible();
      const state = await (await page.request.get('/api/snapshot')).json();
      const scan = state.jobs.find((job: { kind: string }) => job.kind === 'scan');
      expect(scan.pages).toHaveLength(6);
      expect(state.jobs.filter((job: { kind: string }) => job.kind === 'scan')).toHaveLength(
        existingScans + 1,
      );
      await page.getByRole('button', { name: 'Rotate page 1 clockwise', exact: true }).click();
      await expectScan
        .poll(() =>
          page
            .getByAltText('Scanned page 1')
            .evaluate((image) => [
              (image as HTMLImageElement).naturalWidth,
              (image as HTMLImageElement).naturalHeight,
            ]),
        )
        .toEqual([512, 362]);
      await page.getByRole('button', { name: 'Move page 1 later', exact: true }).click();
      await expectScan
        .poll(() =>
          page
            .getByAltText('Scanned page 2')
            .evaluate((image) => [
              (image as HTMLImageElement).naturalWidth,
              (image as HTMLImageElement).naturalHeight,
            ]),
        )
        .toEqual([512, 362]);
      if (info.project.name === 'desktop') {
        const list = page.getByRole('list', { name: 'Scanned pages' });
        const savedOrder = async () =>
          (await (await page.request.get('/api/snapshot')).json()).jobs
            .find((job: { id: string }) => job.id === scan.id)
            .pages.map((page: { id: string }) => page.id);
        const cards = list.locator('[data-page-id]');
        const beginDrag = async (fromIndex: number, toIndex: number, after: boolean | 'center') => {
          const from = (await cards.nth(fromIndex).boundingBox())!;
          const to = (await cards.nth(toIndex).boundingBox())!;
          const x =
            after === 'center' ? to.x + to.width / 2 : after ? to.x + to.width - 10 : to.x + 10;
          await page.mouse.move(from.x + from.width / 2, from.y + 40);
          await page.mouse.down();
          await page.mouse.move(from.x + from.width / 2 - 12, from.y + 45, { steps: 3 });
          await page.mouse.move(x, to.y + 60, { steps: 8 });
          await page.mouse.move(x, to.y + 60);
        };
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        const shift = await cards.evaluateAll(
          (nodes) => (nodes[1] as HTMLElement).offsetLeft - (nodes[0] as HTMLElement).offsetLeft,
        );
        const beforeDrag = await savedOrder();
        await beginDrag(1, 0, 'center');
        await expect(list.locator('[data-insertion-index="0"]')).toBeVisible();
        await expect(cards.nth(0)).toHaveCSS('transform', `matrix(1, 0, 0, 1, ${shift}, 0)`);
        expect(await savedOrder()).toEqual(beforeDrag);
        await page.mouse.up();
        await expectScan
          .poll(() =>
            page
              .getByAltText('Scanned page 1')
              .evaluate((image) => [
                (image as HTMLImageElement).naturalWidth,
                (image as HTMLImageElement).naturalHeight,
              ]),
          )
          .toEqual([512, 362]);
        await expectScan(list.locator('[data-insertion-index]')).toHaveCount(0);
        const afterDrag = await savedOrder();
        expect(afterDrag).toEqual([beforeDrag[1], beforeDrag[0], ...beforeDrag.slice(2)]);
        // Dropping onto a preview's center works in both directions, repeatedly.
        await beginDrag(0, 1, 'center');
        await page.mouse.up();
        await expectScan(list.locator('[data-insertion-index]')).toHaveCount(0);
        expect(await savedOrder()).toEqual(beforeDrag);
        await beginDrag(1, 0, 'center');
        await page.mouse.up();
        await expectScan(list.locator('[data-insertion-index]')).toHaveCount(0);
        expect(await savedOrder()).toEqual(afterDrag);
        await beginDrag(0, 1, true);
        await expect(list.locator('[data-insertion-index="1"]')).toBeVisible();
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expectScan(list.locator('[data-insertion-index]')).toHaveCount(0);
        expect(await savedOrder()).toEqual(afterDrag);
        // Captured pointer movement also scrolls a long gallery without saving until release.
        await page.setViewportSize({ width: 1440, height: 700 });
        await cards.nth(0).scrollIntoViewIfNeeded();
        const first = (await cards.nth(0).boundingBox())!;
        const pane = await list.evaluate((element) =>
          element.parentElement!.getBoundingClientRect().toJSON(),
        );
        const scrollBefore = await list.evaluate((element) => element.parentElement!.scrollTop);
        await page.mouse.move(first.x + first.width / 2, first.y + 40);
        await page.mouse.down();
        await page.mouse.move(first.x + first.width / 2 + 12, first.y + 45, { steps: 3 });
        await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 8, { steps: 5 });
        await expectScan
          .poll(() => list.evaluate((element) => element.parentElement!.scrollTop))
          .toBeGreaterThan(scrollBefore + 20);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expectScan(list.locator('[data-insertion-index]')).toHaveCount(0);
        expect(await savedOrder()).toEqual(afterDrag);
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }
      await expectScan(page.getByRole('list', { name: 'Scanned pages' })).toHaveAttribute(
        'aria-busy',
        'false',
      );
      const editedDownload = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download PDF' }).click();
      const edited = await PDFDocument.load(await readFile((await (await editedDownload).path())!));
      expect(edited.getPageCount()).toBe(6);
      expect(edited.getPage(info.project.name === 'desktop' ? 0 : 1).getRotation().angle).toBe(90);
      await accessible(page);
      await noOverflow(page);
      await page.screenshot({
        path: `test-results/${info.project.name}-multipage-scan.png`,
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await page.reload();
  await expect(page).toHaveURL(/\/scans$/);
  const previews = page.getByRole('button', { name: /^Open scan preview:/ });
  await expect(previews).toHaveCount(existingScans + 2);
  // Regression: tall document images must stay inside the thumbnail, above the text/actions.
  for (const button of await previews.all()) {
    const image = button.locator('img');
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate(
          (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
        ),
      )
      .toBe(true);
    expect(
      await button.evaluate((element) => {
        const thumb = element.getBoundingClientRect();
        const img = element.querySelector('img')!.getBoundingClientRect();
        // ZIP selection wraps the thumbnail; find the body through its document heading.
        const body = element
          .closest('article')!
          .querySelector('h3')!
          .parentElement!.getBoundingClientRect();
        return (
          img.top >= thumb.top &&
          img.bottom <= thumb.bottom &&
          img.left >= thumb.left &&
          img.right <= thumb.right &&
          body.top >= thumb.bottom
        );
      }),
    ).toBe(true);
  }
  await noOverflow(page);
  await accessible(page);
  await page.screenshot({ path: `test-results/${info.project.name}-scans.png`, fullPage: true });
  await navigate(page, 'Devices');
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await page.getByRole('button', { name: 'Search devices', exact: true }).click();
  await expect(page.getByText('3 DEVICES FOUND')).toBeVisible();
  await page.getByRole('button', { name: 'Add manually' }).click();
  await page.getByLabel('Name', { exact: true }).fill(`Brother Lab ${info.project.name}`);
  await page.getByLabel('Demo address').fill(`demo://lab-${info.project.name}`);
  await page.getByLabel('Location').fill('Lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Add device', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: `Brother Lab ${info.project.name}` }),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/devices$/);
  await expect(
    page.getByRole('heading', { name: `Brother Lab ${info.project.name}` }),
  ).toBeVisible();
  await navigate(page, 'Settings');
  await expect(page).toHaveURL(/\/settings\/general$/);
  await category(page, 'Users');
  await expect(page).toHaveURL(/\/settings\/users$/);
  await page.reload();
  await addUser(page, username, password);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect((await page.request.get('/api/snapshot')).status()).toBe(401);
  await signIn(page, username, password);
  await expect(page).toHaveURL(/\/settings\/users$/);
  await page.getByLabel('Current password', { exact: true }).fill('wrong');
  await page.getByLabel('New password', { exact: true }).fill('changed-password');
  await page.getByLabel('Confirm new password', { exact: true }).fill('mismatch');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('New passwords do not match.');
  await page.getByLabel('Confirm new password', { exact: true }).fill('changed-password');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Current password is incorrect.');
  await page.getByLabel('Current password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(
    page.getByText('Password changed. Other sessions have been signed out.'),
  ).toBeVisible();
  await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, username, password);
  await expect(page.getByRole('alert')).toHaveText('Incorrect username or password.');
  await signIn(page, username, 'changed-password');
  await expect(page).toHaveURL(/\/settings\/users$/);
  await addUser(page, second, password);
  await expect(page.getByText(second, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, second, password);
  await expect(page).toHaveURL(/\/settings\/users$/);
  for (const name of [username, second]) {
    await page.getByRole('button', { name: `Remove user: ${name}`, exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Remove user', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await expect(page.getByText('There are no users.', { exact: false })).toBeVisible();
  await page.reload();
  expect((await (await page.request.get('/api/session')).json()).authenticationRequired).toBe(
    false,
  );
  await category(page, 'Hardware');
  await expect(page).toHaveURL(/\/settings\/hardware$/);
  await expect(page.getByRole('heading', { name: 'Printers and scanners' })).toBeVisible();
  await category(page, 'Appearance');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await noOverflow(page);
  await accessible(page);
  await navigate(page, 'Overview');
  await page.screenshot({ path: `test-results/${info.project.name}-dark.png`, fullPage: true });
  // Leaving the demo is a real persisted transition, not a client-only toggle.
  await page.getByRole('button', { name: 'Remove demo data', exact: true }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Connect your devices' })).toBeVisible();
  const clean = await (await page.request.get('/api/snapshot')).json();
  expect(clean.mode).toBe('hardware');
  expect(clean.jobs).toEqual([]);
  expect(clean.devices).toEqual([]);
  const skip = page.getByRole('button', { name: 'Continue without devices', exact: true });
  await expect(skip).toBeEnabled({ timeout: 45_000 });
  await skip.click();
  await expect(page.getByRole('heading', { name: 'Where should scans be saved?' })).toBeVisible();
  const setup = await (await page.request.get('/api/onboarding')).json();
  await page.getByLabel('Scan storage folder', { exact: true }).fill('relative/path');
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('absolute server folder');
  await page.getByLabel('Scan storage folder', { exact: true }).fill(setup.scanRoot);
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('heading', { name: 'No devices yet' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/overview$/);
  expect((await (await page.request.get('/api/onboarding')).json()).phase).toBe('complete');
  await noOverflow(page);
  expect(errors).toEqual([]);
});
