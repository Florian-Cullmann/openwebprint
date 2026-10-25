import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, LockKeyhole, Printer, ShieldCheck, Sparkles } from 'lucide-react';
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
    <div className={s.authPage}>
      <div className={s.authVisual}>
        <div className={s.brand}>
          <span className={s.brandMark}>
            <Printer size={23} />
          </span>
          openwebprint<span className={s.brandDot}>.</span>
        </div>
        <div className={s.authPitch}>
          <span className={s.eyebrow}>DEIN PAPIER. DEIN WORKFLOW.</span>
          <h1>
            Einfach drucken.
            <br />
            Entspannt scannen.
            <br />
            <span>Alles bei dir.</span>
          </h1>
          <p>
            Ein Browser für deine Drucker und Scanner.
            <br />
            Offen, unabhängig und unter deiner Kontrolle.
          </p>
          <div className={s.authFeatures}>
            <span>
              <Check size={17} />
              100 % Open Source
            </span>
            <span>
              <Check size={17} />
              Selbst gehostet
            </span>
            <span>
              <Check size={17} />
              Auch für Brother, HP, Canon & Epson
            </span>
          </div>
        </div>
        <span className={s.authFooter}>Weniger Software. Mehr Möglichkeiten.</span>
      </div>
      <main className={s.authMain}>
        <div className={s.authCard}>
          <span className={`${s.badge} ${session.mode === 'demo' ? s.amber : s.green}`}>
            {session.mode === 'demo' ? <Sparkles size={14} /> : <ShieldCheck size={14} />}{' '}
            {session.mode === 'demo' ? 'Demo-Modus · ohne Hardware' : 'Hardwarebetrieb'}
          </span>
          {!session.initialized && step === 0 ? (
            <>
              <h2>Willkommen zu Hause.</h2>
              <p>
                Dein neuer Workflow beginnt hier. Richte in wenigen Schritten deinen persönlichen
                Druck- und Scanbereich ein.
              </p>
              <ol className={s.setupSteps}>
                <li>
                  <span>1</span>
                  <div>
                    <h3>Zugang einrichten</h3>
                    <p>Schütze deine Geräte und Dokumente.</p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <h3>Geräte verbinden</h3>
                    <p>
                      {session.mode === 'demo'
                        ? 'Simulierte Geräte sind bereits vorbereitet.'
                        : 'Im Netzwerk suchen oder manuell hinzufügen.'}
                    </p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <h3>Loslegen</h3>
                    <p>Drucken und scannen direkt im Browser.</p>
                  </div>
                </li>
              </ol>
              <button className={s.primary} onClick={() => setStep(1)}>
                Einrichtung starten <ArrowRight size={17} />
              </button>
            </>
          ) : (
            <>
              <h2>
                {session.initialized ? 'Schön, dass du da bist.' : 'Dein persönlicher Zugang.'}
              </h2>
              <p>
                {session.initialized
                  ? 'Melde dich an, um deine Geräte zu verwalten.'
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
              <p className={s.privacy}>
                <ShieldCheck size={15} /> Dein Zugang bleibt auf deinem Server.
              </p>
            </>
          )}
        </div>
        <span className={s.authBottom}>
          openwebprint · MIT-lizenziert · Keine Cloud erforderlich
        </span>
      </main>
    </div>
  );
}
