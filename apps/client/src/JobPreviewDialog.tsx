import { useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import type { Job } from '@openwebprint/shared';
import { documentData } from './api';
import { DocumentExpiry } from './DocumentExpiry';
import { DocumentPreview } from './DocumentPreview';
import { Modal, Spinner, JobBadge } from './ui';
import s from './App.module.css';
export function JobPreviewDialog({
  job,
  close,
  print,
}: {
  job: Job;
  close: () => void;
  print: (job: Job) => void;
}) {
  const [data, setData] = useState<Uint8Array>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!job.hasFile) return;
    const controller = new AbortController();
    void documentData(`/jobs/${job.id}/document`, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [job.id, job.hasFile]);
  return (
    <Modal title="Document preview" subtitle={job.title} close={close} wide>
      <div className={s.modalBody}>
        <div className={s.previewJobDetails}>
          <JobBadge status={job.status} />
          <span>{job.deviceName}</span>
        </div>
        <DocumentExpiry job={job} />
        {!job.hasFile ? (
          <p>
            Preview unavailable. The file has expired, was deleted, or belongs to an older print
            job.
          </p>
        ) : error ? (
          <p role="alert" className={s.error}>
            {error}
          </p>
        ) : data ? (
          <DocumentPreview
            data={data}
            monochrome={
              job.kind === 'print' && 'color' in job.options && job.options.color === 'monochrome'
            }
          />
        ) : (
          <Spinner />
        )}
        {job.hasFile && !error && (
          <div className={s.modalActions}>
            <button className={s.primary} disabled={!data} onClick={() => print(job)}>
              <Printer size={16} /> Print
            </button>
            <a className={s.secondary} href={`/api/jobs/${job.id}/pdf`} download>
              <Download size={16} /> Download PDF
            </a>
          </div>
        )}
      </div>
    </Modal>
  );
}
