import { LanguagePicker } from './LanguagePicker';
import { t, formatDateTime, hardwareText, serverMessage } from './i18n';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, FolderOpen, Plus, Printer, Radar, ScanLine } from 'lucide-react';
import type {
  DeviceInput,
  DiscoveryResult,
  OnboardingState,
  HardwareReport,
} from '@openwebprint/shared';
import { api, post } from './api';
import { DeviceDialog } from './DeviceDialog';
import { Brand } from './Brand';
import { Spinner } from './ui';
import s from './App.module.css';
export function SetupScreen({ changed }: { changed: () => Promise<void> }) {
  const [state, setState] = useState<OnboardingState>();
  const [hardware, setHardware] = useState<HardwareReport>();
  const [checking, setChecking] = useState(false);
  const [hardwareError, setHardwareError] = useState('');
  const [discovery, setDiscovery] = useState<DiscoveryResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deviceErrors, setDeviceErrors] = useState<{ address: string; error: string }[]>([]);
  const [manual, setManual] = useState(false);
  const [path, setPath] = useState('');
  const alive = useRef(true);
  const load = useCallback(async () => {
    const result = await api<OnboardingState>('/onboarding');
    if (alive.current) {
      setState(result);
      setPath(result.scanRoot);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => setError(e.message));
    return () => {
      alive.current = false;
    };
  }, [load]);
  const prerequisites = useCallback(async () => {
    setChecking(true);
    setHardwareError('');
    try {
      const result = await post<HardwareReport>('/hardware/prerequisites');
      if (alive.current) setHardware(result);
    } catch (e) {
      if (alive.current) setHardwareError((e as Error).message);
    } finally {
      if (alive.current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    if (state?.phase === 'devices') void prerequisites();
  }, [state?.phase, prerequisites]);
  const discover = useCallback(async () => {
    setSearching(true);
    setError('');
    try {
      const result = await post<DiscoveryResult>('/devices/discover');
      if (alive.current) setDiscovery(result);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setSearching(false);
    }
  }, []);
  useEffect(() => {
    if (state?.phase === 'devices') void discover();
  }, [state?.phase, discover]);
  async function choose(endpoint: '/onboarding/demo' | '/onboarding/start') {
    setBusy(true);
    setError('');
    setDeviceErrors([]);
    try {
      setState(await post<OnboardingState>(endpoint));
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function devicesNext() {
    setBusy(true);
    setError('');
    setDeviceErrors([]);
    try {
      const devices =
        discovery?.devices.filter((device) => selected.includes(device.address)) ?? [];
      const result = await post<OnboardingState & { errors: { address: string; error: string }[] }>(
        '/onboarding/devices',
        { devices },
      );
      setState(result);
      setPath(result.scanRoot);
      setDeviceErrors(result.errors);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function finish(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setDeviceErrors([]);
    try {
      await post('/onboarding/storage', { path });
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={s.setupPage}>
      <div className={s.setupHeader}>
        <span className={s.brand}>
          <Brand />
        </span>
        <LanguagePicker />
      </div>
      <div className={s.setupContent}>
        {deviceErrors.map((failure) => (
          <p role="alert" className={s.error} key={failure.address}>
            {failure.address}: {serverMessage(failure.error)}
          </p>
        ))}
        {!state || state.phase === 'complete' ? (
          <>
            <Spinner />
            {error && (
              <p role="alert" className={s.error}>
                {t(error)}
              </p>
            )}
          </>
        ) : state.phase === 'welcome' ? (
          <>
            <h1>{t('Welcome to openwebprint')}</h1>
            <p className={s.setupDescription}>
              {t('Try it with simulated devices, or connect your own printers and scanners.')}
            </p>
            <div className={s.setupChoices}>
              <section className={s.setupChoice}>
                <Printer size={25} />
                <h2>{t('Set up your devices')}</h2>
                <p>
                  {t(
                    'Find compatible devices on your network and choose where your scans are saved.',
                  )}
                </p>
                <button
                  className={s.primary}
                  disabled={busy}
                  onClick={() => void choose('/onboarding/start')}
                >
                  {busy ? <Spinner /> : <ArrowRight size={16} />}
                  {t('Start setup')}
                </button>
              </section>
              <section className={s.setupChoice}>
                <ScanLine size={25} />
                <h2>{t('Explore the demo')}</h2>
                <p>
                  {t(
                    'Try printing and scanning with sample devices. No real hardware is contacted.',
                  )}
                </p>
                <button
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => void choose('/onboarding/demo')}
                >
                  {t('Try demo')}
                  <ArrowRight size={16} />
                </button>
              </section>
            </div>
            {error && (
              <p role="alert" className={s.error}>
                {t(error)}
              </p>
            )}
          </>
        ) : (
          <>
            <div className={s.setupSteps} aria-label={t('Setup progress')}>
              <span aria-current={state.phase === 'devices' ? 'step' : undefined}>
                {t('1. Devices')}
              </span>
              <ArrowRight size={14} />
              <span aria-current={state.phase === 'storage' ? 'step' : undefined}>
                {t('2. Scan storage')}
              </span>
            </div>
            <h1>
              {state.phase === 'devices'
                ? t('Connect your devices')
                : t('Where should scans be saved?')}
            </h1>
            <p className={s.setupDescription}>
              {state.phase === 'devices'
                ? t(
                    'Select the printers and scanners you want to use. You can add or remove devices later on the Devices page.',
                  )
                : t(
                    'Choose the root folder on this server for scanned documents and their previews.',
                  )}
            </p>
            {state.phase === 'devices' ? (
              <>
                <section
                  className={s.setupPrerequisites}
                  aria-label={t('Printing and scanning prerequisites')}
                  aria-busy={checking}
                >
                  <h2>{t('Printing and scanning prerequisites')}</h2>
                  <p role="status">
                    {checking
                      ? t('Checking software and service access…')
                      : hardware
                        ? hardware.ready
                          ? t('Software checks passed')
                          : t('Hardware setup needs attention')
                        : t('Software access has not been checked.')}
                  </p>
                  {hardware && (
                    <>
                      <ul>
                        {hardware.checks.map((check) => (
                          <li key={check.id}>
                            <strong>{hardwareText(check.label)}:</strong>{' '}
                            {
                              {
                                ok: t('Available'),
                                empty: t('Search succeeded; no devices found'),
                                missing: t('Software missing'),
                                unavailable: t('Service or backend unavailable'),
                                permission: t('Permission denied'),
                                timeout: t('Check timed out'),
                              }[check.state]
                            }
                          </li>
                        ))}
                      </ul>
                      <p>{hardwareText(hardware.guidance)}</p>
                      {hardware.setupCommand ? (
                        <>
                          <p>
                            {t(
                              'To install missing packages or start services, run the integrated setup in Terminal on this computer. It shows each OS change and asks for your consent. Then check again here.',
                            )}
                          </p>
                          <pre className={s.setupCommand}>
                            <code>{hardware.setupCommand}</code>
                          </pre>
                        </>
                      ) : (
                        <p>
                          {hardware.method === 'container'
                            ? t(
                                'Update the container hardware stack on its host, then check again.',
                              )
                            : t(
                                'For source installations, use the hardware prerequisites in the project installation guide or switch to the official installer for guided dependency setup.',
                              )}
                        </p>
                      )}
                      <p className={s.small}>{hardwareText(hardware.note)}</p>
                      <p className={s.small}>
                        {t('Checked: {value1}', { value1: formatDateTime(hardware.checkedAt) })}
                      </p>
                    </>
                  )}
                  {hardwareError && (
                    <p role="alert" className={s.error}>
                      {t(hardwareError)}
                    </p>
                  )}
                  <button
                    className={s.secondary}
                    disabled={checking}
                    onClick={() => void prerequisites()}
                  >
                    {checking ? <Spinner /> : <Check size={16} />}
                    {t('Check prerequisites again')}
                  </button>
                </section>
                <div className={s.setupSearch}>
                  <p>
                    {searching ? (
                      <>
                        <Spinner />
                        {t('Searching your network…')}
                      </>
                    ) : discovery ? (
                      `${discovery.devices.length} devices found`
                    ) : (
                      t('Ready to search')
                    )}
                  </p>
                  <button
                    className={s.secondary}
                    disabled={busy || searching}
                    onClick={() => void discover()}
                  >
                    <Radar size={16} />
                    {t('Search again')}
                  </button>
                </div>
                {discovery?.warnings.map((warning) => (
                  <p key={t(warning)} className={s.warning}>
                    {t(warning)}
                  </p>
                ))}
                {discovery?.hostDiscovery && (
                  <p className={s.small}>{t('Network discovery via macOS Bonjour.')}</p>
                )}
                <div className={s.setupDevices}>
                  {discovery?.devices.map((device: DeviceInput) => {
                    const connected = state.devices.some(
                      (existing) => existing.address === device.address,
                    );
                    const Icon = device.kind === 'printer' ? Printer : ScanLine;
                    return (
                      <label className={s.setupDevice} key={`${device.kind}-${device.address}`}>
                        <input
                          type="checkbox"
                          checked={connected || selected.includes(device.address)}
                          disabled={busy || connected}
                          onChange={(e) =>
                            setSelected((previous) =>
                              e.target.checked
                                ? [...previous, device.address]
                                : previous.filter((address) => address !== device.address),
                            )
                          }
                        />
                        <Icon size={20} />
                        <span>
                          <strong>{device.name}</strong>
                          <small>
                            {device.kind === 'printer' ? t('Printer') : t('Scanner')} ·{' '}
                            {device.address}
                          </small>
                        </span>
                        {connected && <Check size={17} aria-label={t('Connected')} />}
                      </label>
                    );
                  })}
                </div>
                {!searching && discovery && !discovery.devices.length && (
                  <p className={s.small}>
                    {t(
                      'No devices found. Check your network, add a device manually, or continue and add devices later.',
                    )}
                  </p>
                )}
                <button className={s.textButton} disabled={busy} onClick={() => setManual(true)}>
                  <Plus size={16} />
                  {t('Add manually')}
                </button>
                {error && (
                  <p className={s.error} role="alert">
                    {t(error)}
                  </p>
                )}
                <div className={s.setupActions}>
                  <button
                    className={s.primary}
                    disabled={busy || searching}
                    onClick={() => void devicesNext()}
                  >
                    {busy ? <Spinner /> : <ArrowRight size={16} />}{' '}
                    {selected.length || state.devices.length
                      ? t('Continue')
                      : t('Continue without devices')}
                  </button>
                </div>
              </>
            ) : (
              <form className={s.form} onSubmit={finish}>
                <label>
                  {t('Scan storage folder')}
                  <input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    required
                    maxLength={1024}
                    placeholder="/data/scans"
                    disabled={busy}
                  />
                </label>
                <p className={s.small}>
                  {t(
                    'This is a server path, not a folder on your browser device. In Docker, use a mounted folder such as /data/scans. The folder will be created if it does not exist and must be writable by openwebprint.',
                  )}
                </p>
                {error && (
                  <p className={s.error} role="alert">
                    {t(error)}
                  </p>
                )}
                <div className={s.setupActions}>
                  <button className={s.primary} disabled={busy}>
                    {busy ? <Spinner /> : <FolderOpen size={16} />}
                    {t('Finish setup')}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
      {manual && state && (
        <DeviceDialog
          devices={state.devices}
          demo={false}
          close={() => setManual(false)}
          changed={() => void load()}
        />
      )}
    </main>
  );
}
