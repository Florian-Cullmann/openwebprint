import { test, expect, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { ScanSources, Snapshot } from '@openwebprint/shared';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const paperSources = [
  { name: 'Flatbed', feeder: false },
  { name: 'ADF', feeder: true },
];
const discrete: ScanSources = {
  sources: paperSources,
  duplex: false,
  resolutions: [75, 200, 300, 1200],
  colorModes: ['Color', 'Grayscale', 'Lineart'],
  defaultResolution: 200,
  defaultColorMode: 'Color',
};
const range: ScanSources = {
  sources: paperSources,
  duplex: false,
  resolutions: { min: 100, max: 400, step: 100 },
  colorModes: ['Grayscale', 'Lineart'],
  defaultResolution: 100,
  defaultColorMode: 'Grayscale',
};
async function setup(page: Page) {
  const snapshot: Snapshot = {
    mode: 'demo',
    devicesCheckedAt: new Date().toISOString(),
    jobs: [],
    warnings: [],
    devices: [first, second].map((id, i) => ({
      id,
      name: i ? 'Second scanner fixture' : 'Source capability fixture',
      kind: 'scanner',
      address: `demo://capabilities-${i}`,
      location: 'Controlled browser fixture',
      mode: 'demo',
      provider: 'demo',
      status: 'ready',
    })),
  };
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
  await page.route('**/scan-sources*', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: url.pathname.includes(second)
        ? { sources: paperSources, duplex: false, resolutions: [200, 600], colorModes: ['Lineart'] }
        : url.searchParams.get('source') === 'ADF'
          ? range
          : discrete,
    });
  });
  await page.goto('/overview');
  await page.getByRole('button', { name: 'Scan', exact: true }).first().click();
  await expect(page.getByRole('combobox', { name: 'Paper source', exact: true })).toBeEnabled();
}

test('reconciles and refreshes scanner settings, validates a range and submits the selected values (browser fixtures)', async ({
  page,
}, info) => {
  await setup(page);
  const resolution = page.getByRole('combobox', { name: 'Resolution', exact: true });
  const color = page.getByRole('combobox', { name: 'Color mode', exact: true });
  const source = page.getByRole('combobox', { name: 'Paper source', exact: true });
  const submit = page.getByRole('button', { name: 'Start demo scan', exact: true });
  await expect(resolution.locator('option')).toHaveText([
    '75 dpi',
    '200 dpi',
    '300 dpi',
    '1200 dpi',
  ]);
  await resolution.selectOption('1200');
  await color.selectOption('Color');
  await source.selectOption('ADF');
  const dpi = page.getByRole('spinbutton', { name: /^Resolution/ });
  await expect(dpi).toHaveValue('100');
  await expect(color).toHaveValue('Grayscale');
  await expect(color.locator('option')).toHaveText(['Grayscale', 'Lineart']);
  await dpi.fill('250');
  await expect(submit).toBeDisabled();
  await dpi.fill('400');
  await expect(submit).toBeEnabled();
  await page
    .getByRole('dialog')
    .screenshot({ path: `test-results/${info.project.name}-22-source-capabilities.png` });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('combobox', { name: 'Scanner', exact: true }).selectOption(second);
  await expect(resolution).toHaveValue('200');
  await expect(color).toHaveValue('Lineart');
  await expect(source).toHaveValue('');
  await page.getByRole('combobox', { name: 'Scanner', exact: true }).selectOption(first);
  await expect(resolution).toHaveValue('200');
  await expect(color).toHaveValue('Lineart');
  await refreshSavedSettings(page, info);
  let submitted: unknown;
  await page.route('**/api/scans', (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: { error: 'Submission captured by browser fixture.' },
    });
  });
  await submit.click();
  await expect(page.getByRole('alert')).toHaveText('Submission captured by browser fixture.');
  expect(submitted).toMatchObject({
    deviceId: first,
    options: { resolution: 200, color: 'Lineart', batch: false },
  });
});

test('distinguishes unavailable settings from unknown capabilities and recovers from discovery errors (browser fixtures)', async ({
  page,
}) => {
  await setup(page);
  const scanner = page.getByRole('combobox', { name: 'Scanner', exact: true });
  const submit = page.getByRole('button', { name: 'Start demo scan', exact: true });
  const resolution = page.getByRole('combobox', { name: 'Resolution', exact: true });
  await expect(submit).toBeEnabled();
  await page.route(`**/devices/${second}/scan-sources*`, (route) =>
    route.fulfill({
      json: {
        sources: [],
        duplex: false,
        resolutions: [],
        colorModes: [],
      },
    }),
  );
  await scanner.selectOption(second);
  await expect(resolution.locator('option')).toHaveText(['No supported resolutions']);
  await expect(submit).toBeDisabled();
  await expect(
    page.getByText('Some scanner capabilities are unknown.', { exact: false }),
  ).toHaveCount(0);
  await scanner.selectOption(first);
  await expect(submit).toBeEnabled();
  await page.route(`**/devices/${second}/scan-sources*`, (route) =>
    route.fulfill({ status: 502, json: { error: 'Scanner is unreachable.' } }),
  );
  await scanner.selectOption(second);
  await expect(
    page.getByText('Some scanner capabilities are unknown.', { exact: false }),
  ).toBeVisible();
  await expect(resolution.locator('option')).toHaveText(['150 dpi', '300 dpi', '600 dpi']);
  await expect(resolution).toHaveValue('300');
  await expect(submit).toBeEnabled();
  await scanner.selectOption(first);
  await expect(resolution.locator('option')).toHaveText([
    '75 dpi',
    '200 dpi',
    '300 dpi',
    '1200 dpi',
  ]);
  await expect(
    page.getByText('Some scanner capabilities are unknown.', { exact: false }),
  ).toHaveCount(0);
});

test('ignores a stale capability response after switching scanners (browser fixtures)', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await setup(page);
  await page.route(`**/devices/${first}/scan-sources?source=ADF`, async (route) => {
    await pending;
    await route.fulfill({ json: range });
  });
  await page.getByRole('combobox', { name: 'Paper source', exact: true }).selectOption('ADF');
  await expect(page.getByRole('button', { name: 'Start demo scan', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Scanner', exact: true }).selectOption(second);
  const color = page.getByRole('combobox', { name: 'Color mode', exact: true });
  await expect(color).toHaveValue('Lineart');
  const staleResponse = page.waitForResponse((response) =>
    response.url().includes(`${first}/scan-sources?source=ADF`),
  );
  release();
  await staleResponse;
  await expect(
    page.getByRole('combobox', { name: 'Resolution', exact: true }).locator('option'),
  ).toHaveText(['200 dpi', '600 dpi']);
  await expect(color.locator('option')).toHaveText(['Lineart']);
});

async function refreshSavedSettings(page: Page, info: TestInfo) {
  const source = page.getByRole('combobox', { name: 'Paper source', exact: true });
  await source.selectOption('ADF');
  await page.getByRole('spinbutton', { name: /^Resolution/ }).fill('300');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const changed: ScanSources = {
    ...discrete,
    resolutions: [200, 600],
    colorModes: ['Lineart'],
    defaultResolution: 200,
    defaultColorMode: 'Lineart',
  };
  const queries: URLSearchParams[] = [];
  let fail = false;
  await page.route(`**/devices/${first}/scan-sources*`, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    if (query.has('refresh')) await pending;
    await route.fulfill({
      json: fail
        ? {
            sources: paperSources,
            duplex: false,
            warning: 'Controlled capability discovery failure.',
          }
        : changed,
    });
  });
  const refresh = page.getByRole('button', { name: 'Refresh scanner settings', exact: true });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start demo scan', exact: true })).toBeDisabled();
  release();
  await expect(refresh).toBeEnabled();
  expect(queries[0].get('refresh')).toBe('true');
  expect(queries[0].get('source')).toBe('ADF');
  const resolution = page.getByRole('combobox', { name: 'Resolution', exact: true });
  const color = page.getByRole('combobox', { name: 'Color mode', exact: true });
  await expect(resolution).toHaveValue('200');
  await expect(color).toHaveValue('Lineart');
  await expect(source).toHaveValue('ADF');
  await page
    .getByRole('dialog')
    .screenshot({ path: `test-results/${info.project.name}-22-cached-settings.png` });

  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Scan', exact: true }).first().click();
  await expect(refresh).toBeEnabled();
  expect(queries.at(-1)!.has('refresh')).toBe(false);
  await expect(resolution).toHaveValue('200');
  await expect(color).toHaveValue('Lineart');

  fail = true;
  await refresh.click();
  await expect(
    page.getByText('Some scanner capabilities are unknown.', { exact: false }),
  ).toBeVisible();
  await expect(resolution).toHaveValue('300');
  await expect(color).toHaveValue('Color');
  fail = false;
  await refresh.click();
  await expect(resolution).toHaveValue('200');
  await expect(color).toHaveValue('Lineart');
  await expect(
    page.getByText('Some scanner capabilities are unknown.', { exact: false }),
  ).toHaveCount(0);
}
