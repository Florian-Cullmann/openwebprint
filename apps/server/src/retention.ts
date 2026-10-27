import { DEFAULT_RETENTION, retentionSchema, type RetentionPolicy } from '@openwebprint/shared';
import type { Store, StoredJob } from './store.js';

export function retentionPolicy(store: Store): RetentionPolicy {
  const value = store.setting('retention');
  return value ? retentionSchema.parse(JSON.parse(value)) : { ...DEFAULT_RETENTION };
}

export function expiry(job: StoredJob, policy: RetentionPolicy): number {
  return (
    Date.parse(job.createdAt) +
    (job.kind === 'scan' ? policy.scanDays : policy.printDays) * 86400_000
  );
}

export function expired(job: StoredJob, policy: RetentionPolicy): boolean {
  return Date.now() >= expiry(job, policy);
}
