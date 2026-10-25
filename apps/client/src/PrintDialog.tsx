import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileText, Printer, UploadCloud, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Device, Job, PrintOptions } from '@openwebprint/shared';
import { api } from './api';
import { Modal, Spinner } from './ui';
import s from './App.module.css';
export const mediaLabels: Record<PrintOptions['media'], string> = {
  iso_a4_210x297mm: 'A4 · 210 × 297 mm',
  'na_letter_8.5x11in': 'Letter · 8,5 × 11 Zoll',
  iso_a5_148x210mm: 'A5 · 148 × 210 mm',
};
export function PrintDialog({
  devices,
  initial,
  close,
  changed,
  demo,
}: {
  devices: Device[];
  initial?: string;
  close: () => void;
  changed: () => void;
  demo: boolean;
}) {
  const printers = devices.filter((d) => d.kind === 'printer');
  const [deviceId, setDeviceId] = useState(initial ?? printers[0]?.id ?? '');
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<Job>();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const device = printers.find((d) => d.id === deviceId);
  const [options, setOptions] = useState<PrintOptions>({
    copies: 1,
    color: 'monochrome',
    sides: 'one-sided',
    media: 'iso_a4_210x297mm',
  });
  useEffect(() => {
    setOptions((o) => ({
      ...o,
      color: 'monochrome',
      sides: 'one-sided',
      media: device?.capabilities?.media[0] ?? 'iso_a4_210x297mm',
    }));
  }, [deviceId, device?.capabilities?.media.join(',')]);
  function choose(file?: File) {
    setError('');
    if (
      file &&
      (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type) ||
        file.size > 25 * 1024 * 1024 ||
        !file.size)
    ) {
      setError('Bitte eine PDF-, PNG- oder JPEG-Datei mit maximal 25 MB auswählen.');
      return;
    }
    setFile(file);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !device) return;
    setBusy(true);
    setError('');
    const data = new FormData();
    data.set('deviceId', device.id);
    data.set('options', JSON.stringify(options));
    data.set('file', file);
    try {
      const job = await api<Job>('/print', { method: 'POST', body: data });
      setSent(job);
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        sent
          ? sent.status === 'unknown'
            ? 'Übertragung ungeklärt'
            : 'Auftrag übertragen'
          : 'Was möchtest du drucken?'
      }
      subtitle={
        demo
          ? 'Demo-Modus: Es wird kein echtes Papier bedruckt.'
          : 'PDF, PNG oder JPEG · maximal 25 MB'
      }
      close={() => {
        if (!busy) close();
      }}
    >
      {sent ? (
        <div className={`${s.successState} ${sent.status === 'unknown' ? s.uncertainState : ''}`}>
          {sent.status === 'unknown' ? <AlertTriangle size={44} /> : <CheckCircle2 size={44} />}
          <h3>
            {sent.status === 'unknown'
              ? 'Übertragung bitte prüfen'
              : demo
                ? 'Dein Demo-Auftrag ist unterwegs.'
                : 'Dein Auftrag liegt bei CUPS.'}
          </h3>
          <p>{sent.error ?? 'Den aktuellen Status findest du unter Aufträge.'}</p>
          <button className={s.primary} onClick={close}>
            Zu meinem Workflow
          </button>
        </div>
      ) : (
        <form className={s.modalBody} onSubmit={submit}>
          <div
            className={`${s.dropzone} ${dragging ? s.dragging : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(e.dataTransfer.files[0]);
            }}
          >
            {file ? <FileText size={32} /> : <UploadCloud size={34} />}
            <h3>{file ? file.name : 'Dein Dokument kommt hierhin'}</h3>
            <p>
              {file
                ? `${(file.size / 1024 / 1024).toFixed(2)} MB · bereit für den nächsten Schritt`
                : 'Datei hierher ziehen oder auf deinem Gerät auswählen.'}
            </p>
            <button
              type="button"
              className={s.secondary}
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {file ? 'Andere Datei auswählen' : 'Datei auswählen'}
            </button>
            <input
              ref={input}
              type="file"
              aria-label="Dokument auswählen"
              accept="application/pdf,image/png,image/jpeg"
              className={s.srOnly}
              onChange={(e) => choose(e.target.files?.[0])}
            />
          </div>
          <label>
            Drucker
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              required
              disabled={busy}
            >
              <option value="" disabled>
                Drucker auswählen
              </option>
              {printers.map((d) => (
                <option value={d.id} key={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <div className={s.formGrid}>
            <label>
              Farbmodus
              <select
                value={options.color}
                disabled={busy}
                onChange={(e) =>
                  setOptions({ ...options, color: e.target.value as PrintOptions['color'] })
                }
              >
                <option value="monochrome">Schwarzweiß</option>
                {device?.capabilities?.color && <option value="color">Farbe</option>}
              </select>
            </label>
            <label>
              Seiten
              <select
                value={options.sides}
                disabled={busy}
                onChange={(e) =>
                  setOptions({ ...options, sides: e.target.value as PrintOptions['sides'] })
                }
              >
                <option value="one-sided">Einseitig</option>
                {device?.capabilities?.duplex && (
                  <>
                    <option value="two-sided-long-edge">Duplex · lange Kante</option>
                    <option value="two-sided-short-edge">Duplex · kurze Kante</option>
                  </>
                )}
              </select>
            </label>
            <label>
              Papierformat
              <select
                value={options.media}
                disabled={busy}
                onChange={(e) =>
                  setOptions({ ...options, media: e.target.value as PrintOptions['media'] })
                }
              >
                {(device?.capabilities?.media ?? []).map((m) => (
                  <option key={m} value={m}>
                    {mediaLabels[m]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kopien
              <input
                type="number"
                min={1}
                max={99}
                required
                value={options.copies}
                disabled={busy}
                onChange={(e) => setOptions({ ...options, copies: Number(e.target.value) })}
              />
            </label>
          </div>
          {!printers.length && (
            <p className={s.error}>Füge zuerst unter Geräte einen Drucker hinzu.</p>
          )}
          {device && !device.capabilities && (
            <p className={s.error}>
              Druckoptionen sind noch nicht verfügbar. CUPS-Verbindung prüfen.
            </p>
          )}
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <div className={s.modalActions}>
            <button type="button" className={s.secondary} disabled={busy} onClick={close}>
              Abbrechen
            </button>
            <button
              className={s.primary}
              disabled={busy || !file || !device?.capabilities?.media.length}
            >
              {busy ? <Spinner /> : <Printer size={17} />}{' '}
              {busy ? 'Wird übertragen …' : demo ? 'Demo-Druck starten' : 'Jetzt drucken'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
