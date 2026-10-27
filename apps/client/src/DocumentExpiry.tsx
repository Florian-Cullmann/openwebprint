import type { Job } from '@openwebprint/shared';
import s from './App.module.css';

export function DocumentExpiry({ job }: { job: Job }) {
  if (!job.hasFile || !job.expiresAt) return null;
  return (
    <p className={s.small}>
      Retained until{' '}
      <time dateTime={job.expiresAt}>{new Date(job.expiresAt).toLocaleString()}</time>. Cleanup
      waits for active operations. Deleted files cannot be recovered by extending retention.
    </p>
  );
}
