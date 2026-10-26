import { useState, type FormEvent } from 'react';
import { LockKeyhole, Printer } from 'lucide-react';
import { post } from './api';
import { Spinner } from './ui';
import s from './App.module.css';
export function AuthScreen({ done, demo }: { done: () => Promise<void>; demo: boolean }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const form = new FormData(e.currentTarget);
    try {
      await post('/login', { username: form.get('username'), password: form.get('password') });
      await done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={s.authPage}>
      <div className={s.authCard}>
        <div className={s.brand}>
          <span className={s.brandMark}>
            <Printer size={21} />
          </span>
          openwebprint
        </div>
        {demo && <span className={s.modeLabel}>Demo mode · simulated devices</span>}
        <h1>Sign in</h1>
        <p>Sign in to use your printers and scanners.</p>
        <form onSubmit={submit} className={s.form}>
          <label>
            Username
            <input name="username" autoComplete="username" required maxLength={80} />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
          <button className={s.primary} disabled={busy}>
            {busy ? <Spinner /> : <LockKeyhole size={17} />} Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
