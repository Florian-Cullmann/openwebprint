import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, ScanLine, FileCheck2 } from 'lucide-react';
import type { Device, Job, ScanOptions } from '@openwebprint/shared';
import { api, post } from './api';
import { Modal, Spinner } from './ui';
import { DeviceDialog } from './DeviceDialog';
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
  const [addingScanner, setAddingScanner] = useState(false);
  useEffect(() => {
    if (!deviceId && scanners.length) setDeviceId(scanners[0].id);
  }, [deviceId, scanners[0]?.id]);
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
  if (addingScanner)
    return (
      <DeviceDialog
        devices={devices}
        demo={demo}
        onlyKind="scanner"
        close={() => setAddingScanner(false)}
        changed={changed}
      />
    );
  return (
    <Modal
      title={complete ? 'Scan complete' : 'Scan document'}
      subtitle={
        demo
          ? 'Demo mode: the scan sample is simulated.'
          : 'Single-page scan · uses the default SANE source.'
      }
      close={close}
      wide={!!complete}
    >
      {complete ? (
        <div className={s.scanResult}>
          <div className={s.scanPreview}>
            <img src={`/api/jobs/${job.id}/preview`} alt="Scanned document preview" />
          </div>
          <div className={s.scanResultInfo}>
            <span className={`${s.badge} ${s.positive}`}>
              <FileCheck2 size={14} /> Scan complete
            </span>
            <h3>PDF ready to download.</h3>
            <p>Download your scan as a PDF.</p>
            <a className={s.primary} href={`/api/jobs/${job.id}/pdf`} download>
              <Download size={17} /> Download PDF
            </a>
            <p className={s.small}>
              The preview and PDF stay on this server for 7 days. You can delete them earlier on the
              Scans page.
            </p>
            <button
              className={s.secondary}
              onClick={() => {
                setJob(undefined);
                setError('');
              }}
            >
              Scan another page
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={start} className={s.modalBody}>
          <div className={s.scanIntro}>
            {running ? <Spinner /> : <ScanLine size={48} strokeWidth={1} />}
            <h3>{running ? 'Scanning your document…' : 'Load one page'}</h3>
            <p>
              {running
                ? 'You can close this window. The scan will continue in the background.'
                : 'Place one page on the flatbed or in the source selected by the device.'}
            </p>
          </div>
          {!running && !scanners.length && (
            <button type="button" className={s.secondary} onClick={() => setAddingScanner(true)}>
              Find and add a scanner
            </button>
          )}
          {!running && (
            <>
              <label>
                Scanner
                <select required value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  <option value="" disabled>
                    Select scanner
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
                  Resolution
                  <select
                    value={resolution}
                    onChange={(e) =>
                      setResolution(Number(e.target.value) as ScanOptions['resolution'])
                    }
                  >
                    <option value={150}>150 dpi · compact</option>
                    <option value={300}>300 dpi · recommended</option>
                    <option value={600}>600 dpi · detailed</option>
                  </select>
                </label>
                <label>
                  Color mode
                  <select
                    value={color}
                    onChange={(e) => setColor(e.target.value as ScanOptions['color'])}
                  >
                    <option value="Color">Color</option>
                    <option value="Gray">Grayscale</option>
                  </select>
                </label>
              </div>
              <p className={s.small}>
                Resolutions and color modes depend on the device. Unsupported settings produce an
                error.
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
              {running ? 'Continue in background' : 'Close'}
            </button>
            {!running && (
              <button className={s.primary} disabled={busy || !deviceId}>
                {busy ? <Spinner /> : <ScanLine size={17} />}{' '}
                {demo ? 'Start demo scan' : 'Start scan'}
              </button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
