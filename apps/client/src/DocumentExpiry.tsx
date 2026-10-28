import { t, formatDateTime } from './i18n';
import type { Job } from '@openwebprint/shared';
import s from './App.module.css';

export function DocumentExpiry({ job }: { job: Job }) {
  if (!job.hasFile || !job.expiresAt) return null;
  return (
    <p className={s.small}>
      {t('Retained until')} <time dateTime={job.expiresAt}>{formatDateTime(job.expiresAt)}</time>
      {t(
        '. Cleanup waits for active operations. Deleted files cannot be recovered by extending retention.',
      )}
    </p>
  );
}
