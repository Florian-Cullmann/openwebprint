import { t, plural, getLocale, jobError, displayJobTitle } from './i18n';
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
  MAX_SCAN_TITLE_LENGTH,
  renameScanSchema,
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
import { ApiError, api, post } from './api';
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
  started,
  demo,
  print,
}: {
  devices: Device[];
  initial?: string;
  existing?: Job;
  close: () => void;
  changed: () => void;
  started: (job: Job) => void;
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [titleSaved, setTitleSaved] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const returnToRename = useRef(false);
  useEffect(() => {
    if (!editingTitle && returnToRename.current) {
      renameButton.current?.focus();
      returnToRename.current = false;
    }
  }, [editingTitle]);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
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
  const locked = busy || running || !!recovery || uncertain;
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
    const controller = new AbortController();
    setSourceError('');
    setLoadingSources(false);
    if (running || !deviceId || !scanners.some((d) => d.id === deviceId)) return;
    setLoadingSources(true);
    const query = new URLSearchParams();
    if (source) query.set('source', source);
    if (refreshRequested.current) query.set('refresh', 'true');
    refreshRequested.current = false;
    api<ScanSources>(`/devices/${deviceId}/scan-sources${query.size ? `?${query}` : ''}`, {
      signal: controller.signal,
    })
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
      controller.abort();
    };
  }, [deviceId, source, refreshSettings, running]);
  useEffect(() => {
    setPollError('');
    if (!running || !job) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const version = pollVersion.current;
        const updated = await api<Job>(`/jobs/${job.id}`, { signal: controller.signal });
        if (alive && !cancelRequest.current && version === pollVersion.current) {
          setPollError('');
          setJob(updated);
          if (['completed', 'failed', 'canceled'].includes(updated.status)) {
            changedRef.current();
            return;
          }
        }
      } catch (e) {
        if (alive) setPollError((e as Error).message);
      }
      if (alive) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [running, job?.id]);
  async function start(batch: boolean) {
    if (requestActive.current || locked || settingsLoading || invalidSettings) return;
    requestActive.current = true;
    setError('');
    setBusy(true);
    try {
      const next = await post<Job>('/scans', {
        deviceId,
        jobId: complete ? job!.id : undefined,
        options: {
          resolution,
          color,
          source: source || undefined,
          batch,
          duplex: feeder && duplex,
        },
      });
      setJob(next);
      started(next);
      changed();
    } catch (e) {
      const unknown = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
      setUncertain(unknown);
      setError(
        unknown
          ? 'The scan submission could not be confirmed. Scanning may already have started. Close this dialog and check Jobs and the scanner before scanning again; another submission could scan or append pages twice.'
          : (e as Error).message,
      );
      if (unknown) changed();
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
  async function saveTitle() {
    if (!job || requestActive.current || locked) return;
    const input = renameScanSchema.safeParse({ title: draftTitle, previousTitle: job.title });
    if (!input.success) {
      setError('Enter a title of 1–120 characters without control characters.');
      return;
    }
    requestActive.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await api<Job>(`/scans/${job.id}/title`, {
        method: 'PATCH',
        body: JSON.stringify(input.data),
      });
      setJob(saved);
      returnToRename.current = true;
      setEditingTitle(false);
      setTitleSaved(true);
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      requestActive.current = false;
    }
  }
  async function edit(updated: ScanPage[], focusPage?: string) {
    if (!job || requestActive.current || locked) return;
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
        uncertain
          ? t('Submission unconfirmed')
          : recovery
            ? t('Scan incomplete')
            : complete && !running
              ? t('Scan complete')
              : t('Scan document')
      }
      subtitle={
        demo ? t('Demo mode: the scan sample is simulated.') : t('Collect pages in one PDF.')
      }
      close={close}
      className={s.scanDialog}
      headerContent={
        running && (
          <p role="status" className={s.scanHeaderStatus}>
            <Spinner />
            <span>
              {canceling
                ? t('Canceling scan…')
                : recovery
                  ? t('Saving recovered pages…')
                  : complete
                    ? t('Adding pages…')
                    : t('Scanning your document…')}
            </span>
          </p>
        )
      }
    >
      {pollError && (
        <p role="alert" className={s.error}>
          {t(pollError)}
        </p>
      )}
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
              {t(error)}
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
                  aria-label={t('Scanned pages')}
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
                          alt={t('Scanned page {value1}', { value1: index + 1 })}
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                        />
                      </div>
                      <div className={s.scanPageTools}>
                        <span>{t('Page {value1}', { value1: index + 1 })}</span>
                        <button
                          type="button"
                          className={s.iconButton}
                          disabled={locked}
                          aria-label={t('Crop page {value1}', { value1: index + 1 })}
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
                          aria-label={t('Rotate page {value1} clockwise', { value1: index + 1 })}
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
                          aria-label={t('Move page {value1} earlier', { value1: index + 1 })}
                          onClick={() => move(page.id, index - 1)}
                        >
                          <ArrowLeft size={16} />
                        </button>
                        <button
                          type="button"
                          className={s.iconButton}
                          disabled={locked || index === pages.length - 1}
                          aria-label={t('Move page {value1} later', { value1: index + 1 })}
                          onClick={() => move(page.id, index + 1)}
                        >
                          <ArrowRight size={16} />
                        </button>
                        <button
                          type="button"
                          className={s.iconButton}
                          disabled={locked || pages.length <= 1}
                          aria-label={t('Remove page {value1}', { value1: index + 1 })}
                          title={
                            pages.length <= 1
                              ? t('A scan must keep at least one page.')
                              : t('Remove page {value1}', { value1: index + 1 })
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
                    <h3>{recovery ? t('Review recovered pages') : t('Load your document')}</h3>
                    <p>
                      {recovery
                        ? t(
                            'Review the batch page numbers and acquisition error, then keep or discard the complete pages.',
                          )
                        : t('Place a page on the flatbed, or load the document feeder.')}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <div className={s.scanControls}>
            {job && (
              <div className={s.scanTitle}>
                {editingTitle ? (
                  <>
                    <label>
                      {t('Scan title')}
                      <input
                        autoFocus
                        value={draftTitle}
                        maxLength={MAX_SCAN_TITLE_LENGTH}
                        disabled={locked}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void saveTitle();
                          }
                        }}
                      />
                    </label>
                    <div className={s.scanTitleActions}>
                      <button
                        type="button"
                        className={s.secondary}
                        disabled={locked || !draftTitle.trim()}
                        onClick={() => void saveTitle()}
                      >
                        {t('Save title')}
                      </button>
                      <button
                        type="button"
                        className={s.textButton}
                        disabled={locked}
                        onClick={() => {
                          returnToRename.current = true;
                          setEditingTitle(false);
                        }}
                      >
                        {t('Cancel rename')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3>{displayJobTitle(job)}</h3>
                    <button
                      type="button"
                      className={s.textButton}
                      disabled={locked}
                      ref={renameButton}
                      onClick={() => {
                        setDraftTitle(job.title);
                        setTitleSaved(false);
                        setEditingTitle(true);
                      }}
                    >
                      {t('Rename scan')}
                    </button>
                  </>
                )}
                {titleSaved && (
                  <p role="status" className={s.small}>
                    {t('Title saved.')}
                  </p>
                )}
              </div>
            )}

            {complete && (
              <>
                {!recovery && <DocumentExpiry job={job!} />}
                <div className={s.scanDocumentSummary}>
                  <span className={`${s.badge} ${s.positive}`}>
                    <FileCheck2 size={14} /> {plural('{count} page', '{count} pages', pages.length)}
                  </span>
                  <a
                    className={s.primary}
                    href={busy ? undefined : `/api/jobs/${job!.id}/pdf`}
                    aria-disabled={busy}
                    download
                  >
                    <Download size={17} />
                    {t('Download PDF')}
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
                      <Printer size={17} />
                      {t('Print')}
                    </button>
                    {pages.length === 1 && (
                      <p className={s.small}>
                        {t(
                          'A scan must keep at least one page. To remove the document, close this preview and delete the scan.',
                        )}
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            {!scanners.length && !complete && !recovery && (
              <button type="button" className={s.secondary} onClick={() => setAddingScanner(true)}>
                {t('Find and add a scanner')}
              </button>
            )}
            {!recovery && (
              <>
                <fieldset disabled={locked} className={s.scanSettings}>
                  <label>
                    {t('Scanner')}
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
                        {t('Select scanner')}
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
                          ? t('Grayscale')
                          : mode === 'Lineart'
                            ? t('Black and white (1-bit)')
                            : mode,
                    }))}
                    value={color}
                    onChange={setColor}
                    disabled={settingsLoading}
                  />
                  <label>
                    {t('Paper source')}
                    <select
                      value={source}
                      disabled={settingsLoading || !sources.sources.length}
                      onChange={(e) => {
                        setSource(e.target.value);
                        setDuplex(false);
                      }}
                    >
                      <option value="">{t('Device default')}</option>
                      {sources.sources.map((s) => (
                        <option key={t(s.name)} value={t(s.name)}>
                          {t(s.name)}
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
                      />
                      {t('Scan both sides')}
                    </label>
                  )}
                </fieldset>
                {deviceId && (
                  <div className={s.scanCapabilityActions}>
                    <p className={s.small}>{t('Scanner settings are saved per paper source.')}</p>
                    <button
                      type="button"
                      className={s.textButton}
                      disabled={locked || settingsLoading}
                      onClick={() => {
                        refreshRequested.current = true;
                        setRefreshSettings((value) => value + 1);
                      }}
                    >
                      <RefreshCw size={14} />
                      {t('Refresh scanner settings')}
                    </button>
                  </div>
                )}
                {settingsLoading && (
                  <p role="status" className={s.small}>
                    {t('Loading scanner capabilities…')}
                  </p>
                )}
                {!running &&
                  !settingsLoading &&
                  (sourceError ||
                    sources.resolutions === undefined ||
                    sources.colorModes === undefined) && (
                    <p className={s.small}>
                      {t(
                        '{value1} Some scanner capabilities are unknown. Unverified fallback options:{value2}{value3} The scanner may reject them.',
                        {
                          value1: sourceError ? t(sourceError) : '',
                          value2: sources.resolutions === undefined && ' 150/300/600 dpi.',
                          value3: sources.colorModes === undefined && t(' Color/Grayscale.'),
                        },
                      )}
                    </p>
                  )}
                {!running && !settingsLoading && (
                  <p className={s.small}>
                    {sources.acquisitionArea
                      ? t(
                          'Scan area: {width} × {height} mm · {megapixels} megapixels at {resolution} dpi.',
                          {
                            width: Number(sources.acquisitionArea.widthMm.toFixed(1)),
                            height: Number(sources.acquisitionArea.heightMm.toFixed(1)),
                            megapixels: Number(
                              (
                                scanPixelCount(sources.acquisitionArea, resolution) / 1_000_000
                              ).toFixed(1),
                            ),
                            resolution,
                          },
                        )
                      : t(
                          'Scan area is unknown. Large originals may need a lower resolution.',
                        )}{' '}
                    {t('Limit: {megapixels} megapixels per page before cropping.', {
                      megapixels: MAX_SCAN_PIXELS / 1_000_000,
                    })}
                  </p>
                )}
                {!running && !settingsLoading && invalidSettings && (
                  <p role="alert" className={s.error}>
                    {t(settingsError!)}
                  </p>
                )}
              </>
            )}
            {!recovery && (error || job?.error) && (
              <p role="alert" className={s.error}>
                {error ? t(error) : job?.error ? jobError(job) : null}
              </p>
            )}
            {recovery && (
              <section className={s.scanRecovery} aria-label={t('Recover scanned pages')}>
                <div className={s.scanRecoveryHeading}>
                  <AlertCircle size={19} aria-hidden="true" />
                  <h3>
                    {plural(
                      '{count} page ready to recover',
                      '{count} pages ready to recover',
                      recovery.pageNumbers.length,
                    )}
                  </h3>
                </div>
                <p role="alert">
                  {error ? t(error) : job?.error ? jobError(job) : t('The scan could not finish.')}
                </p>
                <dl className={s.scanRecoveryFacts}>
                  <div>
                    <dt>{t('Batch pages')}</dt>
                    <dd>{recovery.pageNumbers.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>{t('Available until')}</dt>
                    <dd>
                      <time dateTime={recovery.expiresAt}>
                        {new Date(recovery.expiresAt).toLocaleString(getLocale(), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                    </dd>
                  </div>
                </dl>
                <details className={s.scanRecoveryDetails}>
                  <summary>{t('Recovery details')}</summary>
                  <p>
                    {t(
                      'Only complete pages are included. Missing or incomplete pages were excluded. Previously saved pages stay unchanged. You can close this scan and decide later, even after a server restart.',
                    )}
                  </p>
                </details>
                <div className={s.scanRecoveryActions}>
                  <button type="button" className={s.textButton} onClick={close}>
                    {t('Decide later')}
                  </button>
                  <button
                    type="button"
                    className={s.secondary}
                    disabled={busy || running}
                    aria-label={t('Discard recovered pages')}
                    onClick={() => void resolveRecovery('discard')}
                  >
                    {t('Discard')}
                  </button>
                  <button
                    type="button"
                    className={s.primary}
                    disabled={busy || running}
                    onClick={() => void resolveRecovery('keep')}
                  >
                    {busy && <Spinner />}
                    {plural('Keep {count} page', 'Keep {count} pages', recovery.pageNumbers.length)}
                  </button>
                </div>
              </section>
            )}
            {running && (
              <p className={s.small}>
                {recovery
                  ? t(
                      'Saving recovered pages. Closing this dialog continues saving in the background.',
                    )
                  : t(
                      'Closing this dialog continues the scan in the background. Canceling discards all new pages from this operation and keeps previously saved pages.',
                    )}
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
                    {canceling ? t('Canceling scan…') : t('Cancel scan')}
                  </button>
                )}
                {(!complete || running || recovery) && (
                  <button type="button" className={s.secondary} onClick={close}>
                    {running ? t('Continue in background') : t('Close')}
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
                      {t('Scan multiple pages')}
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
                      {complete
                        ? t('Scan another page')
                        : demo
                          ? t('Start demo scan')
                          : t('Start scan')}
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
