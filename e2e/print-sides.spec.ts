import { publicErrorBody } from '@openwebprint/shared';
import { test, expect, type Page } from '@playwright/test';
import { PRINT_SIDES, type Device, type Job, type Snapshot } from '@openwebprint/shared';
import { PDFDocument } from 'pdf-lib';
import AxeBuilder from '@axe-core/playwright';

async function setup(page: Page) {
  await page.clock.install();
  const variants: [string, Device['capabilities']][] = [
    [
      'Short edge fixture',
      {
        color: false,
        colorModes: ['monochrome'],
        sides: ['one-sided', 'two-sided-short-edge'],
        media: ['iso_a4_210x297mm'],
      },
    ],
    [
      'Long edge fixture',
      {
        color: false,
        colorModes: ['monochrome'],
        sides: ['one-sided', 'two-sided-long-edge'],
        media: ['iso_a4_210x297mm'],
      },
    ],
    [
      'Both edges fixture',
      {
        color: false,
        colorModes: ['monochrome'],
        sides: [...PRINT_SIDES],
        media: ['iso_a4_210x297mm'],
      },
    ],
    [
      'Simplex fixture',
      {
        color: false,
        colorModes: ['monochrome'],
        sides: ['one-sided'],
        media: ['iso_a4_210x297mm'],
      },
    ],
    [
      'Missing sides fixture',
      { color: false, colorModes: ['monochrome'], media: ['iso_a4_210x297mm'] },
    ],
    [
      'Unsupported sides fixture',
      { color: false, colorModes: ['monochrome'], sides: [], media: ['iso_a4_210x297mm'] },
    ],
    ['Unreachable fixture', undefined],
    [
      'Color printer fixture',
      {
        color: true,
        colorModes: ['monochrome', 'color'],
        sides: ['one-sided'],
        media: ['iso_a4_210x297mm'],
      },
    ],
  ];
  variants.push(
    [
      'Color-only fixture',
      { color: true, colorModes: ['color'], sides: ['one-sided'], media: ['iso_a4_210x297mm'] },
    ],
    [
      'Missing color modes fixture',
      { color: true, sides: ['one-sided'], media: ['iso_a4_210x297mm'] },
    ],
    [
      'Unsupported color modes fixture',
      { color: true, colorModes: [], sides: ['one-sided'], media: ['iso_a4_210x297mm'] },
    ],
  );
  const snapshot: Snapshot = {
    mode: 'demo',
    devicesCheckedAt: new Date().toISOString(),
    warnings: [],
    jobs: [],
    devices: variants.map(([name, capabilities], i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name,
      kind: 'printer',
      address: `demo://sides-${i}`,
      location: 'Controlled browser fixture',
      mode: 'demo',
      provider: 'demo',
      status: capabilities ? 'ready' : 'unknown',
      capabilities,
    })),
  };
  // Only these browser responses are simulated; render the real production print dialog.
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
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Duplex preview fixture', { x: 40, y: 720, size: 24 });
  const buffer = Buffer.from(await pdf.save());
  await page.route('**/api/documents/preview', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: buffer }),
  );
  await page.goto('/overview');
  await page.getByRole('button', { name: 'Print', exact: true }).first().click();
  await page.getByLabel('Select document', { exact: true }).setInputFiles({
    name: 'duplex-fixture.pdf',
    mimeType: 'application/pdf',
    buffer,
  });
  await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  return snapshot;
}

test('offers only advertised binding edges, reconciles printer changes, and submits the selected edge (browser fixtures)', async ({
  page,
}, info) => {
  const snapshot = await setup(page);
  const sides = page.getByRole('combobox', { name: 'Sides', exact: true });
  const printer = page.getByRole('combobox', { name: 'Printer', exact: true });
  const submit = page.getByRole('button', { name: 'Start demo print', exact: true });
  await expect(sides.locator('option')).toHaveText(['Single-sided', 'Duplex · short edge']);
  await sides.selectOption('two-sided-short-edge');
  await sides.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/${info.project.name}-39-short-edge.png`,
    fullPage: true,
  });

  await printer.selectOption({ label: 'Long edge fixture' });
  await expect(sides).toHaveValue('one-sided');
  await expect(sides.locator('option')).toHaveText(['Single-sided', 'Duplex · long edge']);
  await sides.selectOption('two-sided-long-edge');
  await printer.selectOption({ label: 'Both edges fixture' });
  await expect(sides).toHaveValue('two-sided-long-edge');
  await expect(sides.locator('option')).toHaveText([
    'Single-sided',
    'Duplex · long edge',
    'Duplex · short edge',
  ]);
  await printer.selectOption({ label: 'Simplex fixture' });
  await expect(sides).toHaveValue('one-sided');
  await expect(sides.locator('option')).toHaveText(['Single-sided']);
  await expect(submit).toBeEnabled();

  await printer.selectOption({ label: 'Missing sides fixture' });
  await expect(sides).toBeDisabled();
  await expect(sides.locator('option')).toHaveText(['Sides unavailable']);
  await expect(submit).toBeDisabled();
  await expect(
    page.getByText('Print sides are unavailable. Check the CUPS connection.'),
  ).toBeVisible();
  await printer.selectOption({ label: 'Unsupported sides fixture' });
  await expect(sides.locator('option')).toHaveText(['No supported sides']);
  await expect(submit).toBeDisabled();
  await printer.selectOption({ label: 'Unreachable fixture' });
  await expect(sides).toBeDisabled();
  await expect(submit).toBeDisabled();

  await printer.selectOption({ label: 'Short edge fixture' });
  await sides.selectOption('two-sided-short-edge');
  const now = new Date().toISOString();
  const job: Job = {
    id: '00000000-0000-4000-8000-999999999999',
    deviceId: snapshot.devices[0].id,
    deviceName: snapshot.devices[0].name,
    kind: 'print',
    title: 'duplex-fixture.pdf',
    mode: 'demo',
    status: 'queued',
    hasFile: true,
    createdAt: now,
    updatedAt: now,
    options: {
      sides: 'two-sided-short-edge',
      copies: 1,
      color: 'monochrome',
      media: 'iso_a4_210x297mm',
    },
  };
  let submitted = '';
  await page.route('**/api/print', (route) => {
    submitted = route.request().postData() ?? '';
    return route.fulfill({ status: 201, json: job });
  });
  await submit.click();
  await expect(
    page.getByRole('heading', { name: 'Demo job submitted.', exact: true }),
  ).toBeVisible();
  expect(submitted).toContain('"sides":"two-sided-short-edge"');
});

test('reconciles sides when capabilities change on the same printer (browser fixtures)', async ({
  page,
}) => {
  const snapshot = await setup(page);
  const sides = page.getByRole('combobox', { name: 'Sides', exact: true });
  const submit = page.getByRole('button', { name: 'Start demo print', exact: true });
  await sides.selectOption('two-sided-short-edge');
  snapshot.devices[0].capabilities!.sides = ['one-sided', 'two-sided-long-edge'];
  await page.clock.runFor(5100);
  await expect(sides).toHaveValue('one-sided');
  await expect(sides.locator('option')).toHaveText(['Single-sided', 'Duplex · long edge']);
  snapshot.devices[0].capabilities!.sides = undefined;
  await page.clock.runFor(5100);
  await expect(sides).toBeDisabled();
  await expect(submit).toBeDisabled();
  snapshot.devices[0].capabilities!.sides = ['two-sided-short-edge'];
  await page.clock.runFor(5100);
  await expect(sides).toHaveValue('two-sided-short-edge');
  await expect(submit).toBeEnabled();
});

test('selects print color with keyboard and pointer, reconciles printer changes and submits the chosen mode (browser fixtures)', async ({
  page,
}, info) => {
  await setup(page);
  const printer = page.getByRole('combobox', { name: 'Printer', exact: true });
  const group = page.getByRole('group', { name: 'Color mode', exact: true });
  await expect(group).toHaveText('Color modeBlack and white');
  await expect(group.getByRole('radio')).toHaveCount(0);
  await printer.selectOption({ label: 'Color printer fixture' });
  const monochrome = page.getByRole('radio', { name: 'Black and white', exact: true });
  const color = page.getByRole('radio', { name: 'Color', exact: true });
  await expect(monochrome).toBeChecked();
  await monochrome.focus();
  await page.keyboard.press('ArrowRight');
  await expect(color).toBeChecked();
  await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveCSS(
    'filter',
    'none',
  );
  await printer.selectOption({ label: 'Simplex fixture' });
  await expect(group.getByRole('radio')).toHaveCount(0);
  await printer.selectOption({ label: 'Color printer fixture' });
  await expect(monochrome).toBeChecked();
  if (info.project.name === 'mobile') await color.tap();
  else await color.check();
  await expect(color).toBeChecked();
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/${info.project.name}-51-print-controls.png`,
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  let submitted = '';
  await page.route('**/api/print', (route) => {
    submitted = route.request().postData() ?? '';
    return route.fulfill({
      status: 409,
      json: publicErrorBody('This device does not support the selected print options.'),
    });
  });
  await page.getByRole('button', { name: 'Start demo print', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'This device does not support the selected print options.',
  );
  expect(submitted).toContain('"color":"color"');
});

for (const [label, mode, text] of [
  ['Color-only fixture', 'color', 'Color'],
  ['Simplex fixture', 'monochrome', 'Black and white'],
] as const) {
  test(`offers and submits only ${mode} on a single-mode printer (browser fixtures)`, async ({
    page,
  }, info) => {
    await setup(page);
    await page.getByRole('combobox', { name: 'Printer', exact: true }).selectOption({ label });
    const group = page.getByRole('group', { name: 'Color mode', exact: true });
    await expect(group).toHaveText(`Color mode${text}`);
    await expect(group.getByRole('radio')).toHaveCount(0);
    const submit = page.getByRole('button', { name: 'Start demo print', exact: true });
    await expect(submit).toBeEnabled();
    await expect(page.getByRole('img', { name: 'Document page 1', exact: true })).toHaveCSS(
      'filter',
      mode === 'color' ? 'none' : 'grayscale(1)',
    );
    if (mode === 'color') {
      await group.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/${info.project.name}-62-color-only.png`,
        fullPage: true,
      });
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    let submitted = '';
    await page.route('**/api/print', (route) => {
      submitted = route.request().postData() ?? '';
      return route.fulfill({
        status: 409,
        json: publicErrorBody('This device does not support the selected print options.'),
      });
    });
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText(
      'This device does not support the selected print options.',
    );
    expect(submitted).toContain(`"color":"${mode}"`);
  });
}

test('reconciles color modes across printers, missing discovery and same-printer updates (browser fixtures)', async ({
  page,
}) => {
  const snapshot = await setup(page);
  const printer = page.getByRole('combobox', { name: 'Printer', exact: true });
  const group = page.getByRole('group', { name: 'Color mode', exact: true });
  const submit = page.getByRole('button', { name: 'Start demo print', exact: true });
  await printer.selectOption({ label: 'Color-only fixture' });
  await expect(group).toHaveText('Color modeColor');
  await printer.selectOption({ label: 'Color printer fixture' });
  await expect(group.getByRole('radio', { name: 'Color', exact: true })).toBeChecked();
  await printer.selectOption({ label: 'Simplex fixture' });
  await expect(group).toHaveText('Color modeBlack and white');
  await printer.selectOption({ label: 'Missing color modes fixture' });
  await expect(group).toHaveText('Color modeColor modes unavailable');
  await expect(group.getByRole('radio')).toHaveCount(0);
  await expect(submit).toBeDisabled();
  await expect(
    page.getByText('Print color modes are unavailable. Check the CUPS connection.'),
  ).toBeVisible();
  await printer.selectOption({ label: 'Unsupported color modes fixture' });
  await expect(group).toHaveText('Color modeNo supported color modes');
  await expect(submit).toBeDisabled();
  await expect(
    page.getByText('This printer reports no supported print color modes.'),
  ).toBeVisible();
  await printer.selectOption({ label: 'Short edge fixture' });
  const caps = snapshot.devices[0].capabilities!;
  caps.colorModes = ['color'];
  await page.clock.runFor(5100);
  await expect(group).toHaveText('Color modeColor');
  await expect(submit).toBeEnabled();
  caps.colorModes = ['monochrome', 'color'];
  await page.clock.runFor(5100);
  await expect(group.getByRole('radio', { name: 'Color', exact: true })).toBeChecked();
  caps.colorModes = undefined;
  await page.clock.runFor(5100);
  await expect(group).toHaveText('Color modeColor modes unavailable');
  await expect(submit).toBeDisabled();
  caps.colorModes = [];
  await page.clock.runFor(5100);
  await expect(group).toHaveText('Color modeNo supported color modes');
  await expect(submit).toBeDisabled();
  caps.colorModes = ['color'];
  await page.clock.runFor(5100);
  await expect(group).toHaveText('Color modeColor');
  await expect(submit).toBeEnabled();
});
