import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileText, Printer, UploadCloud, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Device, Job, PrintOptions } from '@openwebprint/shared';
import { api, documentData } from './api';
import { DocumentPreview } from './DocumentPreview';
import { Modal, Spinner } from './ui';
import s from './App.module.css';
export const mediaLabels: Record<PrintOptions['media'], string> = {
  iso_a4_210x297mm: 'A4 · 210 × 297 mm',
  'na_letter_8.5x11in': 'Letter · 8.5 × 11 in',
  iso_a5_148x210mm: 'A5 · 148 × 210 mm',
};
const sidesLabels: Record<PrintOptions['sides'], string> = {
  'one-sided': 'Single-sided',
  'two-sided-long-edge': 'Duplex · long edge',
  'two-sided-short-edge': 'Duplex · short edge',
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
  const [preview, setPreview] = useState<Uint8Array>();
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<Job>();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const device = printers.find((d) => d.id === deviceId);
  const supportedSides = device?.capabilities?.sides;
  const [options, setOptions] = useState<PrintOptions>({
    copies: 1,
    color: 'monochrome',
    sides: 'one-sided',
    media: 'iso_a4_210x297mm',
  });
  const validSides = !!supportedSides?.includes(options.sides);
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    setPreview(undefined);
    setPreviewing(true);
    const form = new FormData();
    form.set('file', file);
    void documentData('/documents/preview', {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
      .then(setPreview)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewing(false);
      });
    return () => controller.abort();
  }, [file]);
  useEffect(() => {
    setOptions((o) => ({
      ...o,
      color: 'monochrome',
      media: device?.capabilities?.media[0] ?? 'iso_a4_210x297mm',
    }));
  }, [deviceId, device?.capabilities?.media.join(',')]);
  useEffect(() => {
    setOptions((o) => ({
      ...o,
      sides: supportedSides?.includes(o.sides) ? o.sides : (supportedSides?.[0] ?? 'one-sided'),
    }));
  }, [deviceId, supportedSides?.join(',')]);
  function choose(file?: File) {
    setError('');
    if (
      file &&
      (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type) ||
        file.size > 25 * 1024 * 1024 ||
        !file.size)
    ) {
      setError('Choose a PDF, PNG or JPEG file up to 25 MB.');
      return;
    }
    setFile(file);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !device || !preview || previewing || !validSides) return;
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
            ? 'Submission unconfirmed'
            : 'Job submitted'
          : 'Print document'
      }
      subtitle={
        demo ? 'Demo mode: nothing will be physically printed.' : 'PDF, PNG or JPEG · up to 25 MB'
      }
      close={() => {
        if (!busy) close();
      }}
      wide={!!file && !sent}
    >
      {sent ? (
        <div className={`${s.successState} ${sent.status === 'unknown' ? s.uncertainState : ''}`}>
          {sent.status === 'unknown' ? <AlertTriangle size={44} /> : <CheckCircle2 size={44} />}
          <h3>
            {sent.status === 'unknown'
              ? 'Please check the submission'
              : demo
                ? 'Demo job submitted.'
                : 'Your job has been sent to CUPS.'}
          </h3>
          <p>{sent.error ?? 'Track its status on the Jobs page.'}</p>
          <button className={s.primary} onClick={close}>
            Done
          </button>
        </div>
      ) : (
        <form className={s.modalBody} onSubmit={submit}>
          <div className={file ? s.printLayout : undefined}>
            {file && (
              <div>
                {preview ? (
                  <DocumentPreview data={preview} monochrome={options.color === 'monochrome'} />
                ) : (
                  <div className={s.previewPlaceholder}>
                    {previewing ? (
                      <>
                        <Spinner />
                        <p>Preparing preview…</p>
                      </>
                    ) : (
                      <p>Preview unavailable. Choose a valid document.</p>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className={s.printOptions}>
              <div
                className={`${s.dropzone} ${file ? s.compactDropzone : ''} ${dragging ? s.dragging : ''}`}
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
                <h3>{file ? file.name : 'Choose a file to print'}</h3>
                <p>
                  {file
                    ? `${file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(2)} MB`} · ${previewing ? 'preparing preview' : preview ? 'ready to print' : 'preview unavailable'}`
                    : 'Drop a file here or select one from your device.'}
                </p>
                <button
                  type="button"
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  {file ? 'Choose another file' : 'Choose file'}
                </button>
                <input
                  ref={input}
                  type="file"
                  aria-label="Select document"
                  accept="application/pdf,image/png,image/jpeg"
                  className={s.srOnly}
                  onChange={(e) => choose(e.target.files?.[0])}
                />
              </div>
              <label>
                Printer
                <select
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  required
                  disabled={busy}
                >
                  <option value="" disabled>
                    Select printer
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
                  Color mode
                  <select
                    value={options.color}
                    disabled={busy}
                    onChange={(e) =>
                      setOptions({ ...options, color: e.target.value as PrintOptions['color'] })
                    }
                  >
                    <option value="monochrome">Black and white</option>
                    {device?.capabilities?.color && <option value="color">Color</option>}
                  </select>
                </label>
                <label>
                  Sides
                  <select
                    value={validSides ? options.sides : ''}
                    disabled={busy || !supportedSides?.length}
                    onChange={(e) =>
                      setOptions({ ...options, sides: e.target.value as PrintOptions['sides'] })
                    }
                  >
                    {!supportedSides?.length && (
                      <option value="">
                        {supportedSides ? 'No supported sides' : 'Sides unavailable'}
                      </option>
                    )}
                    {supportedSides?.map((side) => (
                      <option value={side} key={side}>
                        {sidesLabels[side]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Paper size
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
                  Copies
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
                <p className={s.error}>Add a printer on the Devices page first.</p>
              )}
              {device && !device.capabilities && (
                <p className={s.error}>Print options are unavailable. Check the CUPS connection.</p>
              )}
              {device?.capabilities && !supportedSides && (
                <p className={s.error}>Print sides are unavailable. Check the CUPS connection.</p>
              )}
              {supportedSides?.length === 0 && (
                <p className={s.error}>This printer reports no supported print sides.</p>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <div className={s.modalActions}>
            <button type="button" className={s.secondary} disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              className={s.primary}
              disabled={
                busy ||
                !file ||
                !preview ||
                previewing ||
                !validSides ||
                !device?.capabilities?.media.length
              }
            >
              {busy ? <Spinner /> : <Printer size={17} />}{' '}
              {busy ? 'Submitting…' : demo ? 'Start demo print' : 'Print now'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
