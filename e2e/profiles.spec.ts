import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from 'pdf-lib';
import type { SettingsProfile, Snapshot } from '@openwebprint/shared';
import { isolatedTest } from './isolated-server';

const test = isolatedTest();
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const saved = (page: Page) => page.getByRole('combobox', { name: 'Saved profile', exact: true });
async function setup(page: Page) {
  await page.goto('/overview');
  await button(page, 'Try demo').click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
}
async function proof(page: Page, project: string, kind: string) {
  await page
    .getByRole('group', { name: 'Settings profiles', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/${project}-29-${kind}-profiles.png`,
    fullPage: true,
  });
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('print profiles survive reload, restore settings, update/delete and leave page selections on the current document', async ({
  page,
}, info) => {
  await setup(page);
  await button(page, 'Print').first().click();
  const sides = page.getByRole('combobox', { name: 'Sides', exact: true });
  const copies = page.getByLabel('Copies', { exact: true });
  const name = page.getByLabel('Profile name', { exact: true });
  await sides.selectOption('two-sided-long-edge');
  await copies.fill('2');
  await name.fill('Everyday A4 duplex');
  await button(page, 'Save new profile').click();
  await expect(page.getByRole('status').filter({ hasText: 'Profile saved.' })).toBeVisible();
  await page.reload();
  await button(page, 'Print').first().click();
  await saved(page).selectOption({ label: 'Everyday A4 duplex' });
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Safe profile test document');
  pdf.addPage().drawText('Second page');
  await page.getByLabel('Select document', { exact: true }).setInputFiles({
    name: 'profile-example.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await page.getByRole('combobox', { name: 'Pages', exact: true }).selectOption('custom');
  await page.getByLabel('Page range', { exact: true }).fill('2');
  await button(page, 'Apply profile').click();
  await expect(copies).toHaveValue('2');
  await expect(sides).toHaveValue('two-sided-long-edge');
  await expect(page.getByLabel('Page range', { exact: true })).toHaveValue('2');
  await copies.fill('3');
  await name.fill('Updated everyday duplex');
  await button(page, 'Update profile').click();
  await expect(saved(page).locator('option:checked')).toHaveText('Updated everyday duplex');
  await expect(
    page.getByText('Profile updated with the current settings.', { exact: true }),
  ).toBeVisible();
  await copies.fill('1');
  await button(page, 'Apply profile').click();
  await expect(copies).toHaveValue('3');
  await proof(page, info.project.name, 'print');
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/print') && r.request().method() === 'POST',
  );
  await button(page, 'Start demo print').click();
  expect((await (await response).json()).options).toMatchObject({
    copies: 3,
    sides: 'two-sided-long-edge',
    pageRanges: '2',
  });
  await button(page, 'Done').click();
  await button(page, 'Print').first().click();
  await saved(page).selectOption({ label: 'Updated everyday duplex' });
  await button(page, 'Delete profile').click();
  await expect(saved(page).locator('option')).toHaveText(['No saved profiles']);
});

test('scan profiles restore source-specific settings, reject incompatible apply without changing the form, and submit restored settings', async ({
  page,
}, info) => {
  await setup(page);
  await button(page, 'Scan').first().click();
  const source = page.getByRole('combobox', { name: 'Paper source', exact: true });
  const gray = page.getByRole('radio', { name: 'Grayscale', exact: true });
  const color = page.getByRole('radio', { name: 'Color', exact: true });
  const resolution = page.getByRole('slider', { name: 'Resolution', exact: true });
  await source.selectOption('ADF');
  await expect(resolution).toBeEnabled();
  await gray.check();
  await page.getByLabel('Profile name', { exact: true }).fill('300 dpi grayscale');
  await button(page, 'Save new profile').click();
  await expect(page.getByRole('status').filter({ hasText: 'Profile saved.' })).toBeVisible();
  await page.reload();
  await button(page, 'Scan').first().click();
  await saved(page).selectOption({ label: '300 dpi grayscale' });
  await button(page, 'Apply profile').click();
  await expect(source).toHaveValue('ADF');
  await expect(gray).toBeChecked();
  await expect(resolution).toHaveAttribute('aria-valuetext', '300 dpi');
  await color.check();
  await page.route('**/profiles/*/apply', (route) =>
    route.fulfill({
      status: 409,
      json: { error: 'This scanner no longer supports the saved resolution (browser fixture).' },
    }),
  );
  await button(page, 'Apply profile').click();
  await expect(page.getByRole('alert')).toContainText('no longer supports the saved resolution');
  await expect(color).toBeChecked();
  await page.unroute('**/profiles/*/apply');
  await button(page, 'Apply profile').click();
  await expect(gray).toBeChecked();
  await proof(page, info.project.name, 'scan');
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/scans') && r.request().method() === 'POST',
  );
  await button(page, 'Start demo scan').click();
  expect((await (await response).json()).options).toMatchObject({
    resolution: 300,
    color: 'Gray',
    source: 'ADF',
    duplex: false,
  });
});

test('an applied print profile keeps unsupported values and blocks printing when capabilities change (snapshot fixture)', async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  const snapshot: Snapshot = await (await page.request.get('/api/snapshot')).json();
  const printer = snapshot.devices.find((device) => device.kind === 'printer')!;
  const created = await page.request.post(`/api/devices/${printer.id}/profiles`, {
    headers: { 'x-openwebprint': '1' },
    data: {
      name: 'Duplex',
      kind: 'print',
      options: {
        copies: 1,
        color: 'monochrome',
        sides: 'two-sided-long-edge',
        media: 'iso_a4_210x297mm',
      },
    },
  });
  expect(created.status()).toBe(201);
  const profile: SettingsProfile = await created.json();
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await button(page, 'Print').first().click();
  await saved(page).selectOption(profile.id);
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Safe capability drift example');
  await page.getByLabel('Select document', { exact: true }).setInputFiles({
    name: 'capability-example.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await button(page, 'Apply profile').click();
  await expect(page.getByText('Applied “Duplex”.', { exact: true })).toBeVisible();
  await expect(button(page, 'Start demo print')).toBeEnabled();
  printer.capabilities!.sides = ['one-sided'];
  await page.clock.runFor(6000);
  await expect(page.getByRole('combobox', { name: 'Sides', exact: true })).toHaveValue(
    'two-sided-long-edge',
  );
  await expect(page.getByRole('alert')).toContainText('sides (two-sided-long-edge)');
  await expect(button(page, 'Start demo print')).toBeDisabled();
  await page.getByRole('combobox', { name: 'Sides', exact: true }).selectOption('one-sided');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(button(page, 'Start demo print')).toBeEnabled();
});
