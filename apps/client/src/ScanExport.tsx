import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, X } from 'lucide-react';
import {
  MAX_SCAN_EXPORT_DOCUMENTS,
  MAX_SCAN_EXPORT_BYTES,
  type Job,
  type ScanExportSelection,
} from '@openwebprint/shared';
import { ApiError, downloadBlob } from './api';
import { Spinner } from './ui';
import s from './App.module.css';
import styles from './ScanExport.module.css';

type Selected = ScanExportSelection & { title: string; createdAt: string };
export function ScanExport({
  children,
}: {
  children: (selection: (job: Job) => ReactNode) => ReactNode;
}) {
  const [selected, setSelected] = useState<Selected[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const checkboxes = useRef(new Map<string, HTMLInputElement>());
  const downloadUrl = useRef<string | undefined>(undefined);
  const revokeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      controller.current?.abort();
      clearTimeout(revokeTimer.current);
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    },
    [],
  );
  function focusCheckbox(id?: string) {
    const input = id ? checkboxes.current.get(id) : undefined;
    const target =
      input && !input.disabled
        ? input
        : [...checkboxes.current.values()].find((input) => !input.disabled);
    target?.focus();
  }
  function remove(id: string) {
    if (selected.length === 1) focusCheckbox(id);
    setSelected((current) => current.filter((scan) => scan.id !== id));
    setError('');
    setMessage('');
  }
  function select(job: Job) {
    const checked = selected.some((scan) => scan.id === job.id);
    const available =
      job.hasFile &&
      job.status === 'completed' &&
      (!job.expiresAt || Date.parse(job.expiresAt) > Date.now());
    return (
      <label className={styles.select}>
        <input
          type="checkbox"
          ref={(input) => {
            if (input) checkboxes.current.set(job.id, input);
            else checkboxes.current.delete(job.id);
          }}
          checked={checked}
          aria-label={`Select scan: ${job.title}`}
          disabled={
            busy || (!checked && (!available || selected.length >= MAX_SCAN_EXPORT_DOCUMENTS))
          }
          onChange={() => {
            if (checked) remove(job.id);
            else {
              setSelected((current) =>
                current.length >= MAX_SCAN_EXPORT_DOCUMENTS ||
                current.some((scan) => scan.id === job.id)
                  ? current
                  : [
                      ...current,
                      {
                        id: job.id,
                        title: job.title,
                        createdAt: job.createdAt,
                        revision: job.scanRevision ?? job.updatedAt,
                      },
                    ],
              );
              setError('');
              setMessage('');
            }
          }}
        />
      </label>
    );
  }
  async function download() {
    if (controller.current) return;
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const blob = await downloadBlob('/scans/export', {
        method: 'POST',
        body: JSON.stringify({ scans: selected.map(({ id, revision }) => ({ id, revision })) }),
        signal: pending.signal,
      });
      if (pending.signal.aborted) return;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      clearTimeout(revokeTimer.current);
      const url = URL.createObjectURL(blob);
      downloadUrl.current = url;
      const link = document.createElement('a');
      link.href = url;
      link.download = 'openwebprint-scans.zip';
      document.body.append(link);
      link.click();
      link.remove();
      revokeTimer.current = setTimeout(() => {
        URL.revokeObjectURL(url);
        if (downloadUrl.current === url) downloadUrl.current = undefined;
      }, 60_000);
      setMessage('ZIP ready. Your download has started.');
    } catch (e) {
      if (pending.signal.aborted) setMessage('ZIP export canceled. Your selection is kept.');
      else
        setError(
          e instanceof ApiError
            ? e.message
            : 'ZIP download was interrupted. A selected scan may have expired or the connection was lost. Refresh the selection and try again.',
        );
    } finally {
      if (controller.current === pending) {
        controller.current = undefined;
        setBusy(false);
      }
    }
  }
  return (
    <>
      {selected.length > 0 && (
        <section className={styles.export} aria-label="Export selected scans">
          <div className={styles.actions}>
            <p role="status">{selected.length} selected</p>
            <button
              className={s.primary}
              disabled={!selected.length || busy}
              onClick={() => void download()}
            >
              {busy ? <Spinner /> : <Archive size={16} />}{' '}
              {busy ? 'Preparing ZIP…' : 'Download ZIP'}
            </button>
            {busy ? (
              <button className={s.secondary} onClick={() => controller.current?.abort()}>
                Cancel export
              </button>
            ) : (
              <button
                className={s.secondary}
                disabled={!selected.length}
                onClick={() => {
                  focusCheckbox();
                  setSelected([]);
                  setError('');
                  setMessage('');
                }}
              >
                Clear selection
              </button>
            )}
          </div>
          <p className={s.small}>
            Select up to {MAX_SCAN_EXPORT_DOCUMENTS} saved PDFs, totaling at most{' '}
            {MAX_SCAN_EXPORT_BYTES / (1024 * 1024)} MiB. Selection stays across pages and views
            until you leave Scans. Only checked scans are included. Exports expire after two
            minutes; use smaller batches on slow connections.
          </p>
          {selected.length > 0 && (
            <details className={styles.selection}>
              <summary>Review selected scans ({selected.length})</summary>
              <ul>
                {selected.map((scan) => (
                  <li key={scan.id}>
                    <span>
                      {scan.title}
                      <small>
                        {new Date(scan.createdAt).toLocaleString()} · {scan.id.slice(-8)}
                      </small>
                    </span>
                    <button
                      className={s.iconButton}
                      disabled={busy}
                      aria-label={`Remove selection: ${scan.title}`}
                      onClick={() => remove(scan.id)}
                    >
                      <X size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {busy && (
            <p className={s.small}>Preparing the selected PDFs. You can cancel this export.</p>
          )}
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          {message && (
            <p role="status" className={s.small}>
              {message}
            </p>
          )}
        </section>
      )}
      {children(select)}
    </>
  );
}
