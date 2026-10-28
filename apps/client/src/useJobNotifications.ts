import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { Job } from '@openwebprint/shared';
import { api, ApiError } from './api';

type Availability = NotificationPermission | 'unsupported' | 'insecure' | 'unavailable';
const resetKey = 'owp-notifications-reset';
const terminal = new Set(['completed', 'failed', 'canceled', 'unknown']);
function availability(): Availability {
  if (!window.isSecureContext) return 'insecure';
  return 'Notification' in window ? Notification.permission : 'unsupported';
}
function readPreference(key: string) {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
export function jobNotificationText(job: Job) {
  const kind = job.kind === 'print' ? 'Print' : 'Scan';
  const prefix = job.mode === 'demo' ? 'Demo: ' : '';
  const outcome =
    job.status === 'unknown'
      ? `${kind} outcome unknown. Check Jobs${job.kind === 'print' ? ' and the printer' : ''}.`
      : job.status === 'completed'
        ? job.kind === 'print'
          ? 'Print provider reported completion. Physical output is not confirmed.'
          : 'Scan completed.'
        : `${kind} ${job.status}. Check Jobs for details.`;
  return prefix + outcome;
}

// Ownership stays in this mounted tab: no history adoption or cross-tab takeover.
// Reloading intentionally abandons tracking rather than replaying old outcomes.
export function useJobNotifications(scope: string | undefined, open: (id: string) => void) {
  const key = `owp-notifications:${scope ?? 'inactive'}`;
  const [enabled, setEnabled] = useState(() => readPreference(key));
  const [permission, setPermission] = useState<Availability>(availability);
  const [notices, setNotices] = useState<{ id: string; text: string }[]>([]);
  const state = useRef({
    scope,
    generation: 0,
    jobs: new Map<string, Job>(),
    notifications: new Map<string, Notification>(),
  });
  const openRef = useRef(open);
  openRef.current = open;
  function clear() {
    state.current.generation++;
    state.current.jobs.clear();
    for (const notification of state.current.notifications.values()) notification.close();
    state.current.notifications.clear();
    setNotices([]);
  }
  function reset() {
    clear();
    try {
      localStorage.setItem(resetKey, crypto.randomUUID());
    } catch {
      // This tab still resets when browser storage is unavailable.
    }
  }
  useEffect(() => {
    clear();
    state.current.scope = scope;
    setEnabled(readPreference(key));
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === resetKey || event.key === null) {
        clear();
        setEnabled(readPreference(key));
      }
    };
    const unauthorized = () => reset();
    const pagehide = () => clear();
    window.addEventListener('storage', storage);
    window.addEventListener('owp:unauthorized', unauthorized);
    window.addEventListener('pagehide', pagehide);
    return () => {
      clear();
      state.current.scope = undefined;
      window.removeEventListener('storage', storage);
      window.removeEventListener('owp:unauthorized', unauthorized);
      window.removeEventListener('pagehide', pagehide);
    };
  }, [scope, key]);
  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    let pending = false;
    const poll = async () => {
      if (pending) return;
      const currentPermission = availability();
      setPermission((previous) =>
        previous === 'unavailable' && currentPermission === 'granted'
          ? previous
          : currentPermission,
      );
      // Hidden polling is bounded to jobs explicitly started in this tab.
      if (document.hidden && !(enabled && currentPermission === 'granted')) return;
      pending = true;
      const generation = state.current.generation;
      try {
        await Promise.all(
          [...state.current.jobs.values()].map(async (previous) => {
            try {
              const job = await api<Job>(`/jobs/${encodeURIComponent(previous.id)}`, {
                signal: controller.signal,
              });
              if (
                controller.signal.aborted ||
                generation !== state.current.generation ||
                state.current.jobs.get(previous.id) !== previous
              )
                return;
              if (job.mode !== previous.mode) {
                state.current.jobs.delete(job.id);
                return;
              }
              if (!terminal.has(job.status)) return;
              // Consume before displaying: reconnects and repeated polls cannot replay it.
              state.current.jobs.delete(job.id);
              const text = jobNotificationText(job);
              setNotices((values) =>
                [...values.filter((v) => v.id !== job.id), { id: job.id, text }].slice(-5),
              );
              if (!enabled || availability() !== 'granted') return;
              try {
                const notification = new Notification('openwebprint', {
                  body: t(text),
                  tag: `owp-job-${job.id}`,
                });
                state.current.notifications.set(job.id, notification);
                notification.onclick = () => {
                  if (generation !== state.current.generation) return;
                  window.focus();
                  openRef.current(job.id);
                  notification.close();
                };
                notification.onclose = () => {
                  if (state.current.notifications.get(job.id) === notification)
                    state.current.notifications.delete(job.id);
                };
                notification.onerror = () => {
                  if (generation === state.current.generation) setPermission('unavailable');
                };
              } catch {
                // Some mobile browsers expose the API but reject the constructor.
                setPermission('unavailable');
              }
            } catch (error) {
              if (
                error instanceof ApiError &&
                error.status === 404 &&
                generation === state.current.generation
              )
                state.current.jobs.delete(previous.id);
              // Transient errors retain ownership; the next successful poll reconciles it.
            }
          }),
        );
      } finally {
        pending = false;
      }
    };
    const resume = () => void poll();
    const timer = setInterval(resume, 5000);
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [scope, enabled]);

  async function enable() {
    const generation = state.current.generation;
    try {
      const result =
        availability() === 'default' ? await Notification.requestPermission() : availability();
      if (generation !== state.current.generation) return;
      setPermission(result);
      if (result !== 'granted') return;
      clear();
      try {
        localStorage.setItem(key, 'true');
      } catch {
        /* This tab can still opt in. */
      }
      setEnabled(true);
    } catch {
      if (generation === state.current.generation) setPermission('unavailable');
    }
  }
  function disable() {
    clear();
    try {
      localStorage.setItem(key, 'false');
    } catch {
      /* The local opt-out still applies. */
    }
    setEnabled(false);
  }
  const ownerGeneration = state.current.generation;
  function started(job: Job) {
    if (!scope || scope !== state.current.scope || ownerGeneration !== state.current.generation)
      return;
    state.current.notifications.get(job.id)?.close();
    // A terminal submission response is the baseline, not a newly observed transition.
    if (!terminal.has(job.status)) state.current.jobs.set(job.id, job);
  }
  return {
    enabled,
    permission,
    enable,
    disable,
    started,
    reset,
    notices,
    dismiss: (id: string) => setNotices((values) => values.filter((v) => v.id !== id)),
  };
}
