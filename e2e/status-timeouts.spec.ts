import { test, expect } from '@playwright/test';

// Controlled browser transport faults; no real proxy or hardware is involved.
for (const target of ['snapshot', 'history', 'scan'] as const) {
  test(`${target} polling recovers after a stalled read`, async ({ page }, info) => {
    const german = target === 'history';
    await page.addInitScript(
      (language) => localStorage.setItem('owp-language', language),
      german ? 'de' : 'en',
    );
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    const scanner = {
      id: 'scanner',
      name: 'Demo scanner',
      kind: 'scanner',
      address: 'demo://scanner',
      mode: 'demo',
      provider: 'demo',
      status: 'ready',
    };
    const job = {
      id: 'scan',
      deviceId: scanner.id,
      deviceName: scanner.name,
      kind: 'scan',
      title: 'Timeout recovery sample',
      status: 'processing',
      hasFile: false,
      mode: 'demo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      options: { resolution: 300, color: 'Color' },
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
    let calls = 0;
    let recovering = false;
    const snapshot = {
      mode: 'demo',
      devices: [scanner],
      jobs: target === 'scan' ? [job] : [],
      warnings: [],
    };
    await page.route('**/api/snapshot', (route) => {
      if (target === 'snapshot') {
        calls++;
        if (!recovering) return; // Hold the connection until the browser deadline.
      }
      return route.fulfill({ json: snapshot });
    });
    await page.route('**/api/jobs?*', (route) => {
      if (target === 'history') {
        calls++;
        if (!recovering) return;
      }
      return route.fulfill({ json: { jobs: [], total: 0, offset: 0 } });
    });
    await page.route('**/api/jobs/scan', (route) => {
      calls++;
      if (calls > 1 && !recovering) return;
      return route.fulfill({ json: job });
    });
    await page.goto(
      target === 'snapshot' ? '/overview' : target === 'scan' ? '/jobs?job=scan' : '/jobs',
    );
    if (target === 'scan') {
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.clock.runFor(1500);
      await expect.poll(() => calls).toBe(2);
    } else {
      // React can mount history after navigation completes. Advance its initial
      // zero-delay load only once the effect has had a chance to register it.
      await expect
        .poll(async () => {
          await page.clock.runFor(1);
          return calls;
        })
        .toBe(1);
    }
    await page.clock.runFor(30_001);
    const message = german
      ? 'Die Antwort des Servers dauert zu lange. Prüfe deine Verbindung.'
      : 'The server took too long to respond. Check your connection.';
    await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
    await page.screenshot({
      path: `test-results/${info.project.name}-${target}-timeout.png`,
      fullPage: true,
    });
    const previous = calls;
    recovering = true;
    // A poll can start at the same tick as the first deadline, before recovery.
    // Allow that already-stalled read to expire as well.
    await page.clock.runFor(35_000);
    await expect.poll(() => calls).toBeGreaterThan(previous);
    await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0);
  });
}
