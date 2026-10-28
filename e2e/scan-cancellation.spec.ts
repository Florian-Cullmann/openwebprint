import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
import type { Device, Job } from '@openwebprint/shared';

const scanner: Device = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Demo scanner',
  kind: 'scanner',
  address: 'demo://scanner',
  location: 'Controlled browser fixture',
  mode: 'demo',
  provider: 'demo',
  status: 'ready',
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
for (const saved of [false, true]) {
  test(`close, reopen and cancel ${saved ? 'an append with saved pages' : 'a first scan'} (browser API fixtures)`, async ({
    page,
  }, info) => {
    let job: Job = {
      id: '00000000-0000-4000-8000-000000000002',
      deviceId: scanner.id,
      deviceName: scanner.name,
      kind: 'scan',
      title: 'Demo scan document',
      status: 'completed',
      hasFile: saved,
      mode: 'demo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      options: { resolution: 300, color: 'Color' },
      ...(saved
        ? {
            pages: [{ id: '00000000-0000-4000-8000-000000000003', rotation: 0 }],
            scanRevision: 'saved-revision',
          }
        : {}),
    };
    let started = false;
    let cancels = 0;
    let busyCapabilityReads = 0;
    let holdPoll = false;
    const polled = gate();
    const stalePoll = gate();
    const finishCancel = gate();
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
    await page.route('**/api/snapshot', (route) =>
      route.fulfill({
        json: {
          mode: 'demo',
          devices: [scanner],
          jobs: saved || started ? [job] : [],
          warnings: [],
          devicesCheckedAt: new Date().toISOString(),
        },
      }),
    );
    await page.route('**/scan-sources*', (route) => {
      if (started && job.status === 'processing') {
        busyCapabilityReads++;
        return route.fulfill({ status: 409, json: { error: 'This scanner is already in use.' } });
      }
      return route.fulfill({
        json: {
          sources: [
            { name: 'Flatbed', feeder: false },
            { name: 'ADF', feeder: true },
          ],
          resolutions: [150, 300, 600],
          colorModes: ['Color', 'Gray'],
          duplex: false,
        },
      });
    });
    const image = await sharp(
      Buffer.from(
        '<svg width="300" height="400"><rect width="300" height="400" fill="white"/><text x="20" y="60" font-size="20">Saved demo page</text></svg>',
      ),
    )
      .png()
      .toBuffer();
    await page.route('**/api/scans/*/pages/*', (route) =>
      route.fulfill({ body: image, contentType: 'image/png' }),
    );
    await page.route('**/api/scans', (route) => {
      started = true;
      job = { ...job, status: 'processing' };
      return route.fulfill({ status: 202, json: job });
    });
    await page.route(`**/api/jobs/${job.id}`, async (route) => {
      const response = { ...job };
      if (holdPoll) {
        polled.release();
        await stalePoll.promise;
      }
      await route.fulfill({ json: response });
    });
    await page.route(`**/api/jobs/${job.id}/cancel`, async (route) => {
      cancels++;
      await finishCancel.promise;
      job = {
        ...job,
        status: saved ? 'completed' : 'canceled',
        error:
          'Scan canceled. New pages from this operation were discarded. Previously saved pages were kept.',
      };
      await route.fulfill({ json: job });
    });
    try {
      await page.goto('/overview');
      if (saved) await page.getByRole('button', { name: job.title, exact: true }).click();
      else await page.getByRole('button', { name: 'Scan', exact: true }).first().click();
      await page
        .getByRole('button', { name: saved ? 'Scan another page' : 'Start demo scan', exact: true })
        .click();
      await expect(page.getByRole('button', { name: 'Cancel scan', exact: true })).toBeEnabled();
      await expect(
        page.getByText('Closing this dialog continues the scan', { exact: false }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Continue in background', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(cancels).toBe(0);
      await page.getByRole('button', { name: job.title, exact: true }).click();
      const cancel = page.getByRole('button', { name: 'Cancel scan', exact: true });
      await expect(cancel).toBeEnabled();
      if (saved) {
        await expect(page.getByRole('img', { name: 'Scanned page 1', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Download PDF', exact: true })).toBeVisible();
      }
      await cancel.scrollIntoViewIfNeeded();
      await page.getByRole('dialog').screenshot({
        path: `test-results/${info.project.name}-21-${saved ? 'append' : 'first'}-active.png`,
      });
      const axe = await new AxeBuilder({ page }).analyze();
      expect(
        axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
      ).toEqual([]);
      holdPoll = true;
      await polled.promise;
      await cancel.click();
      await expect(
        page.getByRole('button', { name: 'Canceling scan…', exact: true }),
      ).toBeDisabled();
      finishCancel.release();
      await expect(page.getByRole('alert').filter({ hasText: 'Scan canceled.' })).toBeVisible();
      const staleResponse = page.waitForResponse((response) =>
        response.url().endsWith(`/api/jobs/${job.id}`),
      );
      stalePoll.release();
      await staleResponse;
      await expect(page.getByRole('button', { name: 'Cancel scan', exact: true })).toHaveCount(0);
      await expect(
        page.getByRole('button', {
          name: saved ? 'Scan another page' : 'Start demo scan',
          exact: true,
        }),
      ).toBeEnabled();
      expect(cancels).toBe(1);
      expect(busyCapabilityReads).toBe(0);
      if (saved) {
        await expect(page.getByRole('img', { name: 'Scanned page 1', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Download PDF', exact: true })).toHaveAttribute(
          'href',
          `/api/jobs/${job.id}/pdf`,
        );
      }
      await page.getByRole('dialog').screenshot({
        path: `test-results/${info.project.name}-21-${saved ? 'append' : 'first'}-canceled.png`,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
    } finally {
      finishCancel.release();
      stalePoll.release();
    }
  });
}
