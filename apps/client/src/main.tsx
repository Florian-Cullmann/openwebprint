import { t, useLanguage } from './i18n';
import { LanguagePicker } from './LanguagePicker';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { App } from './App';
import './global.css';
function NotFound() {
  useLanguage();
  return (
    <main style={{ padding: '64px 24px', textAlign: 'center' }}>
      <LanguagePicker />
      <h1>{t('Page not found')}</h1>
      <p>
        <Link to="/overview">{t('Go to overview')}</Link>
      </p>
    </main>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
        <Route path="/" element={<Navigate to="/overview" replace />} />
        {[
          'overview',
          'devices',
          'jobs',
          'scans',
          'login',
          'setup',
          'settings/general',
          'settings/users',
          'settings/appearance',
          'settings/hardware',
        ].map((path) => (
          <Route key={path} path={`/${path}`} element={<App />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
