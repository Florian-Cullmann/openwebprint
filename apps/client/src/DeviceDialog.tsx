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
}: {
  devices: Device[];
  demo: boolean;
  close: () => void;
  changed: () => void;
}) {
  const [tab, setTab] = useState<'discover' | 'manual'>('discover');
  const [result, setResult] = useState<DiscoveryResult>();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  const [kind, setKind] = useState<DeviceInput['kind']>('printer');
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
      title="Ein neuer Teil deines Workflows."
      subtitle={
        demo
          ? 'Hier verwaltest du ausschließlich simulierte Geräte.'
          : 'Brother, HP, Canon, Epson und weitere kompatible Geräte.'
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
            <Radar size={16} /> Automatisch finden
          </button>
          <button className={tab === 'manual' ? s.activeTab : ''} onClick={() => setTab('manual')}>
            <Plus size={16} /> Manuell hinzufügen
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
              <h3>
                {busy
                  ? 'Wir sehen uns im Netzwerk um …'
                  : 'Deine Geräte sind näher, als du denkst.'}
              </h3>
              <p>
                {demo
                  ? 'Suche die vorbereiteten Demo-Geräte.'
                  : 'Wir suchen über mDNS, CUPS und SANE. Das kann bis zu 35 Sekunden dauern.'}
              </p>
              <button
                className={s.primary}
                disabled={busy || !!adding}
                onClick={() => void discover()}
              >
                {busy ? <Spinner /> : <Radar size={17} />}{' '}
                {result ? 'Erneut suchen' : 'Geräte suchen'}
              </button>
            </div>
            {result && (
              <div className={s.discoveryResults}>
                <span className={s.eyebrow}>{result.devices.length} GERÄTE GEFUNDEN</span>
                {result.devices.map((d) => {
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
                        {exists ? 'Verbunden' : 'Hinzufügen'}
                      </button>
                    </div>
                  );
                })}
                {!result.devices.length && (
                  <p>
                    Kein Gerät gefunden. Prüfe das Netzwerk oder füge eine Adresse manuell hinzu.
                  </p>
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
                Gerätetyp
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as DeviceInput['kind'])}
                >
                  <option value="printer">Drucker</option>
                  <option value="scanner">Scanner</option>
                </select>
              </label>
              <label>
                Name
                <input name="name" required maxLength={80} placeholder="Brother im Arbeitszimmer" />
              </label>
            </div>
            <label>
              {demo
                ? 'Demo-Adresse'
                : kind === 'printer'
                  ? 'IPP-Adresse oder CUPS-Warteschlange'
                  : 'SANE-Gerätekennung'}
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
              Standort <span className={s.optional}>optional</span>
              <input name="location" maxLength={80} placeholder="z. B. Arbeitszimmer" />
            </label>
            <p className={s.small}>
              {demo
                ? 'Demo-Geräte stellen keine Verbindung zu Hardware her.'
                : kind === 'printer'
                  ? 'IPP Everywhere / AirPrint oder eine bestehende CUPS-Queue als cups://WARTESCHLANGE. Ältere Brother-Modelle zuerst mit geeignetem Treiber in CUPS einrichten.'
                  : 'Die vollständige Kennung findest du mit scanimage -L. Brother-Scanner nutzen je nach Modell eSCL, WSD oder einen installierten SANE-Treiber.'}
            </p>
            <div className={s.modalActions}>
              <button type="button" className={s.secondary} onClick={() => setTab('discover')}>
                <ArrowLeft size={16} /> Zurück
              </button>
              <button className={s.primary} disabled={!!adding}>
                {adding ? <Spinner /> : <Plus size={16} />} Gerät hinzufügen
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
