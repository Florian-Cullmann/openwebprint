import { test, expect, type Page } from '@playwright/test';
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
  resolutions: { min: 100, max: 450, step: 100 },
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
  await page.route('**/api/devices/*/profiles', (route) => route.fulfill({ json: [] }));
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
const slider = (page: Page) => page.getByRole('slider', { name: 'Resolution', exact: true });
const colorSelect = (page: Page) => page.getByRole('combobox', { name: 'Color mode', exact: true });
const colorGroup = (page: Page) => page.getByRole('group', { name: 'Color mode', exact: true });
async function dpi(page: Page, value: number) {
  await expect(slider(page)).toHaveAttribute('aria-valuetext', `${value} dpi`);
}
async function accessibility(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('snaps irregular resolutions, reconciles sources and scanners, and submits supported settings (browser fixtures)', async ({
  page,
}, info) => {
  await setup(page);
  const source = page.getByRole('combobox', { name: 'Paper source', exact: true });
  const submit = page.getByRole('button', { name: 'Start demo scan', exact: true });
  await expect(colorSelect(page).locator('option')).toHaveText([
    'Color',
    'Grayscale',
    'Black and white (1-bit)',
  ]);
  await dpi(page, 300);
  await slider(page).focus();
  await page.keyboard.press('Home');
  await dpi(page, 75);
  await page.keyboard.press('ArrowRight');
  await dpi(page, 200);
  await page.keyboard.press('ArrowRight');
  await dpi(page, 300);
  await page.keyboard.press('End');
  await dpi(page, 1200);
  // Pointer selection in between ticks must still select one of the advertised values.
  const track = (await slider(page).boundingBox())!;
  if (info.project.name === 'mobile')
    await page.touchscreen.tap(track.x + track.width * 0.45, track.y + track.height / 2);
  else await page.mouse.click(track.x + track.width * 0.45, track.y + track.height / 2);
  expect(['75 dpi', '200 dpi', '300 dpi', '1200 dpi']).toContain(
    await slider(page).getAttribute('aria-valuetext'),
  );
  await slider(page).press('End');
  await source.selectOption('ADF');
  await dpi(page, 100);
  await expect(page.getByRole('radio', { name: 'Grayscale', exact: true })).toBeChecked();
  await slider(page).press('End');
  await dpi(page, 400); // The advertised max of 450 is not on this range's step grid.
  await slider(page).press('ArrowLeft');
  await dpi(page, 300);
  await slider(page).press('ArrowRight');
  await dpi(page, 400);
  await page.getByRole('radio', { name: 'Black and white (1-bit)', exact: true }).check();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: 'Grayscale', exact: true })).toBeChecked();
  await expect(submit).toBeEnabled();
  await accessibility(page);
  if (info.project.name === 'mobile') await slider(page).scrollIntoViewIfNeeded();
  await page
    .getByRole('dialog')
    .screenshot({ path: `test-results/${info.project.name}-51-scanner-controls.png` });

  const scanner = page.getByRole('combobox', { name: 'Scanner', exact: true });
  await scanner.selectOption(second);
  await dpi(page, 200);
  await expect(colorGroup(page)).toHaveText('Color modeBlack and white (1-bit)');
  await expect(source).toHaveValue('');
  await scanner.selectOption(first);
  await dpi(page, 200);
  await expect(colorSelect(page)).toHaveValue('Lineart');
  await colorSelect(page).selectOption({ label: 'Black and white (1-bit)' });
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

test('shows single supported values without editable controls and handles fractional and unstepped ranges (browser fixtures)', async ({
  page,
}) => {
  await setup(page);
  let capabilities: ScanSources = {
    sources: paperSources,
    duplex: false,
    resolutions: [225],
    colorModes: ['Gray'],
  };
  await page.route(`**/devices/${second}/scan-sources*`, (route) =>
    route.fulfill({ json: capabilities }),
  );
  await page.getByRole('combobox', { name: 'Scanner', exact: true }).selectOption(second);
  await expect(slider(page)).toHaveCount(0);
  await expect(page.getByText('225 dpi', { exact: true })).toBeVisible();
  await expect(colorGroup(page)).toHaveText('Color modeGrayscale');
  await expect(colorGroup(page).getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start demo scan', exact: true })).toBeEnabled();
  await accessibility(page);
  capabilities = { ...capabilities, resolutions: { min: 101.1, max: 101.7, step: 0.2 } };
  await page.getByRole('button', { name: 'Refresh scanner settings' }).click();
  await dpi(page, 101.1);
  await slider(page).press('ArrowRight');
  await dpi(page, 101.3);
  await slider(page).press('End');
  await dpi(page, 101.7);
  // A maximum just below a step boundary must not round up into an unsupported value.
  capabilities = { ...capabilities, resolutions: { min: 100, max: 399.9999999, step: 100 } };
  await page.getByRole('button', { name: 'Refresh scanner settings' }).click();
  await slider(page).press('End');
  await dpi(page, 300);
  capabilities = { ...capabilities, resolutions: { min: 90, max: 900 } };
  await page.getByRole('button', { name: 'Refresh scanner settings' }).click();
  await expect(slider(page)).toHaveAttribute('step', 'any');
  await slider(page).fill('347.5');
  await dpi(page, 347.5);
  await slider(page).press('Home');
  await dpi(page, 90);
  await slider(page).press('End');
  await dpi(page, 900);
  capabilities = { ...capabilities, resolutions: { min: 250, max: 250 } };
  await page.getByRole('button', { name: 'Refresh scanner settings' }).click();
  await expect(slider(page)).toHaveCount(0);
  await expect(page.getByText('250 dpi', { exact: true })).toBeVisible();
});

test('distinguishes unsupported settings, unknown fallback options and discovery errors (browser fixtures)', async ({
  page,
}) => {
  await setup(page);
  const scanner = page.getByRole('combobox', { name: 'Scanner', exact: true });
  const submit = page.getByRole('button', { name: 'Start demo scan', exact: true });
  await page.route(`**/devices/${second}/scan-sources*`, (route) =>
    route.fulfill({ json: { sources: [], duplex: false, resolutions: [], colorModes: [] } }),
  );
  await scanner.selectOption(second);
  await expect(page.getByText('No supported resolutions', { exact: true })).toBeVisible();
  await expect(colorGroup(page)).toHaveText('Color modeNo supported color modes');
  await expect(slider(page)).toHaveCount(0);
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
  ).toContainText('Scanner is unreachable.');
  await dpi(page, 300);
  await expect(page.getByRole('radio', { name: 'Color', exact: true })).toBeChecked();
  await expect(submit).toBeEnabled();
  await scanner.selectOption(first);
  await dpi(page, 300);
  await expect(
    page.getByText('Some scanner capabilities are unknown.', { exact: false }),
  ).toHaveCount(0);
});

test('ignores a stale response and disables controls while loading settings (browser fixtures)', async ({
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
  await expect(slider(page)).toBeDisabled();
  await expect(colorSelect(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start demo scan', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Scanner', exact: true }).selectOption(second);
  await expect(colorGroup(page)).toHaveText('Color modeBlack and white (1-bit)');
  const staleResponse = page.waitForResponse((response) =>
    response.url().includes(`${first}/scan-sources?source=ADF`),
  );
  release();
  await staleResponse;
  await dpi(page, 200);
  await expect(slider(page)).toHaveAttribute('max', '1');
  await expect(colorGroup(page)).toHaveText('Color modeBlack and white (1-bit)');
});

test('refreshes saved source settings, preserves reopening and recovers from unknown discovery (browser fixtures)', async ({
  page,
}, info) => {
  await setup(page);
  const source = page.getByRole('combobox', { name: 'Paper source', exact: true });
  await source.selectOption('ADF');
  await slider(page).fill('2');
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
  await expect(slider(page)).toBeDisabled();
  release();
  await expect(refresh).toBeEnabled();
  expect(queries[0].get('refresh')).toBe('true');
  expect(queries[0].get('source')).toBe('ADF');
  await dpi(page, 200);
  await expect(colorGroup(page)).toHaveText('Color modeBlack and white (1-bit)');
  await expect(source).toHaveValue('ADF');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Scan', exact: true }).first().click();
  await expect(refresh).toBeEnabled();
  expect(queries.at(-1)!.has('refresh')).toBe(false);
  await dpi(page, 200);
  fail = true;
  await refresh.click();
  await expect(
    page.getByText('Some scanner capabilities are unknown.', { exact: false }),
  ).toBeVisible();
  await dpi(page, 300);
  await expect(page.getByRole('radio', { name: 'Color', exact: true })).toBeChecked();
  await accessibility(page);
  await page
    .getByRole('dialog')
    .screenshot({ path: `test-results/${info.project.name}-51-fallback-controls.png` });
  fail = false;
  await refresh.click();
  await dpi(page, 200);
  await expect(colorGroup(page)).toHaveText('Color modeBlack and white (1-bit)');
  await expect(
    page.getByText('Some scanner capabilities are unknown.', { exact: false }),
  ).toHaveCount(0);
});
