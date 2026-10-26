import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, FolderOpen, Plus, Printer, Radar, ScanLine } from 'lucide-react';
import type { DeviceInput, DiscoveryResult, OnboardingState } from '@openwebprint/shared';
import { api, post } from './api';
import { DeviceDialog } from './DeviceDialog';
import { Spinner } from './ui';
import s from './App.module.css';
export function SetupScreen({ changed }: { changed: () => Promise<void> }) {
  const [state, setState] = useState<OnboardingState>();
  const [discovery, setDiscovery] = useState<DiscoveryResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    try {
      const devices =
        discovery?.devices.filter((device) => selected.includes(device.address)) ?? [];
      const result = await post<OnboardingState & { errors: { address: string; error: string }[] }>(
        '/onboarding/devices',
        { devices },
      );
      setState(result);
      setPath(result.scanRoot);
      if (result.errors.length)
        setError(result.errors.map((failure) => `${failure.address}: ${failure.error}`).join('\n'));
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
          <span className={s.brandMark}>
            <Printer size={21} />
          </span>
          openwebprint
        </span>
      </div>
      <div className={s.setupContent}>
        {!state || state.phase === 'complete' ? (
          <>
            <Spinner />
            {error && (
              <p role="alert" className={s.error}>
                {error}
              </p>
            )}
          </>
        ) : state.phase === 'welcome' ? (
          <>
            <h1>Welcome to openwebprint</h1>
            <p className={s.setupDescription}>
              Try it with simulated devices, or connect your own printers and scanners.
            </p>
            <div className={s.setupChoices}>
              <section className={s.setupChoice}>
                <Printer size={25} />
                <h2>Set up your devices</h2>
                <p>
                  Find compatible devices on your network and choose where your scans are saved.
                </p>
                <button
                  className={s.primary}
                  disabled={busy}
                  onClick={() => void choose('/onboarding/start')}
                >
                  {busy ? <Spinner /> : <ArrowRight size={16} />} Start setup
                </button>
              </section>
              <section className={s.setupChoice}>
                <ScanLine size={25} />
                <h2>Explore the demo</h2>
                <p>Try printing and scanning with sample devices. No real hardware is contacted.</p>
                <button
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => void choose('/onboarding/demo')}
                >
                  Try demo <ArrowRight size={16} />
                </button>
              </section>
            </div>
            {error && (
              <p role="alert" className={s.error}>
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <div className={s.setupSteps} aria-label="Setup progress">
              <span aria-current={state.phase === 'devices' ? 'step' : undefined}>1. Devices</span>
              <ArrowRight size={14} />
              <span aria-current={state.phase === 'storage' ? 'step' : undefined}>
                2. Scan storage
              </span>
            </div>
            <h1>
              {state.phase === 'devices' ? 'Connect your devices' : 'Where should scans be saved?'}
            </h1>
            <p className={s.setupDescription}>
              {state.phase === 'devices'
                ? 'Select the printers and scanners you want to use. You can add or remove devices later on the Devices page.'
                : 'Choose the root folder on this server for scanned documents and their previews.'}
            </p>
            {state.phase === 'devices' ? (
              <>
                <div className={s.setupSearch}>
                  <p>
                    {searching ? (
                      <>
                        <Spinner /> Searching your network…
                      </>
                    ) : discovery ? (
                      `${discovery.devices.length} devices found`
                    ) : (
                      'Ready to search'
                    )}
                  </p>
                  <button
                    className={s.secondary}
                    disabled={busy || searching}
                    onClick={() => void discover()}
                  >
                    <Radar size={16} /> Search again
                  </button>
                </div>
                {discovery?.warnings.map((warning) => (
                  <p key={warning} className={s.warning}>
                    {warning}
                  </p>
                ))}
                {discovery?.hostDiscovery && (
                  <p className={s.small}>Network discovery via macOS Bonjour.</p>
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
                            {device.kind === 'printer' ? 'Printer' : 'Scanner'} · {device.address}
                          </small>
                        </span>
                        {connected && <Check size={17} aria-label="Connected" />}
                      </label>
                    );
                  })}
                </div>
                {!searching && discovery && !discovery.devices.length && (
                  <p className={s.small}>
                    No devices found. Check your network, add a device manually, or continue and add
                    devices later.
                  </p>
                )}
                <button className={s.textButton} disabled={busy} onClick={() => setManual(true)}>
                  <Plus size={16} /> Add manually
                </button>
                {error && (
                  <p className={s.error} role="alert">
                    {error}
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
                      ? 'Continue'
                      : 'Continue without devices'}
                  </button>
                </div>
              </>
            ) : (
              <form className={s.form} onSubmit={finish}>
                <label>
                  Scan storage folder
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
                  This is a server path, not a folder on your browser device. In Docker, use a
                  mounted folder such as /data/scans. The folder will be created if it does not
                  exist and must be writable by openwebprint.
                </p>
                {error && (
                  <p className={s.error} role="alert">
                    {error}
                  </p>
                )}
                <div className={s.setupActions}>
                  <button className={s.primary} disabled={busy}>
                    {busy ? <Spinner /> : <FolderOpen size={16} />} Finish setup
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
