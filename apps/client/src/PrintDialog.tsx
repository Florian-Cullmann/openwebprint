import { t, displayJobTitle, jobError, plural, formatBytes } from './i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileText, Printer, UploadCloud, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Device, Job, PrintOptions } from '@openwebprint/shared';
import { resolvePrintPages, formatPrintPages } from '@openwebprint/shared';
import { api, post, documentData, ApiError } from './api';
import { printProfileError } from '@openwebprint/shared';
import { ProfileSettings } from './ProfileSettings';
import { DocumentPreview } from './DocumentPreview';
import { ColorModeControl } from './CapabilityControls';
import { Modal, Spinner } from './ui';
import s from './App.module.css';
export const mediaLabels: Record<PrintOptions['media'], string> = {
  iso_a4_210x297mm: 'A4 · 210 × 297 mm',
  'na_letter_8.5x11in': 'Letter · 8.5 × 11 in',
  iso_a5_148x210mm: 'A5 · 148 × 210 mm',
};
const colorLabels: Record<PrintOptions['color'], string> = {
  monochrome: 'Black and white',
  color: 'Color',
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
  started,
  demo,
  source,
}: {
  devices: Device[];
  initial?: string;
  close: () => void;
  changed: () => void;
  started: (job: Job) => void;
  demo: boolean;
  source?: Job;
}) {
  const printers = devices.filter((d) => d.kind === 'printer');
  const [deviceId, setDeviceId] = useState(initial ?? printers[0]?.id ?? '');
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<Uint8Array>();
  const [pageCount, setPageCount] = useState<number>();
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const profileDevice = useRef<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<Job>();
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const device = printers.find((d) => d.id === deviceId);
  const supportedColorModes = device?.capabilities?.colorModes;
  const supportedSides = device?.capabilities?.sides;
  const [options, setOptions] = useState<PrintOptions>({
    copies: 1,
    color: 'monochrome',
    sides: 'one-sided',
    media: 'iso_a4_210x297mm',
  });
  const validColor = !!supportedColorModes?.includes(options.color);
  const validSides = !!supportedSides?.includes(options.sides);
  const hasDocument = !!source || !!file;
  let selectedPages: number[] = [];
  let selectionError = '';
  if (pageCount) {
    try {
      selectedPages = resolvePrintPages(pageCount, options);
    } catch (e) {
      selectionError = (e as Error).message;
    }
  }
  const profileError =
    profileDevice.current === deviceId
      ? printProfileError(device?.capabilities, options)
      : undefined;
  useEffect(() => {
    if (!file && !source) return;
    const controller = new AbortController();
    setPreview(undefined);
    setPageCount(undefined);
    setPreviewing(true);
    setError('');
    const form = new FormData();
    if (file) form.set('file', file);
    void documentData(
      source
        ? `/jobs/${source.id}/document${source.scanRevision ? `?revision=${encodeURIComponent(source.scanRevision)}` : ''}`
        : '/documents/preview',
      source
        ? { signal: controller.signal }
        : { method: 'POST', body: form, signal: controller.signal },
    )
      .then(setPreview)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewing(false);
      });
    return () => controller.abort();
  }, [file, source?.id, source?.scanRevision]);
  useEffect(() => {
    if (profileDevice.current === deviceId) return;
    setOptions((o) => ({
      ...o,
      media: device?.capabilities?.media[0] ?? 'iso_a4_210x297mm',
    }));
  }, [deviceId, device?.capabilities?.media.join(',')]);
  useEffect(() => {
    if (profileDevice.current === deviceId) return;
    setOptions((o) => ({
      ...o,
      color: supportedColorModes?.includes(o.color)
        ? o.color
        : (supportedColorModes?.[0] ?? 'monochrome'),
    }));
  }, [deviceId, supportedColorModes?.join(',')]);
  useEffect(() => {
    if (profileDevice.current === deviceId) return;
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
    setPreview(undefined);
    setPageCount(undefined);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      submitting.current ||
      profileBusy ||
      profileError ||
      uncertain ||
      !hasDocument ||
      !device ||
      !preview ||
      previewing ||
      !validColor ||
      !validSides ||
      !selectedPages.length ||
      device.status === 'offline'
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const data = new FormData();
    data.set('deviceId', device.id);
    data.set('options', JSON.stringify(options));
    if (file) data.set('file', file);
    try {
      const job = source
        ? await post<Job>(`/jobs/${source.id}/print`, {
            deviceId: device.id,
            options,
            revision: source.scanRevision,
          })
        : await api<Job>('/print', { method: 'POST', body: data });
      setSent(job);
      started(job);
      changed();
    } catch (e) {
      const unknown = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
      setUncertain(unknown);
      setError(
        unknown
          ? 'The submission could not be confirmed. Check Jobs and the printer before printing again; another submission could produce duplicate output.'
          : (e as Error).message,
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        sent
          ? sent.status === 'unknown'
            ? t('Submission unconfirmed')
            : t('Job submitted')
          : t('Print document')
      }
      subtitle={
        demo
          ? t('Demo mode: nothing will be physically printed.')
          : source
            ? t('Print a saved document')
            : t('PDF, PNG or JPEG · up to 25 MB')
      }
      close={() => {
        if (!busy && !profileBusy) close();
      }}
      wide={hasDocument && !sent}
    >
      {sent ? (
        <div className={`${s.successState} ${sent.status === 'unknown' ? s.uncertainState : ''}`}>
          {sent.status === 'unknown' ? <AlertTriangle size={44} /> : <CheckCircle2 size={44} />}
          <h3>
            {sent.status === 'unknown'
              ? t('Please check the submission')
              : demo
                ? t('Demo job submitted.')
                : t('Your job has been sent to CUPS.')}
          </h3>
          <p>{sent.error ? jobError(sent) : t('Track its status on the Jobs page.')}</p>
          <button className={s.primary} onClick={close}>
            {t('Done')}
          </button>
        </div>
      ) : (
        <form className={s.modalBody} onSubmit={submit}>
          {source?.kind === 'print' && source.status === 'unknown' && (
            <p role="alert" className={s.error}>
              {t(
                'The original print outcome is unknown. Check the printer and Jobs before continuing. Printing again creates a new job and may produce duplicate output.',
              )}
            </p>
          )}
          <div className={hasDocument ? s.printLayout : undefined}>
            {hasDocument && (
              <div>
                {preview ? (
                  <>
                    <DocumentPreview
                      data={preview}
                      monochrome={options.color === 'monochrome'}
                      onPageCount={setPageCount}
                    />
                    <p className={s.previewHint}>
                      {t('Preview shows the full document with original page numbers.')}
                    </p>
                  </>
                ) : (
                  <div className={s.previewPlaceholder}>
                    {previewing ? (
                      <>
                        <Spinner />
                        <p>{t('Preparing preview…')}</p>
                      </>
                    ) : (
                      <p>
                        {source
                          ? t(
                              'Saved document unavailable. Close this dialog and reopen the document, or create a new scan.',
                            )
                          : t('Preview unavailable. Choose a valid document.')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className={s.printOptions}>
              {source ? (
                <div className={`${s.dropzone} ${s.compactDropzone}`}>
                  <FileText size={32} />
                  <h3>{displayJobTitle(source)}</h3>
                  <p>{t('Saved document · a new print job will be created.')}</p>
                </div>
              ) : (
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
                  <h3>{file ? file.name : t('Choose a file to print')}</h3>
                  <p>
                    {file
                      ? `${formatBytes(file.size)} · ${previewing ? t('preparing preview') : preview ? t('ready to print') : t('preview unavailable')}`
                      : t('Drop a file here or select one from your device.')}
                  </p>
                  <button
                    type="button"
                    className={s.secondary}
                    disabled={busy || profileBusy}
                    onClick={() => input.current?.click()}
                  >
                    {file ? t('Choose another file') : t('Choose file')}
                  </button>
                  <input
                    ref={input}
                    type="file"
                    aria-label={t('Select document')}
                    accept="application/pdf,image/png,image/jpeg"
                    className={s.srOnly}
                    onChange={(e) => choose(e.target.files?.[0])}
                  />
                </div>
              )}
              <label>
                {t('Printer')}
                <select
                  value={deviceId}
                  onChange={(e) => {
                    profileDevice.current = undefined;
                    setDeviceId(e.target.value);
                  }}
                  required
                  disabled={busy || profileBusy}
                >
                  <option value="" disabled>
                    {t('Select printer')}
                  </option>
                  {printers.map((d) => (
                    <option value={d.id} key={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              {deviceId && (
                <ProfileSettings
                  key={deviceId}
                  deviceId={deviceId}
                  settings={{
                    kind: 'print',
                    options: {
                      copies: options.copies,
                      color: options.color,
                      sides: options.sides,
                      media: options.media,
                    },
                  }}
                  disabled={busy || profileBusy}
                  setBusy={setProfileBusy}
                  applied={({ profile }) => {
                    if (profile.kind !== 'print') return;
                    profileDevice.current = deviceId;
                    setOptions((current) => ({ ...current, ...profile.options }));
                  }}
                />
              )}
              {hasDocument && (
                <div className={s.pageSelection}>
                  <div className={s.formGrid}>
                    <label>
                      {t('Pages')}
                      <select
                        value={options.pageRanges === undefined ? 'all' : 'custom'}
                        disabled={busy || profileBusy}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            pageRanges: e.target.value === 'all' ? undefined : '',
                          })
                        }
                      >
                        <option value="all">{t('All pages')}</option>
                        <option value="custom">{t('Custom range')}</option>
                      </select>
                    </label>
                    <label>
                      {t('Page filter')}
                      <select
                        value={options.pageParity ?? 'all'}
                        disabled={busy || profileBusy}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            pageParity: e.target.value as PrintOptions['pageParity'],
                          })
                        }
                      >
                        <option value="all">{t('All pages')}</option>
                        <option value="odd">{t('Odd pages')}</option>
                        <option value="even">{t('Even pages')}</option>
                      </select>
                    </label>
                  </div>
                  {options.pageRanges !== undefined && (
                    <label>
                      {t('Page range')}
                      <input
                        value={options.pageRanges}
                        placeholder="1-3, 7"
                        maxLength={2000}
                        disabled={busy || profileBusy}
                        aria-invalid={!!selectionError}
                        aria-describedby={`print-page-help${selectionError ? ' print-page-error' : ''}`}
                        onChange={(e) => setOptions({ ...options, pageRanges: e.target.value })}
                      />
                    </label>
                  )}
                  <p id="print-page-help" className={s.previewHint}>
                    {t(
                      'Ranges use original page numbers. The filter applies within the range. Duplicates print once, in document order.',
                    )}
                  </p>
                  {selectionError && (
                    <p id="print-page-error" role="alert" className={s.error}>
                      {t(selectionError)}
                    </p>
                  )}
                  {!!selectedPages.length && (
                    <p role="status" className={s.pageSelectionSummary}>
                      {plural(
                        '{selected} of {count} page per copy · Pages {range} · {copies}',
                        '{selected} of {count} pages per copy · Pages {range} · {copies}',
                        pageCount ?? 0,
                        {
                          selected: selectedPages.length,
                          range: formatPrintPages(selectedPages),
                          copies: plural('{count} copy', '{count} copies', options.copies),
                        },
                      )}
                    </p>
                  )}
                  {options.sides !== 'one-sided' && (
                    <p className={s.previewHint}>
                      {t(
                        'Duplex pairs consecutive selected pages on the front and back of each sheet. Skipped pages leave no gaps; an unpaired final page has a blank back. Odd/even filtering does not perform manual duplex printing.',
                      )}
                    </p>
                  )}
                </div>
              )}
              <div className={s.formGrid}>
                <ColorModeControl
                  modes={(supportedColorModes ?? []).map((mode) => ({
                    value: mode,
                    label: colorLabels[mode],
                  }))}
                  emptyLabel={
                    supportedColorModes
                      ? t('No supported color modes')
                      : t('Color modes unavailable')
                  }
                  value={options.color}
                  disabled={busy || profileBusy || !supportedColorModes?.length}
                  onChange={(color) =>
                    setOptions({ ...options, color: color as PrintOptions['color'] })
                  }
                />
                <label>
                  {t('Sides')}
                  <select
                    value={validSides || profileError ? options.sides : ''}
                    disabled={busy || profileBusy || !supportedSides?.length}
                    onChange={(e) =>
                      setOptions({ ...options, sides: e.target.value as PrintOptions['sides'] })
                    }
                  >
                    {profileError && !validSides && (
                      <option value={options.sides}>
                        {t('{value} (unavailable)', { value: t(sidesLabels[options.sides]) })}
                      </option>
                    )}
                    {!supportedSides?.length && (
                      <option value="">
                        {supportedSides ? t('No supported sides') : t('Sides unavailable')}
                      </option>
                    )}
                    {supportedSides?.map((side) => (
                      <option value={side} key={side}>
                        {t(sidesLabels[side])}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('Paper size')}
                  <select
                    value={options.media}
                    disabled={busy || profileBusy}
                    onChange={(e) =>
                      setOptions({ ...options, media: e.target.value as PrintOptions['media'] })
                    }
                  >
                    {profileError && !device?.capabilities?.media.includes(options.media) && (
                      <option value={options.media}>
                        {t('{value} (unavailable)', { value: t(mediaLabels[options.media]) })}
                      </option>
                    )}
                    {(device?.capabilities?.media ?? []).map((m) => (
                      <option key={m} value={m}>
                        {t(mediaLabels[m])}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('Copies')}
                  <input
                    type="number"
                    min={1}
                    max={99}
                    required
                    value={options.copies}
                    disabled={busy || profileBusy}
                    onChange={(e) => setOptions({ ...options, copies: Number(e.target.value) })}
                  />
                </label>
              </div>
              {profileError && (
                <p role="alert" className={s.error}>
                  {t(profileError)}
                </p>
              )}
              {!printers.length && (
                <p className={s.error}>{t('Add a printer on the Devices page first.')}</p>
              )}
              {!!printers.length && !!deviceId && !device && (
                <p className={s.error}>
                  {t('This printer is no longer available. Select another printer.')}
                </p>
              )}
              {device?.status === 'offline' && (
                <p className={s.error}>
                  {t('This printer is offline. Check its connection or select another printer.')}
                </p>
              )}
              {device && !device.capabilities && (
                <p className={s.error}>
                  {t('Print options are unavailable. Check the CUPS connection.')}
                </p>
              )}
              {device?.capabilities && !supportedColorModes && (
                <p className={s.error}>
                  {t('Print color modes are unavailable. Check the CUPS connection.')}
                </p>
              )}
              {supportedColorModes?.length === 0 && (
                <p className={s.error}>
                  {t('This printer reports no supported print color modes.')}
                </p>
              )}
              {device?.capabilities && !supportedSides && (
                <p className={s.error}>
                  {t('Print sides are unavailable. Check the CUPS connection.')}
                </p>
              )}
              {supportedSides?.length === 0 && (
                <p className={s.error}>{t('This printer reports no supported print sides.')}</p>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className={s.error}>
              {t(error)}
            </p>
          )}
          <div className={s.modalActions}>
            <button
              type="button"
              className={s.secondary}
              disabled={busy || profileBusy}
              onClick={close}
            >
              {t('Cancel')}
            </button>
            <button
              className={s.primary}
              disabled={
                busy ||
                uncertain ||
                !hasDocument ||
                device?.status === 'offline' ||
                profileBusy ||
                !!profileError ||
                !preview ||
                previewing ||
                !validColor ||
                !validSides ||
                !selectedPages.length ||
                !device?.capabilities?.media.length
              }
            >
              {busy ? <Spinner /> : <Printer size={17} />}{' '}
              {busy ? t('Submitting…') : demo ? t('Start demo print') : t('Print now')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
