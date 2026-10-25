import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Navigation öffnen' });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .first()
    .click();
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}
async function accessible(page: Page) {
  const audit = await new AxeBuilder({ page }).analyze();
  expect(
    audit.violations
      .filter((v) => ['critical', 'serious'].includes(v.impact ?? ''))
      .map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
  ).toEqual([]);
}
test('setup/login → print → status → scan → PDF → devices → dark mode', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const welcome = page.getByRole('button', { name: 'Einrichtung starten' });
  await expect(
    welcome.or(page.getByRole('button', { name: 'Anmelden', exact: true })),
  ).toBeVisible();
  if (await welcome.isVisible()) {
    await accessible(page);
    await welcome.click();
    await page.getByLabel('Einrichtungsschlüssel').fill('browser-test-setup-token-000000');
  }
  await page.getByLabel('Benutzername', { exact: true }).fill('browser-admin');
  await page.getByLabel('Passwort', { exact: true }).fill('browser-password-12345');
  await page.getByRole('button', { name: /^(Zugang erstellen|Anmelden)$/ }).click();
  await expect(page.getByRole('heading', { name: 'Übersicht' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Brother MFC-L2750DW', exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  await accessible(page);
  await page.screenshot({
    path:
      info.project.name === 'desktop'
        ? 'docs/images/dashboard.png'
        : 'test-results/mobile-dashboard.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Dokument drucken', exact: true }).click();
  const png = await sharp({
    create: { width: 200, height: 300, channels: 3, background: '#edf7f3' },
  })
    .png()
    .toBuffer();
  await page.getByLabel('Dokument auswählen', { exact: true }).setInputFiles({
    name: `${info.project.name}-document.png`,
    mimeType: 'image/png',
    buffer: png,
  });
  await page.getByLabel('Kopien', { exact: true }).fill('2');
  await accessible(page);
  await page.getByRole('button', { name: 'Demo-Druck starten' }).click();
  await expect(page.getByRole('heading', { name: 'Auftrag übertragen' })).toBeVisible();
  await page.getByRole('button', { name: 'Zu meinem Workflow' }).click();
  await navigate(page, 'Aufträge');
  const row = page.getByRole('row').filter({ hasText: `${info.project.name}-document.png` });
  await expect(row).toContainText('2 Kopien');
  await expect(row).toContainText('Abgeschlossen', { timeout: 20_000 });
  await noOverflow(page);
  await navigate(page, 'Meine Scans');
  await page.getByRole('button', { name: 'Neuer Scan', exact: true }).click();
  await page.getByRole('button', { name: 'Demo-Scan starten', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Scan abgeschlossen' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByAltText('Vorschau des gescannten Dokuments')).toBeVisible();
  await noOverflow(page);
  await accessible(page);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'PDF herunterladen' }).click();
  const download = await downloadEvent;
  expect((await PDFDocument.load(await readFile((await download.path())!))).getPageCount()).toBe(1);
  await page.getByRole('button', { name: 'Schließen', exact: true }).click();
  await navigate(page, 'Meine Geräte');
  await page.getByRole('button', { name: 'Gerät hinzufügen', exact: true }).click();
  await page.getByRole('button', { name: 'Geräte suchen', exact: true }).click();
  await expect(page.getByText('3 GERÄTE GEFUNDEN')).toBeVisible();
  await page.getByRole('button', { name: 'Manuell hinzufügen' }).click();
  await page.getByLabel('Name', { exact: true }).fill(`Brother Lab ${info.project.name}`);
  await page.getByLabel('Demo-Adresse').fill(`demo://lab-${info.project.name}`);
  await page.getByLabel('Standort').fill('Labor');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Gerät hinzufügen', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: `Brother Lab ${info.project.name}` }),
  ).toBeVisible();
  await page.reload();
  await navigate(page, 'Meine Geräte');
  await expect(
    page.getByRole('heading', { name: `Brother Lab ${info.project.name}` }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Farbschema wechseln' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await navigate(page, 'Einstellungen');
  await noOverflow(page);
  await accessible(page);
  await navigate(page, 'Übersicht');
  await page.screenshot({ path: `test-results/${info.project.name}-dark.png`, fullPage: true });
  expect(errors).toEqual([]);
});
