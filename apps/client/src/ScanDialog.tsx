import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, ScanLine, FileCheck2 } from 'lucide-react';
import type { Device, Job, ScanOptions } from '@openwebprint/shared';
import { api, post } from './api';
import { Modal, Spinner } from './ui';
import s from './App.module.css';
export function ScanDialog({
  devices,
  initial,
  existing,
  close,
  changed,
  demo,
}: {
  devices: Device[];
  initial?: string;
  existing?: Job;
  close: () => void;
  changed: () => void;
  demo: boolean;
}) {
  const scanners = devices.filter((d) => d.kind === 'scanner');
  const [deviceId, setDeviceId] = useState(initial ?? scanners[0]?.id ?? '');
  const [resolution, setResolution] = useState<ScanOptions['resolution']>(300);
  const [color, setColor] = useState<ScanOptions['color']>('Color');
  const [job, setJob] = useState(existing);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const running = job && ['queued', 'processing'].includes(job.status);
  useEffect(() => {
    if (!running) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await api<{ jobs: Job[] }>('/snapshot');
        const updated = data.jobs.find((j) => j.id === job.id);
        if (alive && updated) {
          setJob(updated);
          if (['completed', 'failed'].includes(updated.status)) {
            changedRef.current();
            return;
          }
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      if (alive) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [running, job?.id]);
  async function start(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      setJob(await post<Job>('/scans', { deviceId, options: { resolution, color } }));
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const complete = job?.status === 'completed' && job.hasFile;
  return (
    <Modal
      title={complete ? 'Scan abgeschlossen' : 'Dokument scannen'}
      subtitle={
        demo
          ? 'Demo-Modus: Die Scanvorlage ist simuliert.'
          : 'Einzelseiten-Scan · die Quelle bestimmt der SANE-Standard.'
      }
      close={close}
      wide={!!complete}
    >
      {complete ? (
        <div className={s.scanResult}>
          <div className={s.scanPreview}>
            <img src={`/api/jobs/${job.id}/preview`} alt="Vorschau des gescannten Dokuments" />
          </div>
          <div className={s.scanResultInfo}>
            <span className={`${s.badge} ${s.positive}`}>
              <FileCheck2 size={14} /> Scan abgeschlossen
            </span>
            <h3>PDF bereit zum Download.</h3>
            <p>Lade den Scan als PDF herunter.</p>
            <a className={s.primary} href={`/api/jobs/${job.id}/pdf`} download>
              <Download size={17} /> PDF herunterladen
            </a>
            <p className={s.small}>
              Vorschau und PDF bleiben 7 Tage auf diesem Server gespeichert. Du kannst sie unter
              Scans jederzeit löschen.
            </p>
            <button
              className={s.secondary}
              onClick={() => {
                setJob(undefined);
                setError('');
              }}
            >
              Weitere Seite scannen
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={start} className={s.modalBody}>
          <div className={s.scanIntro}>
            {running ? <Spinner /> : <ScanLine size={48} strokeWidth={1} />}
            <h3>{running ? 'Dein Dokument wird gescannt …' : 'Eine Seite einlegen'}</h3>
            <p>
              {running
                ? 'Du kannst dieses Fenster schließen. Der Scan läuft weiter.'
                : 'Lege eine Seite auf das Vorlagenglas oder in die am Gerät voreingestellte Quelle.'}
            </p>
          </div>
          {!running && (
            <>
              <label>
                Scanner
                <select required value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  <option value="" disabled>
                    Scanner auswählen
                  </option>
                  {scanners.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className={s.formGrid}>
                <label>
                  Auflösung
                  <select
                    value={resolution}
                    onChange={(e) =>
                      setResolution(Number(e.target.value) as ScanOptions['resolution'])
                    }
                  >
                    <option value={150}>150 dpi · kompakt</option>
                    <option value={300}>300 dpi · empfohlen</option>
                    <option value={600}>600 dpi · detailreich</option>
                  </select>
                </label>
                <label>
                  Farbmodus
                  <select
                    value={color}
                    onChange={(e) => setColor(e.target.value as ScanOptions['color'])}
                  >
                    <option value="Color">Farbe</option>
                    <option value="Gray">Graustufen</option>
                  </select>
                </label>
              </div>
              <p className={s.small}>
                Verfügbare Auflösungen und Farbmodi sind geräteabhängig. Nicht unterstützte
                Einstellungen werden als Fehler gemeldet.
              </p>
            </>
          )}
          {(error || job?.error) && (
            <p role="alert" className={s.error}>
              {error || job?.error}
            </p>
          )}
          <div className={s.modalActions}>
            <button type="button" className={s.secondary} onClick={close}>
              {running ? 'Im Hintergrund fortsetzen' : 'Schließen'}
            </button>
            {!running && (
              <button className={s.primary} disabled={busy || !deviceId}>
                {busy ? <Spinner /> : <ScanLine size={17} />}{' '}
                {demo ? 'Demo-Scan starten' : 'Scan starten'}
              </button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
