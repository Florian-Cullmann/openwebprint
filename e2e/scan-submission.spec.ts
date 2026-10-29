import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device, Job, ScanOptions } from '@openwebprint/shared';
import { publicErrorBody } from '@openwebprint/shared';
import { createApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { DemoProvider } from '../apps/server/src/providers/demo.js';

// Real API and persistence with a stubbed acquisition provider, never physical hardware.
class ControlledScanner extends DemoProvider {
  calls = 0;
  pending?: Promise<void>;
  release = () => {};
  hold() {
    this.pending = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  override async scan(device: Device, output: string, options: ScanOptions) {
    this.calls++;
    await this.pending;
    return super.scan(device, output, options);
  }
}
const test = base.extend<{ scanner: ControlledScanner }>({
  scanner: async ({}, use) => {
    const scanner = new ControlledScanner();
    try {
      await use(scanner);
    } finally {
      scanner.release();
    }
  },
  baseURL: async ({ scanner }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'owp-submission-browser-'));
    const config = readConfig({ DATA_DIR: directory, MODE: 'demo', COOKIE_SECURE: 'false' });
    const { app, workspace } = await createApp(config, { provider: scanner, background: false });
    try {
      await workspace.tryDemo();
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      config.origin = origin;
      await use(origin);
    } finally {
      scanner.release();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});
for (const append of [false, true]) {
  test(`lost accepted ${append ? 'append' : 'new scan'} response blocks duplicate acquisition (stubbed provider)`, async ({
    page,
    scanner,
  }, info) => {
    await page.goto('/scans');
    await page.getByRole('button', { name: 'New scan', exact: true }).click();
    const cards = page.getByRole('list', { name: 'Scanned pages' }).locator('[data-page-id]');
    if (append) {
      await page.getByRole('button', { name: 'Start demo scan', exact: true }).click();
      await expect(cards).toHaveCount(1);
    }
    await page.getByRole('combobox', { name: 'Paper source', exact: true }).selectOption('ADF');
    scanner.hold();
    let accepted: Job | undefined;
    let submissions = 0;
    await page.route('**/api/scans', async (route) => {
      submissions++;
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.status()).toBe(202);
      accepted = await response.json();
      await route.abort('failed');
    });
    const submit = page.getByRole('button', {
      name: append ? 'Scan another page' : 'Start demo scan',
      exact: true,
    });
    await submit.click();
    const dialog = page.getByRole('dialog', { name: 'Submission unconfirmed' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('check Jobs and the scanner');
    await expect(submit).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Scan multiple pages', exact: true }),
    ).toBeDisabled();
    // The server still excludes another acquisition while the original is active.
    const rejected = await page.request.post('/api/scans', {
      headers: { 'x-openwebprint': '1' },
      data: {
        deviceId: accepted!.deviceId,
        options: { resolution: 300, color: 'Color', batch: false },
      },
    });
    expect(rejected.status()).toBe(409);
    scanner.release();
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/jobs/${accepted!.id}`);
        return (await response.json()).status;
      })
      .toBe('completed');
    // Even after hardware exclusion ends, neither click nor form submission may retry.
    await expect(submit).toBeDisabled();
    await dialog.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(dialog.getByRole('alert')).toContainText('could scan or append pages twice');
    expect(submissions).toBe(1);
    expect(scanner.calls).toBe(append ? 2 : 1);
    const saved = await (await page.request.get(`/api/jobs/${accepted!.id}`)).json();
    expect(saved.pages).toHaveLength(append ? 2 : 1);
    if (append)
      await expect(
        page.getByRole('button', { name: 'Rotate page 1 clockwise', exact: true }),
      ).toBeDisabled();
    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
      [],
    );
    await dialog.screenshot({
      path: `test-results/${info.project.name}-98-${append ? 'append' : 'new'}.png`,
    });
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(dialog).toHaveCount(0);
  });
}
for (const failure of ['validation', 'server', 'malformed'] as const) {
  test(`${failure} scan response has appropriate retry behavior (stubbed transport)`, async ({
    page,
  }) => {
    await page.goto('/scans');
    await page.getByRole('button', { name: 'New scan', exact: true }).click();
    await page.route('**/api/scans', (route) =>
      failure === 'malformed'
        ? route.fulfill({ status: 202, contentType: 'application/json', body: '{' })
        : route.fulfill({
            status: failure === 'validation' ? 409 : 502,
            json: publicErrorBody('The scanner does not support the selected source.'),
          }),
    );
    const submit = page.getByRole('button', { name: 'Start demo scan', exact: true });
    await submit.click();
    if (failure === 'validation') {
      await expect(page.getByRole('alert')).toHaveText(
        'The scanner does not support the selected source.',
      );
      await expect(submit).toBeEnabled();
      await page.unroute('**/api/scans');
      await submit.click();
      await expect(
        page.getByRole('list', { name: 'Scanned pages' }).locator('[data-page-id]'),
      ).toHaveCount(1);
    } else {
      await expect(page.getByRole('dialog', { name: 'Submission unconfirmed' })).toBeVisible();
      await expect(submit).toBeDisabled();
    }
  });
}
