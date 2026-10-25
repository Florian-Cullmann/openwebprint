import { useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, Printer } from 'lucide-react';
import type { SessionInfo } from '@openwebprint/shared';
import { post } from './api';
import { Spinner } from './ui';
import s from './App.module.css';
export function AuthScreen({ session, done }: { session: SessionInfo; done: () => Promise<void> }) {
  const [step, setStep] = useState(session.initialized ? 1 : 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const form = new FormData(e.currentTarget);
    try {
      await post(session.initialized ? '/login' : '/setup', {
        username: form.get('username'),
        password: form.get('password'),
        token: form.get('token'),
      });
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
        <span className={s.modeLabel}>
          {session.mode === 'demo' ? 'Demo-Modus · simulierte Geräte' : 'Hardwarebetrieb'}
        </span>
        {!session.initialized && step === 0 ? (
          <>
            <h1>openwebprint einrichten</h1>
            <p>Erstelle einen geschützten Zugang für deine Drucker und Scanner.</p>
            <p>
              {session.mode === 'demo'
                ? 'Im Demo-Modus kannst du die Funktionen mit vorbereiteten Geräten ausprobieren.'
                : 'Nach der Anmeldung kannst du deine Geräte suchen oder manuell hinzufügen.'}
            </p>
            <button className={s.primary} onClick={() => setStep(1)}>
              Einrichtung starten <ArrowRight size={17} />
            </button>
          </>
        ) : (
          <>
            <h1>{session.initialized ? 'Anmelden' : 'Zugang einrichten'}</h1>
            <p>
              {session.initialized
                ? 'Melde dich an, um zu drucken und zu scannen.'
                : 'Den Einrichtungsschlüssel findest du im Serverterminal oder in den Docker-Logs.'}
            </p>
            <form onSubmit={submit} className={s.form}>
              {!session.initialized && (
                <label>
                  Einrichtungsschlüssel
                  <input
                    name="token"
                    type="password"
                    autoComplete="off"
                    required
                    placeholder="Schlüssel aus dem Serverterminal"
                  />
                </label>
              )}
              <label>
                Benutzername
                <input
                  name="username"
                  autoComplete="username"
                  required
                  maxLength={80}
                  placeholder="Dein Benutzername"
                />
              </label>
              <label>
                Passwort
                <input
                  name="password"
                  type="password"
                  autoComplete={session.initialized ? 'current-password' : 'new-password'}
                  required
                  minLength={12}
                  maxLength={256}
                  placeholder="Mindestens 12 Zeichen"
                />
              </label>
              {error && (
                <p className={s.error} role="alert">
                  {error}
                </p>
              )}
              <button className={s.primary} disabled={busy}>
                {busy ? <Spinner /> : <LockKeyhole size={17} />}{' '}
                {session.initialized ? 'Anmelden' : 'Zugang erstellen'}
              </button>
            </form>
          </>
        )}
        <p className={s.authFooter}>Selbst gehostet · Open Source</p>
      </div>
    </main>
  );
}
