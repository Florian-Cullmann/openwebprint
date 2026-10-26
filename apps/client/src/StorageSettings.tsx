import { useEffect, useState, type FormEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import { api } from './api';
import { Spinner } from './ui';
import s from './App.module.css';
export function StorageSettings({ demo }: { demo: boolean }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api<{ path: string }>('/storage')
      .then((result) => setPath(result.path))
      .catch((e) => setError(e.message));
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await api<{ scanRoot: string }>('/storage', {
        method: 'PUT',
        body: JSON.stringify({ path }),
      });
      setPath(result.scanRoot);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={s.settingsCard}>
      <div className={s.settingsTitle}>
        <FolderOpen size={20} />
        <h2>Scan storage</h2>
      </div>
      <p>
        {demo
          ? 'This folder is used for hardware scans. Demo scans stay in application storage and are removed with the demo data.'
          : 'New scans are saved here. Changing the folder does not move existing scans.'}
      </p>
      <form onSubmit={submit} className={`${s.form} ${s.userForm}`}>
        <label>
          Scan storage folder
          <input
            value={path}
            required
            maxLength={1024}
            disabled={busy}
            onChange={(e) => {
              setPath(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <p className={s.small}>
          Use an absolute, writable server path. In Docker, this must be a mounted folder.
        </p>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className={s.small}>
            Scan storage updated.
          </p>
        )}
        <button className={s.secondary} disabled={busy || !path}>
          {busy ? <Spinner /> : <FolderOpen size={16} />} Save folder
        </button>
      </form>
    </section>
  );
}
