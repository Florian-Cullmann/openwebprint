import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Job, JobFilter, JobPage } from '@openwebprint/shared';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { api } from './api';
import { Spinner } from './ui';
import s from './App.module.css';

export function JobHistory({
  kind,
  filter = 'all',
  revision,
  viewControls,
  children,
}: {
  kind?: Job['kind'];
  filter?: JobFilter;
  revision: number;
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
  const searchInput = useRef<HTMLInputElement>(null);
  const queryText = search.trim();
  const pageSize = kind === 'scan' ? 30 : 50;
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const query = new URLSearchParams({ limit: String(pageSize), filter });
      if (kind) query.set('kind', kind);
      if (cursor) query.set('cursor', cursor);
      if (queryText) query.set('search', queryText);
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
  }, [cursor, kind, filter, revision, retry, pageSize, queryText]);
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
      {kind === 'scan' && (
        <div className={s.historyToolbar}>
          <label className={s.srOnly} htmlFor="scan-history-search">
            Search scans
          </label>
          <div className={s.historySearchControls}>
            <div className={s.search}>
              <Search size={17} aria-hidden="true" />
              <input
                id="scan-history-search"
                ref={searchInput}
                type="search"
                placeholder="Search scan titles…"
                maxLength={200}
                value={search}
                onChange={(event) => {
                  const value = event.target.value;
                  setSearch(value);
                  if (value.trim() !== queryText) move([undefined]);
                }}
              />
            </div>
            {search && (
              <button
                className={s.secondary}
                onClick={() => {
                  setSearch('');
                  if (queryText) move([undefined]);
                  searchInput.current?.focus();
                }}
              >
                Clear search
              </button>
            )}
          </div>
          {viewControls}
        </div>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}{' '}
          <button className={s.textButton} onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </p>
      )}
      {loading ? (
        <p role="status">
          <Spinner /> {queryText ? 'Searching scans…' : 'Loading history…'}
        </p>
      ) : (
        page &&
        (queryText && !page.jobs.length ? (
          <p role="status">No scans match your search. Try another title or clear the search.</p>
        ) : (
          children(page.jobs)
        ))
      )}
      <nav
        className={s.pagination}
        aria-label={kind === 'scan' ? 'Scan history pages' : 'Job history pages'}
      >
        <div role="status" aria-atomic="true" className={s.paginationSummary}>
          {page && (
            <span>
              {page.jobs.length ? page.offset + 1 : 0}–
              {page.jobs.length ? page.offset + page.jobs.length : 0} of {page.total}{' '}
              {kind === 'scan' ? 'scans' : 'jobs'}
            </span>
          )}{' '}
          <span className={s.paginationPage}>
            Page {page ? Math.floor(page.offset / pageSize) + 1 : cursors.length}
            {page ? ` of ${Math.max(1, Math.ceil(page.total / pageSize))}` : ''}
          </span>
        </div>
        <div className={s.paginationControls}>
          <button
            className={s.secondary}
            disabled={loading || cursors.length === 1}
            onClick={() => move(cursors.slice(0, -1))}
          >
            <ChevronLeft size={16} /> Previous
          </button>
          <button
            className={s.secondary}
            disabled={loading || !page?.nextCursor}
            onClick={() => move([...cursors, page!.nextCursor])}
          >
            Next <ChevronRight size={16} />
          </button>
        </div>
      </nav>
    </>
  );
}
