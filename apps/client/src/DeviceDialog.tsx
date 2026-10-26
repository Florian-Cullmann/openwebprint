import { useState, type FormEvent } from 'react';
import { Check, Plus, Radar, ArrowLeft, Printer, ScanLine, AlertCircle } from 'lucide-react';
import type { Device, DeviceInput, DiscoveryResult } from '@openwebprint/shared';
import { post } from './api';
import { Modal, Spinner } from './ui';
import s from './App.module.css';
export function DeviceDialog({
  devices,
  demo,
  close,
  changed,
  onlyKind,
}: {
  devices: Device[];
  demo: boolean;
  close: () => void;
  changed: () => void;
  onlyKind?: DeviceInput['kind'];
}) {
  const [tab, setTab] = useState<'discover' | 'manual'>('discover');
  const [result, setResult] = useState<DiscoveryResult>();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  const [kind, setKind] = useState<DeviceInput['kind']>(onlyKind ?? 'printer');
  const [added, setAdded] = useState<string[]>([]);
  async function discover() {
    setBusy(true);
    setError('');
    try {
      setResult(await post<DiscoveryResult>('/devices/discover'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function add(input: DeviceInput) {
    setAdding(input.address);
    setError('');
    try {
      await post('/devices', input);
      setAdded((a) => [...a, input.address]);
      changed();
      if (tab === 'manual') close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding('');
    }
  }
  function manual(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    void add({
      name: String(data.get('name')),
      kind,
      address: String(data.get('address')),
      location: String(data.get('location')),
    });
  }
  return (
    <Modal
      title="Add device"
      subtitle={
        demo
          ? 'Only simulated devices are available in demo mode.'
          : 'Printers and scanners compatible with CUPS or SANE.'
      }
      close={() => {
        if (!adding) close();
      }}
    >
      <div className={s.modalBody}>
        <div className={s.tabs}>
          <button
            className={tab === 'discover' ? s.activeTab : ''}
            onClick={() => setTab('discover')}
          >
            <Radar size={16} /> Discover devices
          </button>
          <button className={tab === 'manual' ? s.activeTab : ''} onClick={() => setTab('manual')}>
            <Plus size={16} /> Add manually
          </button>
        </div>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        {tab === 'discover' ? (
          <>
            <div className={s.discoveryIntro}>
              <span className={s.radar}>
                <Radar size={36} strokeWidth={1.4} />
              </span>
              <h3>{busy ? 'Searching for devices…' : 'Find devices on your network'}</h3>
              <p>
                {demo
                  ? 'Find the prepared demo devices.'
                  : 'Searches mDNS, CUPS and SANE. This can take up to 35 seconds.'}
              </p>
              <button
                className={s.primary}
                disabled={busy || !!adding}
                onClick={() => void discover()}
              >
                {busy ? <Spinner /> : <Radar size={17} />}{' '}
                {result ? 'Search again' : 'Search devices'}
              </button>
            </div>
            {result && (
              <div className={s.discoveryResults}>
                <span className={s.eyebrow}>
                  {result.devices.filter((d) => !onlyKind || d.kind === onlyKind).length} DEVICES
                  FOUND
                </span>
                {result.hostDiscovery && (
                  <p className={s.small}>Network discovery via macOS Bonjour.</p>
                )}
                {result.devices
                  .filter((d) => !onlyKind || d.kind === onlyKind)
                  .map((d) => {
                    const exists =
                      devices.some((existing) => existing.address === d.address) ||
                      added.includes(d.address);
                    const Icon = d.kind === 'printer' ? Printer : ScanLine;
                    return (
                      <div className={s.discoveryRow} key={`${d.kind}-${d.address}`}>
                        <Icon size={23} />
                        <div>
                          <h3>{d.name}</h3>
                          <p>{d.address}</p>
                        </div>
                        <button
                          className={s.secondary}
                          disabled={exists || !!adding}
                          onClick={() => void add(d)}
                        >
                          {adding === d.address ? (
                            <Spinner />
                          ) : exists ? (
                            <Check size={16} />
                          ) : (
                            <Plus size={16} />
                          )}{' '}
                          {exists ? 'Connected' : 'Add'}
                        </button>
                      </div>
                    );
                  })}
                {!result.devices.some((d) => !onlyKind || d.kind === onlyKind) && (
                  <p>No devices found. Check the network or add an address manually.</p>
                )}
                {result.warnings.map((w) => (
                  <p className={s.warning} key={w}>
                    <AlertCircle size={16} />
                    {w}
                  </p>
                ))}
              </div>
            )}
          </>
        ) : (
          <form className={s.form} onSubmit={manual}>
            <div className={s.formGrid}>
              <label>
                Device type
                <select
                  value={kind}
                  disabled={!!onlyKind}
                  onChange={(e) => setKind(e.target.value as DeviceInput['kind'])}
                >
                  <option value="printer">Printer</option>
                  <option value="scanner">Scanner</option>
                </select>
              </label>
              <label>
                Name
                <input name="name" required maxLength={80} placeholder="Brother in the study" />
              </label>
            </div>
            <label>
              {demo
                ? 'Demo address'
                : kind === 'printer'
                  ? 'IPP address or CUPS queue'
                  : 'SANE device ID'}
              <input
                name="address"
                required
                maxLength={512}
                placeholder={
                  demo
                    ? 'demo://mein-geraet'
                    : kind === 'printer'
                      ? 'ipp://192.168.1.50/ipp/print'
                      : 'airscan:e0:Brother MFC-L2750DW'
                }
              />
            </label>
            <label>
              Location <span className={s.optional}>optional</span>
              <input name="location" maxLength={80} placeholder="e.g. Study" />
            </label>
            <p className={s.small}>
              {demo
                ? 'Demo devices do not connect to hardware.'
                : kind === 'printer'
                  ? 'Use IPP Everywhere / AirPrint, or an existing CUPS queue as cups://QUEUE. Configure models that require a driver in CUPS first.'
                  : 'Find the complete ID with scanimage -L. Depending on the model, scanners use eSCL, WSD or another installed SANE backend.'}
            </p>
            <div className={s.modalActions}>
              <button type="button" className={s.secondary} onClick={() => setTab('discover')}>
                <ArrowLeft size={16} /> Back
              </button>
              <button className={s.primary} disabled={!!adding}>
                {adding ? <Spinner /> : <Plus size={16} />} Add device
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
