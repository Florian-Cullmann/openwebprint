import { afterEach, describe, expect, it } from 'vitest';
import {
  displayJobTitle,
  initialLanguage,
  setLanguage,
  t,
  plural,
  formatNumber,
  formatDateTime,
  formatBytes,
  serverMessage,
} from '../src/i18n.js';
import de from '../src/de.json';
import {
  publicErrorBody,
  publicMessages,
  publicMessageText,
  publicMessageParts,
} from '@openwebprint/shared';

afterEach(() => setLanguage('en'));
describe('language preferences and presentation', () => {
  it('honors an explicit preference, then the first supported browser language, then English', () => {
    expect(initialLanguage('en', ['de-DE'])).toBe('en');
    expect(initialLanguage('de', ['en-US'])).toBe('de');
    expect(initialLanguage('invalid', ['fr-FR', 'de-AT', 'en-US'])).toBe('de');
    expect(initialLanguage(null, ['fr-FR'])).toBe('en');
    expect(initialLanguage('constructor', ['toString', 'de-DE'])).toBe('de');
  });
  it('uses the selected locale for numbers, dates, file sizes, plural forms and safe errors', () => {
    setLanguage('de');
    expect(t('Devices')).toBe('Geräte');
    expect(
      displayJobTitle({
        kind: 'scan',
        title: 'Scan · 28/10/2026',
        createdAt: '2026-10-28T12:00:00Z',
      }),
    ).toBe('Scan · 28.10.26');
    expect(
      displayJobTitle({
        kind: 'print',
        title: 'Scan · 28/10/2026',
        createdAt: '2026-10-28T12:00:00Z',
      }),
    ).toBe('Scan · 28/10/2026');
    expect(
      displayJobTitle({
        kind: 'scan',
        title: 'Scan · 28/10/2026',
        customTitle: true,
        createdAt: '2026-10-28T12:00:00Z',
      }),
    ).toBe('Scan · 28/10/2026');
    expect(plural('{count} page', '{count} pages', 1)).toBe('1 Seite');
    expect(plural('{count} page', '{count} pages', 0)).toBe('0 Seiten');
    expect(plural('{count} page', '{count} pages', 1234)).toBe('1.234 Seiten');
    expect(formatNumber(1234.5)).toBe('1.234,5');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1,25 MB');
    expect(formatDateTime('2026-10-28T12:00:00Z', { timeZone: 'UTC', dateStyle: 'short' })).toBe(
      '28.10.26',
    );
    expect(t('new untranslated phrase')).toBe('new untranslated phrase');
    expect(t('toString')).toBe('toString');
    expect(t('{constructor}')).toBe('{constructor}');
    expect(t('Open preview: {value1}', { value1: '<private>{count}.pdf' })).toBe(
      'Vorschau öffnen: <private>{count}.pdf',
    );
    expect(t('Page numbers must be between 1 and 20.')).toBe(
      'Seitennummern müssen zwischen 1 und 20 liegen.',
    );
    expect(serverMessage('private backend /secret')).toBe(
      'Der Vorgang ist fehlgeschlagen. Prüfe die Serverprotokolle.',
    );
    setLanguage('en');
    expect(formatNumber(1234.5)).toBe('1,234.5');
    expect(plural('{count} page', '{count} pages', 2)).toBe('2 pages');
  });
  it('preserves interpolation placeholders and translates every public error', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
    for (const [english, german] of Object.entries(de))
      expect(placeholders(german), english).toEqual(placeholders(english));
    for (const text of Object.values(publicMessages)) expect(de).toHaveProperty(text);
  });
});
describe('stable public error contract', () => {
  it('returns an explicit code and parameters while rejecting private diagnostics', () => {
    const error = publicErrorBody('Page numbers must be between 1 and 20.');
    expect(error.params).toEqual({ value1: 20 });
    expect(publicMessageText(error.code, error.params)).toBe(error.error);
    expect(publicErrorBody('database failed: /private/secret').code).toBe('operation_failed');
    expect(
      publicMessageParts(
        'Acquisition incomplete. Kept 2 recovered pages. private backend diagnostic',
      ),
    ).toEqual([
      { code: 'recovered_pages', params: { value1: 2 } },
      { code: 'operation_failed', params: {} },
    ]);
    expect(publicMessageText('__proto__')).toBe(publicMessages.operation_failed);
    expect(publicMessageText(error.code, { value1: '/private/secret' })).toBe(
      publicMessages.operation_failed,
    );
    expect(
      publicErrorBody('scanimage is not installed. Check the hardware configuration.').params,
    ).toEqual({ value1: 'scanimage' });
  });
});
