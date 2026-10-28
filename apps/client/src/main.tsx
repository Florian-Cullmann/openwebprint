import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { App } from './App';
import './global.css';
function NotFound() {
  return (
    <main style={{ padding: '64px 24px', textAlign: 'center' }}>
      <h1>Page not found</h1>
      <p>
        <Link to="/overview">Go to overview</Link>
      </p>
    </main>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route element={<App />}>
          {[
            'overview',
            'devices',
            'jobs',
            'scans',
            'login',
            'setup',
            'settings',
            'settings/general',
            'settings/users',
            'settings/appearance',
            'settings/hardware',
          ].map((path) => (
            <Route key={path} path={`/${path}`} element={null} />
          ))}
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
