import { useEffect, useRef, useState } from 'react';
import {
  Download,
  Printer,
  ScanLine,
  FileCheck2,
  RotateCw,
  ArrowLeft,
  ArrowRight,
  Crop,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  MAX_SCAN_PAGES,
  FALLBACK_SCAN_RESOLUTIONS,
  FALLBACK_SCAN_COLOR_MODES,
  scanSettingsError,
  supportsScanResolution,
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
  print,
}: {
  devices: Device[];
  initial?: string;
  existing?: Job;
  close: () => void;
  changed: () => void;
  demo: boolean;
  print: (job: Job) => void;
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
  const [loadedSettings, setLoadedSettings] = useState('');
  const [refreshSettings, setRefreshSettings] = useState(0);
  const refreshRequested = useRef(false);
  const [job, setJob] = useState(existing);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cropping, setCropping] = useState<string>();
  const cropButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnToPage = useRef<string | undefined>(undefined);
  const focusAfterRemoval = useRef<string | undefined>(undefined);
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
  const settingsKey = JSON.stringify([deviceId, source, refreshSettings]);
  const settingsLoading = loadingSources || loadedSettings !== settingsKey;
  const resolutions = sources.resolutions ?? FALLBACK_SCAN_RESOLUTIONS;
  const colorModes = sources.colorModes ?? FALLBACK_SCAN_COLOR_MODES;
  const invalidSettings = !!scanSettingsError(sources, { resolution, color });
  useEffect(() => {
    if (!locked && focusAfterRemoval.current) {
      cropButtons.current.get(focusAfterRemoval.current)?.focus();
      focusAfterRemoval.current = undefined;
    }
  }, [pages, locked]);
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
    setSourceError('');
    setLoadingSources(false);
    if (!deviceId || !scanners.some((d) => d.id === deviceId)) return;
    setLoadingSources(true);
    const query = new URLSearchParams();
    if (source) query.set('source', source);
    if (refreshRequested.current) query.set('refresh', 'true');
    refreshRequested.current = false;
    api<ScanSources>(`/devices/${deviceId}/scan-sources${query.size ? `?${query}` : ''}`)
      .then((data) => {
        if (alive) {
          setSources(data);
          setSourceError(data.warning ?? '');
          if (source && !data.sources.some((s) => s.name === source)) {
            setSource('');
            setDuplex(false);
          }
          const dpi = data.resolutions ?? FALLBACK_SCAN_RESOLUTIONS;
          setResolution((current) => {
            if (supportsScanResolution(dpi, current)) return current;
            if (
              data.defaultResolution !== undefined &&
              supportsScanResolution(dpi, data.defaultResolution)
            )
              return data.defaultResolution;
            if (supportsScanResolution(dpi, 300)) return 300;
            return Array.isArray(dpi) ? (dpi[0] ?? 300) : dpi.min;
          });
          const modes = data.colorModes ?? FALLBACK_SCAN_COLOR_MODES;
          setColor((current) =>
            modes.includes(current)
              ? current
              : data.defaultColorMode && modes.includes(data.defaultColorMode)
                ? data.defaultColorMode
                : modes.includes('Color')
                  ? 'Color'
                  : (modes[0] ?? 'Color'),
          );
        }
      })
      .catch((e) => {
        if (alive) {
          setSources({ sources: [], duplex: false });
          setResolution(300);
          setColor('Color');
          setSourceError((e as Error).message);
          setSource('');
        }
      })
      .finally(() => {
        if (alive) {
          setLoadingSources(false);
          setLoadedSettings(settingsKey);
        }
      });
    return () => {
      alive = false;
    };
  }, [deviceId, source, refreshSettings]);
  useEffect(() => {
    if (!running || !job) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updated = await api<Job>(`/jobs/${job.id}`);
        if (alive) {
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
    if (requestActive.current || running || settingsLoading || invalidSettings) return;
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
  async function edit(updated: ScanPage[], focusPage?: string) {
    if (!job || requestActive.current || running) return;
    requestActive.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await post<Job>(`/scans/${job.id}/pages`, {
        revision: job.scanRevision,
        pages: updated,
      });
      focusAfterRemoval.current = focusPage;
      setJob(saved);
      changed();
      return true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      requestActive.current = false;
    }
  }
  async function removePage(id: string) {
    if (pages.length <= 1) return;
    const index = pages.findIndex((page) => page.id === id);
    const updated = pages.filter((page) => page.id !== id);
    await edit(updated, updated[Math.min(index, updated.length - 1)].id);
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
                        <button
                          type="button"
                          className={s.iconButton}
                          disabled={locked || pages.length <= 1}
                          aria-label={`Remove page ${index + 1}`}
                          title={
                            pages.length <= 1
                              ? 'A scan must keep at least one page.'
                              : `Remove page ${index + 1}`
                          }
                          onClick={() => void removePage(page.id)}
                        >
                          <Trash2 size={16} />
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
              <>
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
                <button
                  type="button"
                  className={s.secondary}
                  disabled={locked || job?.status !== 'completed'}
                  onClick={() => print(job!)}
                >
                  <Printer size={17} /> Print
                </button>
                {pages.length === 1 && (
                  <p className={s.small}>
                    A scan must keep at least one page. To remove the document, close this preview
                    and delete the scan.
                  </p>
                )}
              </>
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
                  onChange={(e) => {
                    setDeviceId(e.target.value);
                    setSource('');
                    setSources({ sources: [], duplex: false });
                    setDuplex(false);
                  }}
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
                  {Array.isArray(resolutions) ? (
                    <select
                      value={resolution}
                      disabled={settingsLoading || !resolutions.length}
                      onChange={(e) => setResolution(Number(e.target.value))}
                    >
                      {!resolutions.length && (
                        <option value={resolution}>No supported resolutions</option>
                      )}
                      {resolutions.map((dpi) => (
                        <option key={dpi} value={dpi}>
                          {dpi} dpi
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      required
                      min={resolutions.min}
                      max={resolutions.max}
                      step={resolutions.step ?? 'any'}
                      value={Number.isFinite(resolution) ? resolution : ''}
                      disabled={settingsLoading}
                      onChange={(e) => setResolution(e.target.valueAsNumber)}
                    />
                  )}
                  {!Array.isArray(resolutions) && (
                    <span className={s.small}>
                      {resolutions.min}–{resolutions.max} dpi
                      {resolutions.step ? ` · steps of ${resolutions.step}` : ''}
                    </span>
                  )}
                </label>
                <label>
                  Color mode
                  <select
                    value={color}
                    disabled={settingsLoading || !colorModes.length}
                    onChange={(e) => setColor(e.target.value)}
                  >
                    {!colorModes.length && <option value={color}>No supported color modes</option>}
                    {colorModes.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode === 'Gray' ? 'Grayscale' : mode}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Paper source
                <select
                  value={source}
                  disabled={settingsLoading || !sources.sources.length}
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
            {deviceId && (
              <div className={s.scanCapabilityActions}>
                <p className={s.small}>Scanner settings are saved per paper source.</p>
                <button
                  type="button"
                  className={s.textButton}
                  disabled={locked || settingsLoading}
                  onClick={() => {
                    refreshRequested.current = true;
                    setRefreshSettings((value) => value + 1);
                  }}
                >
                  <RefreshCw size={14} /> Refresh scanner settings
                </button>
              </div>
            )}
            {settingsLoading && (
              <p role="status" className={s.small}>
                Loading scanner capabilities…
              </p>
            )}
            {!settingsLoading &&
              (sourceError ||
                sources.resolutions === undefined ||
                sources.colorModes === undefined) && (
                <p className={s.small}>
                  {sourceError} Some scanner capabilities are unknown. Unverified fallback options:
                  {sources.resolutions === undefined && ' 150/300/600 dpi.'}
                  {sources.colorModes === undefined && ' Color/Grayscale.'} The scanner may reject
                  them.
                </p>
              )}
            {!settingsLoading && invalidSettings && (
              <p role="alert" className={s.error}>
                Choose a supported resolution and color mode. This paper source may have no
                supported scan settings.
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
                disabled={
                  locked ||
                  settingsLoading ||
                  invalidSettings ||
                  !feeder ||
                  pages.length >= MAX_SCAN_PAGES
                }
                onClick={() => void start(true)}
              >
                Scan multiple pages
              </button>
              <button
                className={s.primary}
                disabled={
                  locked ||
                  settingsLoading ||
                  invalidSettings ||
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
