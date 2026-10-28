import { Languages } from 'lucide-react';
import { setLanguage, t, useLanguage, type Language } from './i18n';
import s from './App.module.css';

export function LanguagePicker() {
  const language = useLanguage();
  return (
    <label className={s.languagePicker}>
      <Languages size={17} aria-hidden="true" />
      <span className={s.srOnly}>{t('Language')}</span>
      <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
        <option value="en" lang="en">
          English
        </option>
        <option value="de" lang="de">
          Deutsch
        </option>
      </select>
    </label>
  );
}
