import { expect, type Page } from '@playwright/test';
import { isolatedTest } from './isolated-server';

const test = isolatedTest();
test.use({ locale: 'en-GB' });

async function navigate(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name, exact: true })
    .click();
}

for (const failure of ['getItem', 'setItem', 'storage access'] as const) {
  test(`${failure} failure preserves setup, sign-in and appearance controls`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((failure) => {
      if (failure === 'storage access') {
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw new DOMException('Storage denied', 'SecurityError');
          },
        });
      } else {
        Storage.prototype[failure] = () => {
          throw new DOMException(
            'Storage denied',
            failure === 'setItem' ? 'QuotaExceededError' : 'SecurityError',
          );
        };
      }
    }, failure);
    await page.goto('/overview');
    await expect(page.getByRole('heading', { name: 'Welcome to openwebprint' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Try demo', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await navigate(page, 'Settings');
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('preferences-user');
    await page.getByLabel('Password', { exact: true }).fill('sample-password');
    await page.getByLabel('Confirm password', { exact: true }).fill('sample-password');
    await page.getByRole('button', { name: 'Add user', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await page.reload();
    await page.getByLabel('Username', { exact: true }).fill('preferences-user');
    await page.getByLabel('Password', { exact: true }).fill('sample-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await navigate(page, 'Scans');
    await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'List view' }).click();
    await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await navigate(page, 'Overview');
    await navigate(page, 'Scans');
    await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Grid view' }).click();
    await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(errors).toEqual([]);
  });
}

test('persisted appearance preferences load and changes survive reload', async ({ page }) => {
  await page.goto('/overview');
  await page.evaluate(() => {
    localStorage.setItem('owp-theme', 'dark');
    localStorage.setItem('owp-scan-layout', 'list');
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await navigate(page, 'Scans');
  await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Grid view' }).click();
  await page.getByRole('button', { name: 'Change color scheme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
