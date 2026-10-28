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
  AlertCircle,
} from 'lucide-react';
import {
  MAX_SCAN_PAGES,
  MAX_SCAN_PIXELS,
  scanPixelCount,
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
import { ColorModeControl, ResolutionControl } from './CapabilityControls';
import { DocumentExpiry } from './DocumentExpiry';
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
  const [canceling, setCanceling] = useState(false);
  const cancelRequest = useRef(false);
  const pollVersion = useRef(0);
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
  const recovery = job?.recovery;
  const locked = busy || running || !!recovery;
  const feeder = sources.sources.find((s) => s.name === source)?.feeder;
  const settingsKey = JSON.stringify([deviceId, source, refreshSettings]);
  const settingsLoading = !running && (loadingSources || loadedSettings !== settingsKey);
  const resolutions = sources.resolutions ?? FALLBACK_SCAN_RESOLUTIONS;
  const colorModes = sources.colorModes ?? FALLBACK_SCAN_COLOR_MODES;
  const settingsError = scanSettingsError(sources, { resolution, color });
  const invalidSettings = !!settingsError;
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
    if (running || !deviceId || !scanners.some((d) => d.id === deviceId)) return;
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
  }, [deviceId, source, refreshSettings, running]);
  useEffect(() => {
    if (!running || !job) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const version = pollVersion.current;
        const updated = await api<Job>(`/jobs/${job.id}`);
        if (alive && !cancelRequest.current && version === pollVersion.current) {
          setJob(updated);
          if (['completed', 'failed', 'canceled'].includes(updated.status)) {
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
    if (requestActive.current || running || recovery || settingsLoading || invalidSettings) return;
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
  async function cancel() {
    if (!job || cancelRequest.current) return;
    cancelRequest.current = true;
    pollVersion.current++;
    setCanceling(true);
    setError('');
    try {
      setJob(await post<Job>(`/jobs/${job.id}/cancel`));
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      cancelRequest.current = false;
      setCanceling(false);
    }
  }
  async function resolveRecovery(action: 'keep' | 'discard') {
    if (!job || !recovery || requestActive.current) return;
    requestActive.current = true;
    pollVersion.current++;
    setBusy(true);
    setError('');
    try {
      setJob(
        await post<Job>(`/scans/${job.id}/recovery`, {
          revision: recovery.revision,
          action,
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
    if (!job || requestActive.current || running || recovery) return;
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
      title={
        recovery ? 'Scan incomplete' : complete && !running ? 'Scan complete' : 'Scan document'
      }
      subtitle={demo ? 'Demo mode: the scan sample is simulated.' : 'Collect pages in one PDF.'}
      close={close}
      className={s.scanDialog}
      headerContent={
        running && (
          <p role="status" className={s.scanHeaderStatus}>
            <Spinner />
            <span>
              {canceling
                ? 'Canceling scan…'
                : recovery
                  ? 'Saving recovered pages…'
                  : complete
                    ? 'Adding pages…'
                    : 'Scanning your document…'}
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
                          src={`/api/scans/${job!.id}/pages/${page.id}?thumbnail=1&edit=${encodeURIComponent(JSON.stringify([page.rotation, page.crop]))}`}
                          alt={`Scanned page ${index + 1}`}
                          loading="lazy"
                          decoding="async"
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
                    <h3>{recovery ? 'Review recovered pages' : 'Load your document'}</h3>
                    <p>
                      {recovery
                        ? 'Review the batch page numbers and acquisition error, then keep or discard the complete pages.'
                        : 'Place a page on the flatbed, or load the document feeder.'}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <div className={s.scanControls}>
            {complete && (
              <>
                {!recovery && <DocumentExpiry job={job!} />}
                <div className={s.scanDocumentSummary}>
                  <span className={`${s.badge} ${s.positive}`}>
                    <FileCheck2 size={14} /> {pages.length} {pages.length === 1 ? 'page' : 'pages'}
                  </span>
                  <a
                    className={s.primary}
                    href={busy ? undefined : `/api/jobs/${job!.id}/pdf`}
                    aria-disabled={busy}
                    download
                  >
                    <Download size={17} /> Download PDF
                  </a>
                </div>
                {!recovery && (
                  <>
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
                        A scan must keep at least one page. To remove the document, close this
                        preview and delete the scan.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            {!scanners.length && !complete && !recovery && (
              <button type="button" className={s.secondary} onClick={() => setAddingScanner(true)}>
                Find and add a scanner
              </button>
            )}
            {!recovery && (
              <>
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
                  <ResolutionControl
                    resolutions={resolutions}
                    value={resolution}
                    onChange={setResolution}
                    disabled={settingsLoading}
                  />
                  <ColorModeControl
                    modes={colorModes.map((mode) => ({
                      value: mode,
                      label:
                        mode === 'Gray'
                          ? 'Grayscale'
                          : mode === 'Lineart'
                            ? 'Black and white (1-bit)'
                            : mode,
                    }))}
                    value={color}
                    onChange={setColor}
                    disabled={settingsLoading}
                  />
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
                {!running &&
                  !settingsLoading &&
                  (sourceError ||
                    sources.resolutions === undefined ||
                    sources.colorModes === undefined) && (
                    <p className={s.small}>
                      {sourceError} Some scanner capabilities are unknown. Unverified fallback
                      options:
                      {sources.resolutions === undefined && ' 150/300/600 dpi.'}
                      {sources.colorModes === undefined && ' Color/Grayscale.'} The scanner may
                      reject them.
                    </p>
                  )}
                {!running && !settingsLoading && (
                  <p className={s.small}>
                    {sources.acquisitionArea
                      ? `Scan area: ${Number(sources.acquisitionArea.widthMm.toFixed(1))} × ${Number(sources.acquisitionArea.heightMm.toFixed(1))} mm · ${Number((scanPixelCount(sources.acquisitionArea, resolution) / 1_000_000).toFixed(1))} megapixels at ${resolution} dpi.`
                      : 'Scan area is unknown. Large originals may need a lower resolution.'}{' '}
                    Limit: {MAX_SCAN_PIXELS / 1_000_000} megapixels per page before cropping.
                  </p>
                )}
                {!running && !settingsLoading && invalidSettings && (
                  <p role="alert" className={s.error}>
                    {settingsError}
                  </p>
                )}
              </>
            )}
            {!recovery && (error || job?.error) && (
              <p role="alert" className={s.error}>
                {error || job?.error}
              </p>
            )}
            {recovery && (
              <section className={s.scanRecovery} aria-label="Recover scanned pages">
                <div className={s.scanRecoveryHeading}>
                  <AlertCircle size={19} aria-hidden="true" />
                  <h3>{recovery.pageNumbers.length} pages ready to recover</h3>
                </div>
                <p role="alert">{error || job?.error || 'The scan could not finish.'}</p>
                <dl className={s.scanRecoveryFacts}>
                  <div>
                    <dt>Batch pages</dt>
                    <dd>{recovery.pageNumbers.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>Available until</dt>
                    <dd>
                      <time dateTime={recovery.expiresAt}>
                        {new Date(recovery.expiresAt).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                    </dd>
                  </div>
                </dl>
                <details className={s.scanRecoveryDetails}>
                  <summary>Recovery details</summary>
                  <p>
                    Only complete pages are included. Missing or incomplete pages were excluded.
                    Previously saved pages stay unchanged. You can close this scan and decide later,
                    even after a server restart.
                  </p>
                </details>
                <div className={s.scanRecoveryActions}>
                  <button type="button" className={s.textButton} onClick={close}>
                    Decide later
                  </button>
                  <button
                    type="button"
                    className={s.secondary}
                    disabled={busy || running}
                    aria-label="Discard recovered pages"
                    onClick={() => void resolveRecovery('discard')}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className={s.primary}
                    disabled={busy || running}
                    onClick={() => void resolveRecovery('keep')}
                  >
                    {busy && <Spinner />} Keep {recovery.pageNumbers.length} pages
                  </button>
                </div>
              </section>
            )}
            {running && (
              <p className={s.small}>
                {recovery
                  ? 'Saving recovered pages. Closing this dialog continues saving in the background.'
                  : 'Closing this dialog continues the scan in the background. Canceling discards all new pages from this operation and keeps previously saved pages.'}
              </p>
            )}
            {!recovery && (
              <div className={s.modalActions}>
                {running && !recovery && (
                  <button
                    type="button"
                    className={s.secondary}
                    disabled={canceling || busy}
                    onClick={() => void cancel()}
                  >
                    {canceling ? 'Canceling scan…' : 'Cancel scan'}
                  </button>
                )}
                {(!complete || running || recovery) && (
                  <button type="button" className={s.secondary} onClick={close}>
                    {running ? 'Continue in background' : 'Close'}
                  </button>
                )}
                {!running && (
                  <>
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
                  </>
                )}
              </div>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
