import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
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
  // A retry can resume an account created earlier in this isolated test server.
  if ((await (await page.request.get('/api/session')).json()).authenticationRequired) {
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, username, password);
    await navigate(page, 'Settings');
    await category(page, 'Users');
    const users = await (await page.request.get('/api/users')).json();
    for (const user of users)
      await page.request.delete(`/api/users/${user.id}`, { headers: { 'x-openwebprint': '1' } });
    await page.reload();
    await page.goto('/overview');
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
        ? 'docs/images/dashboard.png'
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
  await page.getByLabel('Copies', { exact: true }).fill('2');
  await accessible(page);
  await page.getByRole('button', { name: 'Start demo print', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Job submitted', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await navigate(page, 'Jobs');
  const row = page.getByRole('row').filter({ hasText: filename });
  await expect(row).toContainText('2 Copies');
  await expect(row).toContainText('Completed', { timeout: 20_000 });
  await noOverflow(page);
  await navigate(page, 'Scans');
  await expect(page).toHaveURL(/\/scans$/);
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: 'New scan', exact: true }).click();
    await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Scan complete', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByAltText('Scanned document preview')).toBeVisible();
    if (index === 0) {
      await accessible(page);
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download PDF' }).click();
      const download = await downloadEvent;
      expect(
        (await PDFDocument.load(await readFile((await download.path())!))).getPageCount(),
      ).toBe(1);
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
        const body = element.nextElementSibling!.getBoundingClientRect();
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
  await expect(page.getByRole('heading', { name: 'Brother devices' })).toBeVisible();
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
  expect(errors).toEqual([]);
});
