import { useEffect, useState, type ReactNode } from 'react';
import type { Job, JobFilter, JobPage } from '@openwebprint/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from './api';
import { Spinner } from './ui';
import s from './App.module.css';

export function JobHistory({
  kind,
  filter = 'all',
  revision,
  children,
}: {
  kind?: Job['kind'];
  filter?: JobFilter;
  revision: number;
  children: (jobs: Job[]) => ReactNode;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const [page, setPage] = useState<JobPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
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
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [cursor, kind, filter, revision, retry, pageSize]);
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
          <Spinner /> Loading history…
        </p>
      ) : (
        page && children(page.jobs)
      )}
      <nav
        className={s.pagination}
        aria-label={kind === 'scan' ? 'Scan history pages' : 'Job history pages'}
      >
        <div role="status" className={s.paginationSummary}>
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
