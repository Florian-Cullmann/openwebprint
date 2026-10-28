import { languages, supportedLanguages, setLanguage, t, useLanguage } from './i18n';
import s from './App.module.css';

export function LanguagePicker() {
  const language = useLanguage();
  const label = `${t('Language')}: ${language.toUpperCase()} (${languages[language].name})`;
  const next =
    supportedLanguages[(supportedLanguages.indexOf(language) + 1) % supportedLanguages.length];
  return (
    <button
      type="button"
      className={`${s.iconButton} ${s.languagePicker}`}
      title={label}
      aria-label={label}
      onClick={() => setLanguage(next)}
    >
      {language.toUpperCase()}
    </button>
  );
}
