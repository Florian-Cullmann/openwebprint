import { expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import AxeBuilder from '@axe-core/playwright';
import { isolatedTest } from './isolated-server';
const test = isolatedTest();

const text = {
  en: {
    welcome: 'Welcome to openwebprint',
    demo: 'Try demo',
    overview: 'Overview',
    navigation: 'Main navigation',
    print: 'Print',
    printTitle: 'Print document',
    select: 'Select document',
    printStart: 'Start demo print',
    submitted: 'Job submitted',
    done: 'Done',
    scan: 'Scan',
    scanStart: 'Start demo scan',
    complete: 'Scan complete',
    page: '1 page',
    pages: '2 pages',
    another: 'Scan another page',
    close: 'Close',
    jobs: 'Jobs',
    allJobs: 'All jobs',
    settings: 'Settings',
    categories: 'Settings categories',
    users: 'Users',
    username: 'Username',
    password: 'Password',
    confirm: 'Confirm password',
    addUser: 'Add user',
    signIn: 'Sign in',
    signOut: 'Sign out',
    wrongPassword: 'Incorrect username or password.',
    mode: 'Operating mode',
    language: 'Language',
    scans: 'Scans',
    search: 'Search scans',
    clearSearch: 'Clear search',
    noMatches: 'No scans match your search. Try another title or clear the search.',
    selectScan: 'Select scan:',
    export: 'Export selected scans',
    downloadZip: 'Download ZIP',
    notifications: 'Job notifications',
    rename: 'Rename scan',
    title: 'Scan title',
    saveTitle: 'Save title',
    titleSaved: 'Title saved.',
    filters: 'Filter history',
    device: 'Device',
    status: 'Status',
    clearFilters: 'Clear filters',
  },
  de: {
    welcome: 'Willkommen bei openwebprint',
    demo: 'Demo ausprobieren',
    overview: 'Übersicht',
    navigation: 'Hauptnavigation',
    print: 'Drucken',
    printTitle: 'Dokument drucken',
    select: 'Dokument auswählen',
    printStart: 'Demodruck starten',
    submitted: 'Auftrag übermittelt',
    done: 'Fertig',
    scan: 'Scannen',
    scanStart: 'Demoscan starten',
    complete: 'Scan abgeschlossen',
    page: '1 Seite',
    pages: '2 Seiten',
    another: 'Weitere Seite scannen',
    close: 'Schließen',
    jobs: 'Aufträge',
    allJobs: 'Alle Aufträge',
    settings: 'Einstellungen',
    categories: 'Einstellungskategorien',
    users: 'Benutzer',
    username: 'Benutzername',
    password: 'Passwort',
    confirm: 'Passwort bestätigen',
    addUser: 'Benutzer hinzufügen',
    signIn: 'Anmelden',
    signOut: 'Abmelden',
    wrongPassword: 'Benutzername oder Passwort falsch.',
    mode: 'Betriebsmodus',
    language: 'Sprache',
    scans: 'Scans',
    search: 'Scans durchsuchen',
    clearSearch: 'Suche zurücksetzen',
    noMatches:
      'Keine Scans entsprechen deiner Suche. Versuche einen anderen Titel oder setze die Suche zurück.',
    selectScan: 'Scan auswählen:',
    export: 'Ausgewählte Scans exportieren',
    downloadZip: 'ZIP herunterladen',
    notifications: 'Auftragsbenachrichtigungen',
    rename: 'Scan umbenennen',
    title: 'Scantitel',
    saveTitle: 'Titel speichern',
    titleSaved: 'Titel gespeichert.',
    filters: 'Verlauf filtern',
    device: 'Gerät',
    status: 'Status',
    clearFilters: 'Filter zurücksetzen',
  },
};
async function verifyLayout(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
}
for (const language of ['en', 'de'] as const) {
  test.describe(language, () => {
    test.use({ locale: language === 'de' ? 'de-DE' : 'en-GB' });
    test('setup, print, scan, jobs, settings and sign-in use the selected language (demo hardware)', async ({
      page,
    }, info) => {
      const labels = text[language];
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('/overview');
      await expect(page.getByRole('heading', { name: labels.welcome })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await verifyLayout(page);
      await page.getByRole('button', { name: labels.demo, exact: true }).click();
      await expect(page.getByRole('heading', { name: labels.overview, exact: true })).toBeVisible();
      await page.getByRole('button', { name: labels.print, exact: true }).first().click();
      const pdf = await PDFDocument.create();
      pdf.addPage([200, 300]);
      await page.getByLabel(labels.select, { exact: true }).setInputFiles({
        name: 'localization.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await pdf.save()),
      });
      await expect(page.getByRole('heading', { name: labels.printTitle })).toBeVisible();
      await expect(page.getByRole('button', { name: labels.printStart })).toBeEnabled();
      await verifyLayout(page);
      await page.screenshot({
        path: `test-results/${info.project.name}-${language}-print.png`,
        fullPage: true,
      });
      await page.getByRole('button', { name: labels.printStart }).click();
      await expect(
        page.getByRole('heading', { name: labels.submitted, exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: labels.done, exact: true }).click();
      await page.getByRole('button', { name: labels.scan, exact: true }).first().click();
      await page.getByRole('button', { name: labels.scanStart, exact: true }).click();
      await expect(page.getByRole('heading', { name: labels.complete })).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByText(labels.page, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: labels.another, exact: true }).click();
      await expect(page.getByText(labels.pages, { exact: true })).toBeVisible({ timeout: 15000 });
      await verifyLayout(page);
      await page.screenshot({
        path: `test-results/${info.project.name}-${language}-scan.png`,
        fullPage: true,
      });
      await page.getByRole('button', { name: labels.close, exact: true }).click();
      const nav = page.getByRole('navigation', { name: labels.navigation });
      await nav.getByRole('link', { name: new RegExp(`^${labels.jobs}`) }).click();
      await expect(page.getByRole('heading', { name: labels.allJobs, exact: true })).toBeVisible();
      await expect(page.getByRole('table')).toContainText('localization.pdf');
      const snapshot = await (await page.request.get('/api/snapshot')).json();
      const scan = snapshot.jobs.find((job: { kind: string }) => job.kind === 'scan');
      await expect(page.getByRole('table')).toContainText(
        `Scan · ${new Intl.DateTimeFormat(language === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'short' }).format(new Date(scan.createdAt))}`,
      );
      await verifyLayout(page);
      // Preserve the newly merged search and ZIP export journey in both languages.
      await nav.getByRole('link', { name: labels.scans, exact: true }).click();
      await page.getByText(labels.filters, { exact: true }).click();
      await page
        .getByRole('combobox', { name: labels.status, exact: true })
        .selectOption('completed');
      await expect(page.getByRole('combobox', { name: labels.device, exact: true })).toBeVisible();
      await verifyLayout(page);
      await page.getByRole('button', { name: labels.clearFilters, exact: true }).click();
      await page
        .getByRole('article')
        .getByRole('button', { name: /^(Open scan preview:|Scanvorschau öffnen:)/ })
        .first()
        .click();
      await page.getByRole('button', { name: labels.rename, exact: true }).click();
      await page
        .getByRole('textbox', { name: labels.title, exact: true })
        .fill('Meine Rechnung 2026');
      await page.getByRole('button', { name: labels.saveTitle, exact: true }).click();
      await expect(page.getByText(labels.titleSaved, { exact: true })).toBeVisible();
      await verifyLayout(page);
      await page.getByRole('button', { name: labels.close, exact: true }).click();

      await page
        .getByRole('searchbox', { name: labels.search, exact: true })
        .fill('no-match-localization');
      await expect(page.getByText(labels.noMatches, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: labels.clearSearch, exact: true }).click();
      await page
        .getByRole('checkbox', { name: new RegExp(`^${labels.selectScan}`) })
        .first()
        .check();
      const selection = page.getByRole('region', { name: labels.export, exact: true });
      await verifyLayout(page);
      await page.screenshot({
        path: `test-results/${info.project.name}-${language}-scan-export.png`,
        fullPage: true,
      });
      const downloaded = page.waitForEvent('download');
      await selection.getByRole('button', { name: labels.downloadZip, exact: true }).click();
      expect((await downloaded).suggestedFilename()).toBe('openwebprint-scans.zip');
      await nav.getByRole('link', { name: labels.settings, exact: true }).click();
      await expect(page.getByRole('heading', { name: labels.mode, exact: true })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: labels.notifications, exact: true }),
      ).toBeVisible();
      await verifyLayout(page);
      await page.screenshot({
        path: `test-results/${info.project.name}-${language}-settings.png`,
        fullPage: true,
      });
      await page
        .getByRole('navigation', { name: labels.categories })
        .getByRole('link', { name: labels.users, exact: true })
        .click();
      const username = `locale-${language}`;
      await page.getByLabel(labels.username, { exact: true }).fill(username);
      await page.getByLabel(labels.password, { exact: true }).fill('sample-password');
      await page.getByLabel(labels.confirm, { exact: true }).fill('sample-password');
      await page.getByRole('button', { name: labels.addUser, exact: true }).click();
      await expect(page.getByRole('heading', { name: labels.signIn, exact: true })).toBeVisible();
      // Login errors come from the real server's stable error code.
      await page.getByLabel(labels.username, { exact: true }).fill(username);
      await page.getByLabel(labels.password, { exact: true }).fill('wrong');
      await page.getByRole('button', { name: labels.signIn, exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText(labels.wrongPassword);
      await page.getByLabel(labels.password, { exact: true }).fill('sample-password');
      await page.getByRole('button', { name: labels.signIn, exact: true }).click();
      await expect(page.getByRole('heading', { name: labels.users, exact: true })).toBeVisible();
      // A manual choice overrides the browser locale and survives navigation/reload.
      const other = language === 'de' ? 'en' : 'de';
      const picker = page.getByRole('button', { name: new RegExp(`^${labels.language}:`) });
      await expect(picker).toHaveText(language.toUpperCase());
      await picker.focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('button', { name: new RegExp(`^${text[other].language}:`) }),
      ).toHaveText(other.toUpperCase());
      await expect(
        page.getByRole('heading', { name: text[other].users, exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', other);
      await expect(
        page.getByRole('heading', { name: text[other].users, exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: text[other].signOut, exact: true }).click();
      await expect(
        page.getByRole('heading', { name: text[other].signIn, exact: true }),
      ).toBeVisible();
      await verifyLayout(page);
      expect(errors).toEqual([]);
    });
  });
}

test('synchronizes a language change across tabs without resetting an open print form', async ({
  page,
  context,
}) => {
  await page.goto('/overview');
  if ((await page.locator('html').getAttribute('lang')) === 'de')
    await page.getByRole('button', { name: 'Sprache: DE (Deutsch)', exact: true }).click();
  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.getByRole('button', { name: 'Print', exact: true }).first().click();
  await page.getByLabel('Copies', { exact: true }).fill('3');
  const second = await context.newPage();
  await second.goto(new URL('/overview', page.url()).href);
  await second.getByRole('button', { name: 'Language: EN (English)', exact: true }).click();
  await expect(
    second.getByRole('button', { name: 'Sprache: DE (Deutsch)', exact: true }),
  ).toHaveText('DE');
  await expect(page.getByRole('heading', { name: 'Dokument drucken', exact: true })).toBeVisible();
  await expect(page.getByLabel('Kopien', { exact: true })).toHaveValue('3');
  await second.close();
});
