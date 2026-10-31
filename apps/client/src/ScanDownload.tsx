import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import type { Job } from '@openwebprint/shared';
import { t } from './i18n';
import s from './App.module.css';

export function ScanDownload({ job, disabled }: { job: Job; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [quality, setQuality] = useState('90');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const pages = job.pages ?? [];
  const pageId = pages.find((page) => page.id === selected)?.id ?? pages[0]?.id;
  const visible = open && !disabled;
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [visible]);
  return (
    <div
      className={s.scanDownload}
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && visible) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={button}
        className={s.primary}
        disabled={disabled}
        aria-expanded={visible}
        aria-controls={id}
        onClick={() => setOpen(!visible)}
      >
        <Download size={17} aria-hidden="true" /> {t('Download')}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id={id} hidden={!visible} className={s.scanDownloadOptions}>
        {pages.length > 1 && (
          <label>
            {t('Page for image download')}
            <select value={pageId} onChange={(event) => setSelected(event.target.value)}>
              {pages.map((page, index) => (
                <option key={page.id} value={page.id}>
                  {t('Page {number}', { number: index + 1 })}
                </option>
              ))}
            </select>
          </label>
        )}
        {pageId && (
          <>
            <a
              className={s.secondary}
              href={disabled ? undefined : `/api/scans/${job.id}/pages/${pageId}/export?format=png`}
              download
              aria-label={t('Download PNG')}
            >
              PNG
            </a>
            <a
              className={s.secondary}
              href={
                disabled
                  ? undefined
                  : `/api/scans/${job.id}/pages/${pageId}/export?format=jpeg&quality=${quality}`
              }
              download
              aria-label={t('Download JPEG')}
            >
              JPEG
            </a>
            <label>
              {t('JPEG quality')}
              <select value={quality} onChange={(event) => setQuality(event.target.value)}>
                <option value="90">{t('High (90%)')}</option>
                <option value="75">{t('Smaller file (75%)')}</option>
                <option value="100">{t('Maximum (100%)')}</option>
              </select>
            </label>
          </>
        )}
        <a
          className={s.secondary}
          href={disabled ? undefined : `/api/jobs/${job.id}/pdf`}
          download
          aria-label={t('Download PDF')}
        >
          PDF
        </a>
        <span className={s.small}>{t('All pages')}</span>
      </div>
    </div>
  );
}
