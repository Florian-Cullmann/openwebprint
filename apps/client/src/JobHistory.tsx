import { useEffect, useState, type ReactNode } from 'react';
import type { Job, JobFilter, JobPage } from '@openwebprint/shared';
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
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const query = new URLSearchParams({ limit: '50', filter });
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
  }, [cursor, kind, filter, revision, retry]);
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
        <button
          className={s.secondary}
          disabled={loading || cursors.length === 1}
          onClick={() => move(cursors.slice(0, -1))}
        >
          Previous
        </button>
        <span role="status">
          Page {cursors.length}
          {page ? ` · ${page.jobs.length} ${kind === 'scan' ? 'scans' : 'jobs'}` : ''}
        </span>
        <button
          className={s.secondary}
          disabled={loading || !page?.nextCursor}
          onClick={() => move([...cursors, page!.nextCursor])}
        >
          Next
        </button>
      </nav>
    </>
  );
}
