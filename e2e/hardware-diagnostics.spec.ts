import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { isolatedTest } from './isolated-server';

const test = isolatedTest();

test('hardware settings runs explicit diagnostics, blocks duplicates and preserves dated results on failure (API fixtures)', async ({
  page,
}, info) => {
  const headers = { 'x-openwebprint': '1' };
  await page.request.post('/api/onboarding/start', { headers });
  await page.request.post('/api/onboarding/devices', { headers, data: { devices: [] } });
  const setup = await (await page.request.get('/api/onboarding')).json();
  await page.request.post('/api/onboarding/storage', { headers, data: { path: setup.scanRoot } });
  let runs = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/hardware/prerequisites', async (route) => {
    runs++;
    if (runs === 1) await pending;
    if (runs === 2) {
      await route.fulfill({
        status: 503,
        json: { error: 'Diagnostics are temporarily unavailable.' },
      });
      return;
    }
    await route.fulfill({
      json: {
        checkedAt: '2026-10-28T12:34:00.000Z',
        method: 'container',
        platform: 'linux',
        ready: false,
        checks: [
          { id: 'lp', label: 'Printing tool: lp', state: 'ok' },
          { id: 'lpadmin', label: 'Printing tool: lpadmin', state: 'missing' },
          { id: 'scanimage', label: 'Scanning software (SANE)', state: 'ok' },
          { id: 'cups', label: 'CUPS printing service', state: 'unavailable' },
          { id: 'scanners', label: 'Scanner search', state: 'timeout' },
        ],
        guidance: 'Repair CUPS/SANE inside this container.',
        note: 'Successful checks verify software access, not device compatibility.',
      },
    });
  });
  await page.goto('/settings/hardware');
  const diagnostics = page.getByRole('region', { name: 'Hardware diagnostics' });
  const run = diagnostics.getByRole('button', { name: 'Run diagnostics' });
  await expect(run).toBeEnabled();
  expect(runs).toBe(0);
  await run.click();
  await expect(diagnostics).toContainText('Checking software and service access');
  await expect(run).toBeDisabled();
  expect(runs).toBe(1);
  release();
  await expect(run).toBeEnabled();
  for (const state of [
    'Available',
    'Software missing',
    'Service or backend unavailable',
    'Check timed out',
  ])
    await expect(diagnostics).toContainText(state);
  await expect(diagnostics).toContainText('Start or repair the CUPS service');
  await expect(diagnostics).toContainText('Install or repair the CUPS client tools');
  await expect(diagnostics).toContainText('firewall rules and VPN');
  await expect(diagnostics).toContainText('not its host');
  await expect(diagnostics.locator('time')).toHaveAttribute('datetime', '2026-10-28T12:34:00.000Z');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact || ''),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/${info.project.name}-hardware-diagnostics.png`,
    fullPage: true,
  });
  // Snapshot refreshes do not launch more diagnostics.
  await page.request.get('/api/snapshot');
  expect(runs).toBe(1);
  await run.click();
  await expect(diagnostics.getByRole('alert')).toHaveText(
    'Diagnostics are temporarily unavailable.',
  );
  await expect(diagnostics).toContainText('Previous check:');
  await expect(diagnostics).toContainText('Check timed out');
  await run.click();
  await expect(diagnostics.getByRole('alert')).toHaveCount(0);
  await expect(diagnostics).toContainText('Checked:');
  expect(runs).toBe(3);
});

test('demo hardware settings labels simulation and never requests hardware diagnostics', async ({
  page,
}) => {
  let runs = 0;
  await page.route('**/api/hardware/prerequisites', () => {
    runs++;
  });
  await page.request.post('/api/onboarding/demo', { headers: { 'x-openwebprint': '1' } });
  await page.goto('/settings/hardware');
  const diagnostics = page.getByRole('region', { name: 'Hardware diagnostics' });
  await expect(diagnostics).toContainText('Demo mode uses simulated devices');
  await expect(diagnostics.getByRole('button', { name: 'Run diagnostics' })).toBeDisabled();
  await page.reload();
  await expect(diagnostics).toContainText('No real hardware is contacted');
  expect(runs).toBe(0);
});
