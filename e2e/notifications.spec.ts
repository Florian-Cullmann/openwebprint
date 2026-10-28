import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Job, Snapshot } from '@openwebprint/shared';
import { PDFDocument } from 'pdf-lib';

declare global {
  interface Window {
    notificationFixture: {
      permission: NotificationPermission;
      result: NotificationPermission;
      requests: number;
      throws: boolean;
      items: { body: string; tag: string; closed: boolean; onclick?: () => void }[];
    };
  }
}
// Browser-controlled API/Notification fixtures. No OS notification or hardware is contacted.
async function setup(
  context: BrowserContext,
  options: {
    permission?: NotificationPermission;
    result?: NotificationPermission;
    unsupported?: boolean;
    insecure?: boolean;
    mode?: Job['mode'];
    throws?: boolean;
  } = {},
) {
  await context.addInitScript((options) => {
    window.notificationFixture = {
      permission: options.permission ?? 'default',
      result: options.result ?? 'granted',
      requests: 0,
      throws: options.throws ?? false,
      items: [],
    };
    if (options.insecure) Object.defineProperty(window, 'isSecureContext', { value: false });
    if (options.unsupported) {
      delete (window as unknown as Record<string, unknown>).Notification;
      return;
    }
    class FixtureNotification {
      static get permission() {
        return window.notificationFixture.permission;
      }
      static async requestPermission() {
        const fixture = window.notificationFixture;
        fixture.requests++;
        fixture.permission = fixture.result;
        return fixture.result;
      }
      body: string;
      tag: string;
      closed = false;
      onclick?: () => void;
      constructor(_title: string, options: NotificationOptions) {
        if (window.notificationFixture.throws) throw new TypeError('Mobile fixture');
        this.body = options.body!;
        this.tag = options.tag!;
        window.notificationFixture.items.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, 'Notification', {
      value: FixtureNotification,
      configurable: true,
    });
  }, options);
  const mode = options.mode ?? 'hardware';
  const jobs = new Map<string, Job>();
  const historical: Job = {
    id: 'historical',
    kind: 'print',
    status: 'completed',
    title: 'Private historical title',
    deviceName: 'Private printer',
    deviceId: 'printer',
    mode,
    options: { copies: 1, color: 'monochrome', sides: 'one-sided', media: 'iso_a4_210x297mm' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasFile: false,
  };
  jobs.set(historical.id, historical);
  let disconnected = false;
  let hold: (() => Promise<void>) | undefined;
  const reads = new Map<string, number>();
  let last!: Job;
  const snapshot = (): Snapshot => ({
    mode,
    devicesCheckedAt: new Date().toISOString(),
    jobs: [...jobs.values()],
    warnings: [],
    devices: [
      {
        id: 'printer',
        kind: 'printer',
        name: 'Private printer',
        address: 'fixture',
        location: 'Fixture',
        capabilities: {
          color: false,
          colorModes: ['monochrome'],
          sides: ['one-sided'],
          media: ['iso_a4_210x297mm'],
        },
        provider: 'cups',
        mode,
        status: 'ready',
      },
      {
        id: 'scanner',
        kind: 'scanner',
        name: 'Private scanner',
        address: 'fixture',
        location: 'Fixture',
        provider: 'sane',
        mode,
        status: 'ready',
      },
    ],
  });
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(4);
    if (path === '/session')
      return route.fulfill({
        json: {
          mode,
          onboardingRequired: false,
          authenticationRequired: false,
          authenticated: true,
          user: { id: 'fixture-user', username: 'fixture' },
        },
      });
    if (path === '/snapshot') return route.fulfill({ json: snapshot() });
    if (path === '/storage') return route.fulfill({ json: { path: '/fixture/scans' } });
    if (path === '/retention') return route.fulfill({ json: { printDays: 7, scanDays: 7 } });
    if (path.endsWith('/scan-sources'))
      return route.fulfill({
        json: { sources: [{ name: 'Flatbed', feeder: false }], duplex: false },
      });
    if (path === '/documents/preview')
      return route.fulfill({ contentType: 'application/pdf', body: bytes });
    if (path === '/scans' || path === '/print') {
      last = {
        ...historical,
        id: crypto.randomUUID(),
        kind: path === '/scans' ? 'scan' : 'print',
        status: 'processing',
        title: 'Secret document name',
        error: undefined,
      };
      jobs.set(last.id, last);
      return route.fulfill({ json: last });
    }
    if (path.startsWith('/jobs/')) {
      const id = path.split('/')[2];
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (hold) await hold();
      if (disconnected) return route.abort('failed');
      const job = jobs.get(id);
      return route.fulfill(
        job ? { json: job } : { status: 404, json: { error: 'Job unavailable.' } },
      );
    }
    if (path === '/jobs')
      return route.fulfill({ json: { jobs: [...jobs.values()], total: jobs.size, offset: 0 } });
    if (path === '/logout') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'Not in fixture' } });
  });
  return {
    jobs,
    reads,
    bytes,
    last: () => last,
    finish: (status: Job['status'] = 'completed') => {
      jobs.set(last.id, { ...last, status });
    },
    disconnect: (value: boolean) => {
      disconnected = value;
    },
    hold: (value?: () => Promise<void>) => {
      hold = value;
    },
  };
}
async function settings(page: Page) {
  if (new URL(page.url()).pathname === '/settings/general') return;
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Job notifications', exact: true })).toBeVisible();
}
async function enable(page: Page) {
  await settings(page);
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Disable notifications', exact: true }),
  ).toBeVisible();
}
async function start(page: Page, bytes: Buffer, kind: 'scan' | 'print' = 'scan', demo = false) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Overview', exact: true })
    .click();
  await page
    .getByRole('button', { name: kind === 'scan' ? 'Scan' : 'Print', exact: true })
    .first()
    .click();
  if (kind === 'print')
    await page
      .getByLabel('Select document', { exact: true })
      .setInputFiles({ name: 'Secret.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page
    .getByRole('button', {
      name:
        kind === 'scan'
          ? demo
            ? 'Start demo scan'
            : 'Start scan'
          : demo
            ? 'Start demo print'
            : 'Print now',
      exact: true,
    })
    .click();
  await page.getByRole('dialog').getByLabel('Close', { exact: true }).click();
}
const count = (page: Page) => page.evaluate(() => window.notificationFixture.items.length);
const poll = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

test('permission is requested only by explicit opt-in; settings stay accessible (browser fixtures)', async ({
  page,
  context,
}, info) => {
  await setup(context);
  await page.goto('/settings/general');
  await expect(
    page.getByText('System notifications are off. Your browser', { exact: false }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.notificationFixture.requests)).toBe(0);
  await enable(page);
  expect(await page.evaluate(() => window.notificationFixture.requests)).toBe(1);
  await expect(page.getByText('System notifications are enabled', { exact: false })).toBeVisible();
  const a11y = await new AxeBuilder({ page }).analyze();
  expect(a11y.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .getByRole('heading', { name: 'Job notifications', exact: true })
    .locator('..')
    .locator('..')
    .screenshot({ path: `test-results/${info.project.name}-notifications-card.png` });
  await page.screenshot({
    path: `test-results/${info.project.name}-notifications-settings.png`,
    fullPage: true,
  });
});

for (const variant of ['denied', 'unsupported', 'insecure', 'dismissed', 'rejected'] as const) {
  test(`${variant} permission uses an in-app fallback (browser fixtures)`, async ({
    page,
    context,
  }) => {
    const fixture = await setup(context, {
      permission: variant === 'denied' ? 'denied' : 'default',
      result: variant === 'dismissed' ? 'default' : 'denied',
      unsupported: variant === 'unsupported',
      insecure: variant === 'insecure',
    });
    await page.goto('/settings/general');
    const button = page.getByRole('button', { name: 'Enable notifications', exact: true });
    if (variant === 'dismissed' || variant === 'rejected') await button.click();
    else await expect(button).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Disable notifications', exact: true }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => window.notificationFixture.requests)).toBe(
      variant === 'dismissed' || variant === 'rejected' ? 1 : 0,
    );
    await start(page, fixture.bytes);
    fixture.finish('failed');
    await poll(page);
    await expect(
      page.getByText('Scan failed. Check Jobs for details.', { exact: true }),
    ).toBeVisible();
    expect(await count(page)).toBe(0);
  });
}

test('local transitions notify once, omit private names, reconcile reconnects and open the job (browser fixtures)', async ({
  page,
  context,
}) => {
  const fixture = await setup(context, { permission: 'granted' });
  await page.clock.install();
  await page.goto('/settings/general');
  await poll(page);
  expect(await count(page)).toBe(0);
  await enable(page);
  await start(page, fixture.bytes, 'print');
  await settings(page); // Navigating must retain ownership of an active job.
  // Exercise the bounded poll even when the document is hidden.
  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { value: true, configurable: true }),
  );
  fixture.disconnect(true);
  const failed = page.waitForEvent('requestfailed', (request) =>
    request.url().endsWith(`/jobs/${fixture.last().id}`),
  );
  await poll(page);
  await failed;
  fixture.finish('unknown');
  fixture.disconnect(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => count(page)).toBe(1);
  expect(await page.evaluate(() => window.notificationFixture.items[0].body)).toBe(
    'Print outcome unknown. Check Jobs and the printer.',
  );
  await page.clock.runFor(15000);
  expect(await count(page)).toBe(1);
  await page.evaluate(() => window.notificationFixture.items[0].onclick?.());
  await expect(page).toHaveURL(new RegExp(`/jobs\\?job=${fixture.last().id}$`));
  await expect(page.getByRole('dialog', { name: 'Document preview' })).toContainText(
    'Secret document name',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open job', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Document preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await start(page, fixture.bytes, 'print');
  fixture.finish('completed');
  await poll(page);
  await expect.poll(() => count(page)).toBe(2);
  expect(await page.evaluate(() => window.notificationFixture.items[1].body)).toBe(
    'Print provider reported completion. Physical output is not confirmed.',
  );
  await start(page, fixture.bytes);
  fixture.finish('canceled');
  await poll(page);
  await expect.poll(() => count(page)).toBe(3);
  expect(await page.evaluate(() => JSON.stringify(window.notificationFixture.items))).not.toMatch(
    /Secret|Private/,
  );
});

test('demo transitions are marked and constructor failures retain in-app updates (browser fixtures)', async ({
  page,
  context,
}) => {
  const fixture = await setup(context, { permission: 'granted', mode: 'demo' });
  await page.goto('/settings/general');
  await enable(page);
  await start(page, fixture.bytes, 'scan', true);
  fixture.finish();
  await poll(page);
  await expect.poll(() => count(page)).toBe(1);
  expect(await page.evaluate(() => window.notificationFixture.items[0].body)).toBe(
    'Demo: Scan completed.',
  );
  await start(page, fixture.bytes, 'scan', true);
  await page.evaluate(() => {
    window.notificationFixture.throws = true;
  });
  fixture.finish('failed');
  await poll(page);
  await expect(
    page.getByText('Demo: Scan failed. Check Jobs for details.', { exact: true }),
  ).toBeVisible();
  await settings(page);
  await expect(
    page.getByText('System notifications could not be displayed.', { exact: false }),
  ).toBeVisible();
  expect(await count(page)).toBe(1);
});

test('tabs own separate jobs; preference changes, reload and logout discard stale work (browser fixtures)', async ({
  page,
  context,
}) => {
  const fixture = await setup(context, { permission: 'granted' });
  await page.goto('/settings/general');
  await enable(page);
  await start(page, fixture.bytes);
  const other = await context.newPage();
  await other.goto(new URL('/settings/general', page.url()).href);
  fixture.finish();
  await Promise.all([poll(page), poll(other)]);
  await expect.poll(() => count(page)).toBe(1);
  expect(await count(other)).toBe(0);
  await start(page, fixture.bytes);
  await other.getByRole('button', { name: 'Disable notifications', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.notificationFixture.items[0].closed))
    .toBe(true);
  fixture.finish('failed');
  await enable(page);
  await poll(page);
  expect(await count(page)).toBe(1);
  await start(page, fixture.bytes);
  fixture.finish();
  await page.reload();
  await poll(page);
  expect(await count(page)).toBe(0);
  await start(page, fixture.bytes);
  await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  // Wait for the cross-tab invalidation before completing the old job.
  await settings(page);
  fixture.finish();
  await poll(page);
  expect(await count(page)).toBe(0);
});

test('discarded in-flight polls and revoked permission never emit stale system notifications (browser fixtures)', async ({
  page,
  context,
}) => {
  const fixture = await setup(context, { permission: 'granted' });
  await page.goto('/settings/general');
  await enable(page);
  await start(page, fixture.bytes);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.hold(() => gate);
  await poll(page);
  await expect.poll(() => fixture.reads.get(fixture.last().id) ?? 0).toBeGreaterThan(0);
  await settings(page);
  await page.getByRole('button', { name: 'Disable notifications', exact: true }).click();
  fixture.finish();
  release();
  fixture.hold();
  await enable(page);
  await poll(page);
  expect(await count(page)).toBe(0);
  await start(page, fixture.bytes);
  await page.evaluate(() => {
    window.notificationFixture.permission = 'denied';
  });
  fixture.finish('failed');
  await poll(page);
  await expect(
    page.getByText('Scan failed. Check Jobs for details.', { exact: true }),
  ).toBeVisible();
  expect(await count(page)).toBe(0);
});
