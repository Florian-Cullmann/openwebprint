import { useEffect, useRef, useState } from 'react';
import {
  Download,
  ScanLine,
  FileCheck2,
  RotateCw,
  ArrowLeft,
  ArrowRight,
  Crop,
} from 'lucide-react';
import {
  MAX_SCAN_PAGES,
  type Device,
  type Job,
  type ScanOptions,
  type ScanPage,
  type ScanSources,
} from '@openwebprint/shared';
import { api, post } from './api';
import { Modal, Spinner } from './ui';
import { DeviceDialog } from './DeviceDialog';
import { useScanPageDrag } from './useScanPageDrag';
import { ScanCropEditor } from './ScanCropEditor';
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
  const [sources, setSources] = useState<ScanSources>({ sources: [], duplex: false });
  const [source, setSource] = useState('');
  const [duplex, setDuplex] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [loadingSources, setLoadingSources] = useState(false);
  const [job, setJob] = useState(existing);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cropping, setCropping] = useState<string>();
  const cropButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnToPage = useRef<string | undefined>(undefined);
  const requestActive = useRef(false);
  const [addingScanner, setAddingScanner] = useState(false);
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const running = !!job && ['queued', 'processing'].includes(job.status);
  const complete = !!job?.hasFile;
  const pages = job?.pages ?? [];
  const cropIndex = pages.findIndex((page) => page.id === cropping);
  const locked = busy || running;
  const feeder = sources.sources.find((s) => s.name === source)?.feeder;
  useEffect(() => {
    if (!cropping && returnToPage.current) {
      cropButtons.current.get(returnToPage.current)?.focus();
      returnToPage.current = undefined;
    }
  }, [cropping]);
  useEffect(() => {
    if (!deviceId && scanners.length) setDeviceId(scanners[0].id);
  }, [deviceId, scanners[0]?.id]);
  useEffect(() => {
    let alive = true;
    setSources({ sources: [], duplex: false });
    setSource('');
    setDuplex(false);
    setSourceError('');
    setLoadingSources(false);
    if (!deviceId || !scanners.some((d) => d.id === deviceId)) return;
    setLoadingSources(true);
    api<ScanSources>(`/devices/${deviceId}/scan-sources`)
      .then((data) => {
        if (alive) {
          setSources(data);
          setSource(data.sources[0]?.name ?? '');
        }
      })
      .catch((e) => {
        if (alive) setSourceError((e as Error).message);
      })
      .finally(() => {
        if (alive) setLoadingSources(false);
      });
    return () => {
      alive = false;
    };
  }, [deviceId]);
  useEffect(() => {
    if (!running || !job) return;
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
  async function start(batch: boolean) {
    if (requestActive.current || running) return;
    requestActive.current = true;
    setError('');
    setBusy(true);
    try {
      setJob(
        await post<Job>('/scans', {
          deviceId,
          jobId: complete ? job!.id : undefined,
          options: {
            resolution,
            color,
            source: source || undefined,
            batch,
            duplex: feeder && duplex,
          },
        }),
      );
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      requestActive.current = false;
    }
  }
  async function edit(updated: ScanPage[]) {
    if (!job || requestActive.current || running) return;
    requestActive.current = true;
    setBusy(true);
    setError('');
    try {
      setJob(
        await post<Job>(`/scans/${job.id}/pages`, { revision: job.scanRevision, pages: updated }),
      );
      changed();
      return true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      requestActive.current = false;
    }
  }
  function move(id: string, to: number) {
    const from = pages.findIndex((page) => page.id === id);
    if (from < 0 || from === to || to < 0 || to >= pages.length) return;
    const updated = [...pages];
    const [page] = updated.splice(from, 1);
    updated.splice(to, 0, page);
    return edit(updated).then(() => {});
  }
  const drag = useScanPageDrag(pages, locked, move);
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
      title={complete && !running ? 'Scan complete' : 'Scan document'}
      subtitle={demo ? 'Demo mode: the scan sample is simulated.' : 'Collect pages in one PDF.'}
      close={close}
      className={s.scanDialog}
      headerContent={
        running && (
          <p role="status" className={s.scanHeaderStatus}>
            <Spinner />
            <span>
              {complete ? 'Adding pages…' : 'Scanning your document…'} You can continue in the
              background.
            </span>
          </p>
        )
      }
    >
      {cropIndex >= 0 ? (
        <>
          <ScanCropEditor
            key={cropping}
            page={pages[cropIndex]}
            number={cropIndex + 1}
            url={`/api/scans/${job!.id}/pages/${cropping}`}
            busy={locked}
            cancel={() => setCropping(undefined)}
            apply={async (crop) => {
              const saved = await edit(
                pages.map((page) => (page.id === cropping ? { ...page, crop } : page)),
              );
              if (saved) setCropping(undefined);
            }}
          />
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start(false);
          }}
          className={`${s.modalBody} ${s.scanLayout}`}
        >
          <div className={s.scanPreviewPane}>
            {complete ? (
              <>
                <ol
                  className={s.scanPages}
                  aria-label="Scanned pages"
                  aria-busy={locked}
                  data-dragging={!!drag.preview}
                  {...drag.events}
                >
                  {pages.map((page, index) => (
                    <li
                      key={page.id}
                      data-page-id={page.id}
                      draggable={false}
                      className={drag.preview?.id === page.id ? s.scanPageDragging : undefined}
                      style={drag.style(page.id)}
                      onPointerDown={(e) => drag.start(e, index)}
                    >
                      <div className={s.scanPageImage}>
                        <img
                          src={`/api/scans/${job!.id}/pages/${page.id}?rendered=1&revision=${job!.scanRevision}`}
                          alt={`Scanned page ${index + 1}`}
                          draggable={false}
                        />
                      </div>
                      <div className={s.scanPageTools}>
                        <span>Page {index + 1}</span>
                        <button
                          type="button"
                          className={s.iconButton}
                          disabled={locked}
                          aria-label={`Crop page ${index + 1}`}
                          ref={(button) => {
                            if (button) cropButtons.current.set(page.id, button);
                            else cropButtons.current.delete(page.id);
                          }}
                          onClick={() => {
                            setError('');
                            returnToPage.current = page.id;
                            setCropping(page.id);
                          }}
                        >
                          <Crop size={16} />
                        </button>
                        <button
                          type="button"
                          className={s.iconButton}
                          disabled={locked}
                          aria-label={`Rotate page ${index + 1} clockwise`}
                          onClick={() =>
                            void edit(
                              pages.map((p) =>
                                p.id === page.id
                                  ? {
                                      ...p,
                                      rotation: ((p.rotation + 90) % 360) as ScanPage['rotation'],
                                    }
                                  : p,
                              ),
                            )
                          }
                        >
                          <RotateCw size={16} />
                        </button>
                        <button
                          type="button"
                          className={s.iconButton}
                          disabled={locked || index === 0}
                          aria-label={`Move page ${index + 1} earlier`}
                          onClick={() => move(page.id, index - 1)}
                        >
                          <ArrowLeft size={16} />
                        </button>
                        <button
                          type="button"
                          className={s.iconButton}
                          disabled={locked || index === pages.length - 1}
                          aria-label={`Move page ${index + 1} later`}
                          onClick={() => move(page.id, index + 1)}
                        >
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    </li>
                  ))}
                  {drag.insertionStyle && (
                    <li
                      className={s.scanInsertionLine}
                      aria-hidden="true"
                      data-insertion-index={drag.preview!.to}
                      style={drag.insertionStyle}
                    />
                  )}
                </ol>
              </>
            ) : (
              <div className={s.scanIntro}>
                <ScanLine size={48} strokeWidth={1} />
                {!running && (
                  <>
                    <h3>Load your document</h3>
                    <p>Place a page on the flatbed, or load the document feeder.</p>
                  </>
                )}
              </div>
            )}
          </div>
          <div className={s.scanControls}>
            {complete && (
              <div className={s.scanDocumentSummary}>
                <span className={`${s.badge} ${s.positive}`}>
                  <FileCheck2 size={14} /> {pages.length} {pages.length === 1 ? 'page' : 'pages'}
                </span>
                <a
                  className={s.primary}
                  href={locked ? undefined : `/api/jobs/${job!.id}/pdf`}
                  aria-disabled={locked}
                  download
                >
                  <Download size={17} /> Download PDF
                </a>
              </div>
            )}
            {!scanners.length && !complete && (
              <button type="button" className={s.secondary} onClick={() => setAddingScanner(true)}>
                Find and add a scanner
              </button>
            )}
            <fieldset disabled={locked} className={s.scanSettings}>
              <label>
                Scanner
                <select
                  required
                  value={deviceId}
                  disabled={complete}
                  onChange={(e) => setDeviceId(e.target.value)}
                >
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
              <label>
                Paper source
                <select
                  value={source}
                  disabled={loadingSources || !sources.sources.length}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setDuplex(false);
                  }}
                >
                  <option value="">Device default</option>
                  {sources.sources.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {feeder && sources.duplex && (
                <label className={s.scanDuplex}>
                  <input
                    type="checkbox"
                    checked={duplex}
                    onChange={(e) => setDuplex(e.target.checked)}
                  />{' '}
                  Scan both sides
                </label>
              )}
            </fieldset>
            {sourceError && (
              <p className={s.small}>
                Could not load paper sources: {sourceError} You can still scan one page with the
                device default.
              </p>
            )}
            {(error || job?.error) && (
              <p role="alert" className={s.error}>
                {error || job?.error}
              </p>
            )}
            <div className={s.modalActions}>
              {(!complete || running) && (
                <button type="button" className={s.secondary} onClick={close}>
                  {running ? 'Continue in background' : 'Close'}
                </button>
              )}
              <button
                type="button"
                className={s.secondary}
                disabled={locked || loadingSources || !feeder || pages.length >= MAX_SCAN_PAGES}
                onClick={() => void start(true)}
              >
                Scan multiple pages
              </button>
              <button
                className={s.primary}
                disabled={
                  locked ||
                  loadingSources ||
                  !scanners.some((d) => d.id === deviceId) ||
                  pages.length >= MAX_SCAN_PAGES
                }
              >
                {busy ? <Spinner /> : <ScanLine size={17} />}{' '}
                {complete ? 'Scan another page' : demo ? 'Start demo scan' : 'Start scan'}
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
