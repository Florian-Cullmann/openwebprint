import { t, plural } from './i18n';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  JOB_STATUSES,
  type HistoryDevice,
  type JobStatus,
  type Job,
  type JobFilter,
  type JobPage,
} from '@openwebprint/shared';
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react';
import { api } from './api';
import { Spinner, jobLabels } from './ui';
import s from './App.module.css';

export function JobHistory({
  kind,
  filter = 'all',
  revision,
  leadingControls,
  viewControls,
  children,
}: {
  kind?: Job['kind'];
  filter?: JobFilter;
  revision: number;
  leadingControls?: ReactNode;
  viewControls?: ReactNode;
  children: (jobs: Job[]) => ReactNode;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const [page, setPage] = useState<JobPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [devices, setDevices] = useState<HistoryDevice[]>([]);
  const [deviceError, setDeviceError] = useState('');
  const controlsId = useId();
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filtered = !!(deviceId || status || fromDate || toDate);
  // Calendar days in the browser's time zone, with an exclusive next-day bound (also over DST).
  function dayBoundary(value: string, nextDay = false) {
    if (!value) return '';
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setFullYear(year, month - 1, day + (nextDay ? 1 : 0));
    date.setHours(0, 0, 0, 0);
    return year > 0 && year < 9999 && Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }
  const from = dayBoundary(fromDate);
  const until = dayBoundary(toDate, true);
  const invalidDates = !!(
    (fromDate && !from) ||
    (toDate && !until) ||
    (fromDate && toDate && fromDate > toDate)
  );
  useEffect(() => {
    if (!filtersOpen) return;
    const controller = new AbortController();
    setDeviceError('');
    api<HistoryDevice[]>(`/jobs/devices${kind ? `?kind=${kind}` : ''}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDevices(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setDeviceError((e as Error).message);
      });
    return () => controller.abort();
  }, [kind, revision, retry, filtersOpen]);
  const searchInput = useRef<HTMLInputElement>(null);
  const queryText = search.trim();
  const pageSize = kind === 'scan' ? 30 : 50;
  useEffect(() => {
    if (invalidDates) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const query = new URLSearchParams({ limit: String(pageSize), filter });
      if (kind) query.set('kind', kind);
      if (cursor) query.set('cursor', cursor);
      if (queryText) query.set('search', queryText);
      for (const [key, value] of Object.entries({ deviceId, status, from, until }))
        if (value) query.set(key, value);
      try {
        const result = await api<JobPage>(`/jobs?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setPage(result);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    const debounce = setTimeout(() => void load(), queryText ? 250 : 0);
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      controller.abort();
      clearTimeout(debounce);
      clearInterval(timer);
    };
  }, [
    cursor,
    kind,
    filter,
    revision,
    retry,
    pageSize,
    queryText,
    deviceId,
    status,
    from,
    until,
    invalidDates,
  ]);
  useEffect(() => {
    // Deleting the final record on an older page returns to the preceding page.
    if (cursor && page && !page.jobs.length) {
      setPage(undefined);
      setLoading(true);
      setCursors((values) => values.slice(0, -1));
    }
  }, [cursor, page]);
  function move(next: (string | undefined)[]) {
    setPage(undefined);
    setError('');
    setLoading(true);
    setCursors(next);
  }
  return (
    <>
      <div className={s.historyToolbar}>
        {leadingControls && <div className={s.historyLeadingControls}>{leadingControls}</div>}
        <label className={s.srOnly} htmlFor={`${controlsId}-search`}>
          {kind === 'scan' ? t('Search scans') : t('Search jobs')}
        </label>
        <div className={s.historySearchControls}>
          <div className={s.search}>
            <Search size={17} aria-hidden="true" />
            <input
              id={`${controlsId}-search`}
              ref={searchInput}
              type="search"
              placeholder={kind === 'scan' ? t('Search scan titles…') : t('Search job titles…')}
              maxLength={200}
              value={search}
              onChange={(event) => {
                const value = event.target.value;
                setSearch(value);
                if (value.trim() !== queryText) move([undefined]);
              }}
            />
            {search && (
              <button
                className={s.historyClearSearch}
                aria-label={t('Clear search')}
                title={t('Clear search')}
                onClick={() => {
                  setSearch('');
                  if (queryText) move([undefined]);
                  searchInput.current?.focus();
                }}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <button
          className={s.secondary}
          aria-expanded={filtersOpen}
          aria-controls={`${controlsId}-filters`}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          {filtered ? t('Filter history (active)') : t('Filter history')}
        </button>
        {viewControls}
      </div>
      <div id={`${controlsId}-filters`} className={s.historyFilters} hidden={!filtersOpen}>
        <div className={s.historyFilterFields}>
          <label>
            {t('Device')}
            <select
              value={deviceId}
              onChange={(event) => {
                setDeviceId(event.target.value);
                move([undefined]);
              }}
            >
              <option value="">{t('All devices')}</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Status')}
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as JobStatus | '');
                move([undefined]);
              }}
            >
              <option value="">{t('All statuses')}</option>
              {JOB_STATUSES.filter((value) =>
                filter === 'completed'
                  ? value === 'completed'
                  : filter === 'active'
                    ? !['completed', 'canceled', 'failed'].includes(value)
                    : true,
              ).map((value) => (
                <option key={value} value={value}>
                  {t(jobLabels[value])}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Created from')}
            <input
              type="date"
              min="0001-01-01"
              max="9998-12-31"
              value={fromDate}
              aria-invalid={invalidDates || undefined}
              onChange={(event) => {
                setFromDate(event.target.value);
                move([undefined]);
              }}
            />
          </label>
          <label>
            {t('Created through')}
            <input
              type="date"
              min="0001-01-01"
              max="9998-12-31"
              value={toDate}
              aria-invalid={invalidDates || undefined}
              onChange={(event) => {
                setToDate(event.target.value);
                move([undefined]);
              }}
            />
          </label>
        </div>
        <div className={s.historyFilterFooter}>
          <p className={s.small}>{t('Dates include the whole day in your browser’s time zone.')}</p>
          {filtered && (
            <button
              className={s.secondary}
              onClick={() => {
                setDeviceId('');
                setStatus('');
                setFromDate('');
                setToDate('');
                move([undefined]);
              }}
            >
              {t('Clear filters')}
            </button>
          )}
        </div>
        {deviceError && (
          <p role="alert" className={s.error}>
            {t(deviceError)}{' '}
            <button className={s.textButton} onClick={() => setRetry((value) => value + 1)}>
              {t('Retry')}
            </button>
          </p>
        )}
      </div>
      {invalidDates && (
        <p role="alert" className={s.error}>
          {t('Choose an end date on or after the start date.')}
        </p>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {t(error)}{' '}
          <button className={s.textButton} onClick={() => setRetry((value) => value + 1)}>
            {t('Retry')}
          </button>
        </p>
      )}
      {loading ? (
        <p role="status">
          <Spinner /> {queryText && kind === 'scan' ? t('Searching scans…') : t('Loading history…')}
        </p>
      ) : (
        page &&
        ((queryText || filtered) && !page.jobs.length ? (
          <p role="status">
            {filtered || kind !== 'scan'
              ? t('No jobs match your search and filters. Change or clear them to try again.')
              : t('No scans match your search. Try another title or clear the search.')}
          </p>
        ) : (
          children(page.jobs)
        ))
      )}
      <nav
        className={s.pagination}
        aria-label={kind === 'scan' ? t('Scan history pages') : t('Job history pages')}
      >
        <div role="status" aria-atomic="true" className={s.paginationSummary}>
          {page && (
            <span>
              {t('{value1}–{value2} of {value3} {value4}', {
                value1: page.jobs.length ? page.offset + 1 : 0,
                value2: page.jobs.length ? page.offset + page.jobs.length : 0,
                value3: page.total,
                value4:
                  kind === 'scan'
                    ? plural('scan', 'scans', page.total)
                    : plural('job', 'jobs', page.total),
              })}
            </span>
          )}{' '}
          <span className={s.paginationPage}>
            {page
              ? t('Page {page} of {total}', {
                  page: Math.floor(page.offset / pageSize) + 1,
                  total: Math.max(1, Math.ceil(page.total / pageSize)),
                })
              : t('Page {page}', { page: cursors.length })}
          </span>
        </div>
        <div className={s.paginationControls}>
          <button
            className={s.secondary}
            disabled={loading || cursors.length === 1}
            onClick={() => move(cursors.slice(0, -1))}
          >
            <ChevronLeft size={16} />
            {t('Previous')}
          </button>
          <button
            className={s.secondary}
            disabled={loading || !page?.nextCursor}
            onClick={() => move([...cursors, page!.nextCursor])}
          >
            {t('Next')}
            <ChevronRight size={16} />
          </button>
        </div>
      </nav>
    </>
  );
}
