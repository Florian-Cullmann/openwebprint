import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { HardwareReport, Mode } from '@openwebprint/shared';
import { post } from './api';
import { Spinner } from './ui';
import s from './App.module.css';

const stateLabels = {
  ok: 'Available',
  empty: 'Search succeeded; no devices found',
  missing: 'Software missing',
  unavailable: 'Service or backend unavailable',
  permission: 'Permission denied',
  timeout: 'Check timed out',
};

function nextStep(check: HardwareReport['checks'][number]) {
  if (check.state === 'ok') return;
  if (check.state === 'missing')
    return check.id === 'scanimage'
      ? 'Install SANE utilities on the server (sane-utils on Debian/Ubuntu; sane-backends with Homebrew on macOS).'
      : ['lp', 'lpadmin', 'lpstat', 'cancel'].includes(check.id)
        ? 'Install or repair the CUPS client tools on the server.'
        : 'Install the named package using the server’s software manager.';
  if (check.state === 'timeout')
    return 'Check service and device connectivity, firewall rules and VPN settings, then run diagnostics again.';
  if (check.state === 'permission')
    return 'Review CUPS access or scanner/USB permissions for the server account; do not run the app as root.';
  if (check.id === 'cups')
    return 'Start or repair the CUPS service on the server, then check again.';
  if (check.id === 'printers' && check.state === 'empty')
    return 'Add a printer in Devices or your server’s CUPS settings. This checks configured queues, not all network printers.';
  if (check.id === 'scanners')
    return check.state === 'empty'
      ? 'Check power, network/USB access and the installed SANE backend. Empty discovery does not mean a scanner is incompatible; try adding its supported address manually.'
      : 'Scanner discovery failed. Check the SANE backend and network/USB access on the server, then retry.';
  return 'Review the server’s hardware installation and access permissions, then check again.';
}

export function HardwareDiagnostics({ mode }: { mode: Mode }) {
  const [report, setReport] = useState<HardwareReport>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run() {
    if (running.current || mode === 'demo') return;
    running.current = true;
    setChecking(true);
    setError('');
    // A previous report remains explicitly historical until this run succeeds.
    try {
      const result = await post<HardwareReport>('/hardware/prerequisites');
      if (alive.current) setReport(result);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      running.current = false;
      if (alive.current) setChecking(false);
    }
  }
  return (
    <section
      className={s.setupPrerequisites}
      aria-label="Hardware diagnostics"
      aria-busy={checking}
    >
      <h2>Hardware diagnostics</h2>
      {mode === 'demo' ? (
        <p>
          Demo mode uses simulated devices and needs no CUPS or SANE. Hardware diagnostics are
          disabled here; remove demo data to begin hardware setup. No real hardware is contacted.
        </p>
      ) : (
        <>
          <p>
            Check printing tools, the CUPS service and scanner discovery on the server running
            openwebprint. These read-only checks never print, acquire a scan, change queues or
            install software. They may take about a minute.
          </p>
          <p role="status">
            {checking
              ? 'Checking software and service access…'
              : error
                ? 'Diagnostics failed. Any results below are from the previous check.'
                : report
                  ? report.ready
                    ? 'Software checks passed'
                    : 'Hardware setup needs attention'
                  : 'Software access has not been checked.'}
          </p>
          {report && (
            <>
              <p className={s.small}>
                {checking || error ? 'Previous check' : 'Checked'}:{' '}
                <time dateTime={report.checkedAt}>
                  {new Date(report.checkedAt).toLocaleString()}
                </time>
                {' · '}
                {report.method === 'container'
                  ? 'Container'
                  : report.platform === 'darwin'
                    ? 'macOS server'
                    : 'Linux server'}
              </p>
              <ul className={s.diagnosticChecks}>
                {report.checks.map((check) => (
                  <li key={check.id}>
                    <strong>{check.label}:</strong> {stateLabels[check.state]}
                    {nextStep(check) && <p>{nextStep(check)}</p>}
                  </li>
                ))}
              </ul>
              <p>{report.guidance}</p>
              {report.setupCommand ? (
                <>
                  <p>
                    Run the integrated setup in Terminal on the server to repair dependencies. It
                    shows each OS change and asks for consent. Then run diagnostics again.
                  </p>
                  <pre className={s.setupCommand}>
                    <code>{report.setupCommand}</code>
                  </pre>
                </>
              ) : (
                <p>
                  {report.method === 'container'
                    ? 'These results describe the container, not its host. Host-installed tools and queues are separate. Repair the container image/services and its network or USB access on the host.'
                    : 'Install dependencies on this server, not on the computer displaying the browser. Linux needs CUPS client/server, print filters and SANE utilities; sane-airscan supports network scanners where available. macOS supplies CUPS; install sane-backends using existing Homebrew. Vendor-only scanner drivers are not SANE drivers.'}
                </p>
              )}
              <p className={s.small}>{report.note}</p>
            </>
          )}
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
        </>
      )}
      <button
        className={s.secondary}
        disabled={checking || mode === 'demo'}
        onClick={() => void run()}
      >
        {checking ? <Spinner /> : <RefreshCw size={16} />} Run diagnostics
      </button>
    </section>
  );
}
