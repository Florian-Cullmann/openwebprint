import { useEffect, useRef, useId, type ReactNode } from 'react';
import { X, LoaderCircle, Printer, ScanLine } from 'lucide-react';
import type { Device, JobStatus } from '@openwebprint/shared';
import s from './App.module.css';
export function Spinner() {
  return <LoaderCircle className={s.spinner} size={18} aria-label="Wird geladen" />;
}
export function DeviceIcon({ kind, large = false }: { kind: Device['kind']; large?: boolean }) {
  const Icon = kind === 'printer' ? Printer : ScanLine;
  return (
    <span className={`${s.deviceIcon} ${large ? s.deviceIconLarge : ''}`}>
      <Icon size={large ? 56 : 24} strokeWidth={1.5} />
    </span>
  );
}
export function Modal({
  title,
  subtitle,
  close,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.documentElement.style.overflow = previous;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`${s.dialog} ${wide ? s.wide : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className={s.modalHeader}>
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className={s.iconButton} aria-label="Schließen" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export const jobLabels: Record<JobStatus, string> = {
  queued: 'In Warteschlange',
  processing: 'In Bearbeitung',
  completed: 'Abgeschlossen',
  canceled: 'Abgebrochen',
  failed: 'Fehlgeschlagen',
  unknown: 'Status ungeklärt',
};
export function JobBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={`${s.badge} ${status === 'completed' ? s.positive : status === 'failed' || status === 'unknown' ? s.red : status === 'processing' || status === 'queued' ? s.amber : ''}`}
    >
      <span className={s.dot} />
      {jobLabels[status]}
    </span>
  );
}
export function DeviceBadge({ device }: { device: Device }) {
  return (
    <span
      className={`${s.badge} ${device.status === 'ready' ? s.positive : device.status === 'offline' ? s.red : device.status === 'busy' ? s.amber : ''}`}
      title={device.detail}
    >
      <span className={s.dot} />
      {
        {
          ready: 'Bereit',
          busy: 'Beschäftigt',
          offline: 'Angehalten / offline',
          unknown: 'Ungeprüft',
        }[device.status]
      }
    </span>
  );
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <span className={s.emptyIcon}>{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
