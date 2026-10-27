import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { isolatedTest } from './isolated-server';
const test = isolatedTest();
test('native hardware setup explains missing requirements and recovers after terminal repair (API fixtures)', async ({
  page,
}, info) => {
  let repaired = false;
  let checks = 0;
  await page.route('**/api/hardware/prerequisites', async (route) => {
    checks++;
    await route.fulfill({
      json: {
        checkedAt: '2026-10-27T12:00:00.000Z',
        platform: 'linux',
        method: 'native',
        ready: repaired,
        checks: [
          { id: 'lpstat', label: 'Printing tool: lpstat', state: repaired ? 'ok' : 'missing' },
          {
            id: 'scanimage',
            label: 'Scanning software (SANE)',
            state: repaired ? 'ok' : 'missing',
          },
          ...(repaired
            ? [
                { id: 'cups', label: 'CUPS printing service', state: 'ok' },
                { id: 'scanners', label: 'Scanner search', state: 'empty' },
              ]
            : []),
        ],
        guidance:
          'Printing uses the local CUPS service. Add printers or resolve queue permissions in your OS printer settings.',
        setupCommand: "'/home/example/.local/share/openwebprint/openwebprint' hardware",
        note: 'Successful checks verify software access, not device compatibility. An empty search means no devices were found; no page was printed or scanned.',
      },
    });
  });
  await page.route('**/api/devices/discover', (route) =>
    route.fulfill({ json: { devices: [], warnings: [] } }),
  );
  await page.goto('/setup');
  await page.getByRole('button', { name: 'Start setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect your devices' })).toBeVisible();
  const requirements = page.getByRole('region', { name: 'Printing and scanning prerequisites' });
  await expect(requirements).toContainText('Hardware setup needs attention');
  await expect(requirements.getByText('Software missing', { exact: false })).toHaveCount(2);
  await expect(requirements).toContainText(
    "'/home/example/.local/share/openwebprint/openwebprint' hardware",
  );
  await expect(requirements).not.toContainText('Docker');
  expect(checks).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const violations = (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
    ['serious', 'critical'].includes(item.impact || ''),
  );
  expect(violations).toEqual([]);
  await page.screenshot({
    path: `test-results/${info.project.name}-hardware-prerequisites.png`,
    fullPage: true,
  });
  repaired = true;
  await requirements.getByRole('button', { name: 'Check prerequisites again' }).click();
  await expect(requirements).toContainText('Software checks passed');
  await expect(requirements).toContainText('Search succeeded; no devices found');
  expect(checks).toBe(2);
  await page.getByRole('button', { name: 'Continue without devices' }).click();
  await expect(page.getByRole('heading', { name: 'Where should scans be saved?' })).toBeVisible();
});
