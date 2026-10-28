import { t, plural } from './i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { Clock } from 'lucide-react';
import type { RetentionImpact, RetentionPolicy } from '@openwebprint/shared';
import { api, post } from './api';
import { Spinner } from './ui';
import s from './App.module.css';

export function RetentionSettings() {
  const [policy, setPolicy] = useState<RetentionPolicy>();
  const [impact, setImpact] = useState<RetentionImpact>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api<RetentionPolicy>('/retention')
      .then(setPolicy)
      .catch((e) => setError(e.message));
  }, []);
  async function save(confirm = false) {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      if (!confirm) {
        const affected = await post<RetentionImpact>('/retention/preview', policy);
        if (affected.scans || affected.prints) {
          setImpact(affected);
          return;
        }
      }
      setPolicy(
        await api<RetentionPolicy>('/retention', {
          method: 'PUT',
          body: JSON.stringify({ ...policy, confirm }),
        }),
      );
      setImpact(undefined);
      setSaved(true);
    } catch (e) {
      setImpact(undefined);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void save();
  }
  return (
    <section className={s.settingsCard}>
      <div className={s.settingsTitle}>
        <Clock size={20} />
        <h2>{t('Document retention')}</h2>
      </div>
      <p>
        {t('Choose how long this instance keeps scans and print PDFs, including demo documents.')}
      </p>
      <p>
        {t(
          'Periods run from job creation. Editing or adding scan pages does not extend them. Policy changes also apply to existing documents.',
        )}
      </p>
      <form onSubmit={submit} className={`${s.form} ${s.userForm}`}>
        {policy ? (
          <>
            <div className={s.formGrid}>
              {(['scanDays', 'printDays'] as const).map((key) => (
                <label key={key}>
                  {key === 'scanDays' ? t('Keep scans (days)') : t('Keep print PDFs (days)')}
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    required
                    disabled={busy}
                    value={Number.isNaN(policy[key]) ? '' : policy[key]}
                    onChange={(e) => {
                      setPolicy({ ...policy, [key]: e.target.valueAsNumber });
                      setImpact(undefined);
                      setSaved(false);
                    }}
                  />
                </label>
              ))}
            </div>
            <p className={s.small}>
              {t(
                'Use 1–3650 whole days. Indefinite retention is not offered. Cleanup runs at startup and hourly, waits for active operations, and preserves job records. Deleted files cannot be recovered by extending these periods.',
              )}
            </p>
            {impact && (
              <div role="alert">
                <p>
                  {t(
                    'This shorter policy makes {value1} {value2} and {value3} {value4} eligible for deletion at the next cleanup. This cannot be undone after deletion.',
                    {
                      value1: impact.scans,
                      value2: plural('scan', 'scans', impact.scans),
                      value3: impact.prints,
                      value4: plural('print PDF', 'print PDFs', impact.prints),
                    },
                  )}
                </p>
                <div className={s.modalActions}>
                  <button
                    type="button"
                    className={s.danger}
                    disabled={busy}
                    onClick={() => void save(true)}
                  >
                    {t('Confirm shorter retention')}
                  </button>
                  <button
                    type="button"
                    className={s.secondary}
                    disabled={busy}
                    onClick={() => setImpact(undefined)}
                  >
                    {t('Cancel change')}
                  </button>
                </div>
              </div>
            )}
            {!impact && (
              <button className={s.secondary} disabled={busy}>
                {busy ? <Spinner /> : <Clock size={16} />}
                {t('Save retention')}
              </button>
            )}
          </>
        ) : (
          !error && <Spinner />
        )}
        {error && (
          <p role="alert" className={s.error}>
            {t(error)}
          </p>
        )}
        {saved && (
          <p role="status" className={s.small}>
            {t('Document retention updated.')}
          </p>
        )}
      </form>
    </section>
  );
}
