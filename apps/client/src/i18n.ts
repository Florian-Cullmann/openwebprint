import {
  publicMessage,
  publicMessages,
  publicMessageParts,
  publicMessageText,
  type Job,
} from '@openwebprint/shared';
import { useSyncExternalStore } from 'react';
import de from './de.json';

// Add languages here; the picker, browser preference detection and formatting use this registry.
export const languages = {
  en: { name: 'English', locale: 'en-GB', messages: {} as Record<string, string> },
  de: { name: 'Deutsch', locale: 'de-DE', messages: de as Record<string, string> },
};
export type Language = keyof typeof languages;
export const supportedLanguages = Object.keys(languages) as Language[];
type Params = Record<string, string | number | boolean | null | undefined>;
const storageKey = 'owp-language';
const listeners = new Set<() => void>();

function isLanguage(value: string | null): value is Language {
  return value !== null && Object.hasOwn(languages, value);
}
export function initialLanguage(saved: string | null, languages: readonly string[]): Language {
  if (isLanguage(saved)) return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (isLanguage(base)) return base;
  }
  return 'en';
}
let saved: string | null = null;
try {
  if (typeof window !== 'undefined') saved = localStorage.getItem(storageKey);
} catch {
  // Storage may be disabled. The language still works for this tab.
}
let language = initialLanguage(saved, typeof navigator === 'undefined' ? [] : navigator.languages);
export const getLanguage = () => language;
export const getLocale = () => languages[language].locale;
function applyLanguage(next: Language) {
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  for (const listener of listeners) listener();
}
applyLanguage(language);
export function setLanguage(next: Language) {
  try {
    if (typeof window !== 'undefined') localStorage.setItem(storageKey, next);
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
  applyLanguage(next);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null)
      applyLanguage(initialLanguage(event.newValue, navigator.languages));
  };
  window.addEventListener('storage', storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', storage);
  };
}
export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage, () => 'en' as const);
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}
export function formatDateTime(value: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(
    getLocale(),
    options ?? {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ).format(new Date(value));
}
export function t(key: string, params: Params = {}): string {
  if (!key.includes('{')) {
    const found = publicMessage(key);
    if (found.code !== 'operation_failed') {
      key = publicMessages[found.code];
      params = { ...found.params, ...params };
    }
    const http = /^The request failed \(HTTP (\d{3})\)\.$/.exec(key);
    if (http) {
      key = 'The request failed (HTTP {status}).';
      params = { status: Number(http[1]) };
    }
  }
  const translations = languages[language].messages;
  const text = Object.hasOwn(translations, key) ? translations[key] : key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;
    const value = params[name];
    if (value === false) return '';
    if (value === undefined || value === null) return name in params ? '' : match;
    return typeof value === 'number' ? formatNumber(value) : String(value);
  });
}
export function plural(one: string, other: string, count: number, params: Params = {}) {
  return t(new Intl.PluralRules(getLocale()).select(count) === 'one' ? one : other, {
    ...params,
    count,
  });
}
export function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB`
    : `${formatNumber(bytes / 1024 / 1024, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MB`;
}

// API and persisted job errors are translated only from this allowlist.
export function serverMessage(message: string): string {
  return publicMessageParts(message)
    .map(({ code, params }) => t(publicMessageText(code, params)))
    .join(' ');
}
export function jobError(job: Job): string {
  return job.errorMessages?.length
    ? job.errorMessages.map(({ code, params }) => t(publicMessageText(code, params))).join(' ')
    : serverMessage(job.error ?? '');
}

export function hardwareText(value: string): string {
  const printingTool = /^Printing tool: (.+)$/.exec(value);
  if (printingTool) return t('Printing tool: {tool}', { tool: printingTool[1] });
  const homebrew =
    ' Homebrew is also missing. Install it explicitly from https://brew.sh, then rerun the integrated setup to install SANE. A package manager will never be installed automatically.';
  if (value.endsWith(homebrew)) return t(value.slice(0, -homebrew.length)) + t(homebrew);
  return t(value);
}

export function displayJobTitle(job: Pick<Job, 'kind' | 'title' | 'createdAt'>): string {
  // Scan titles are generated by the server. Keep document/user titles verbatim.
  return job.kind === 'scan' && /^Scan · \d{2}\/\d{2}\/\d{4}$/.test(job.title)
    ? t('Scan · {date}', { date: formatDateTime(job.createdAt, { dateStyle: 'short' }) })
    : job.title;
}
