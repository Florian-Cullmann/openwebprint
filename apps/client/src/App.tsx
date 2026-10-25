import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  FileText,
  Github,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Moon,
  Plus,
  Printer,
  Radar,
  RefreshCw,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  X,
  AlertTriangle,
  Monitor,
} from 'lucide-react';
import type { Device, Job, SessionInfo, Snapshot } from '@openwebprint/shared';
import { api, post } from './api';
import { AuthScreen } from './AuthScreen';
import { DeviceDialog } from './DeviceDialog';
import { PrintDialog } from './PrintDialog';
import { ScanDialog } from './ScanDialog';
import { DeviceBadge, DeviceIcon, Empty, JobBadge, Modal, Spinner } from './ui';
import s from './App.module.css';

type View = 'overview' | 'devices' | 'jobs' | 'scans' | 'settings';
type Dialog = { type: 'print' | 'scan'; deviceId?: string; job?: Job } | { type: 'device' };
const navigation: { id: View; label: string; icon: typeof Printer }[] = [
  { id: 'overview', label: 'Übersicht', icon: LayoutDashboard },
  { id: 'devices', label: 'Meine Geräte', icon: Printer },
  { id: 'jobs', label: 'Aufträge', icon: ListOrdered },
  { id: 'scans', label: 'Meine Scans', icon: ScanLine },
  { id: 'settings', label: 'Einstellungen', icon: Settings2 },
];
const formatDate = (date: string) =>
  new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
const completed = new Set(['completed', 'canceled', 'failed']);
export function App() {
  const [session, setSession] = useState<SessionInfo>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [view, setView] = useState<View>('overview');
  const [dialog, setDialog] = useState<Dialog>();
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [jobFilter, setJobFilter] = useState('all');
  const [deleting, setDeleting] = useState<{ device?: Device; job?: Job }>();
  const [theme, setTheme] = useState(() => localStorage.getItem('owp-theme') ?? 'system');
  const refreshing = useRef(false);
  const loadSession = useCallback(async () => {
    setSession(await api<SessionInfo>('/session'));
  }, []);
  useEffect(() => {
    void loadSession().catch((e) => setError(e.message));
    const unauthorized = () => {
      setSession(undefined);
      setSnapshot(undefined);
      void loadSession();
    };
    window.addEventListener('owp:unauthorized', unauthorized);
    return () => window.removeEventListener('owp:unauthorized', unauthorized);
  }, [loadSession]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    localStorage.setItem('owp-theme', theme);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setSnapshot(await api<Snapshot>('/snapshot'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refreshing.current = false;
    }
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [session?.authenticated, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function action(operation: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await operation();
      setToast(message);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function go(next: View) {
    setView(next);
    setQuery('');
    setJobFilter('all');
  }
  if (!session)
    return (
      <div className={s.loading}>
        <Printer size={36} />
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              className={s.secondary}
              onClick={() => void loadSession().catch((e) => setError(e.message))}
            >
              Erneut verbinden
            </button>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    );
  if (!session.authenticated) return <AuthScreen session={session} done={loadSession} />;
  const demo = session.mode === 'demo';
  const devices = snapshot?.devices ?? [];
  const jobs = snapshot?.jobs ?? [];
  const activeJobs = jobs.filter((j) => !completed.has(j.status));
  const scans = jobs.filter((j) => j.kind === 'scan');
  const subtitle = {
    overview: 'Dokumente drucken und scannen.',
    devices: 'Drucker und Scanner verwalten.',
    jobs: 'Status deiner Druck- und Scanaufträge.',
    scans: 'Vorschau ansehen und als PDF herunterladen.',
    settings: 'Betriebsmodus, Darstellung und Geräteunterstützung.',
  };
  const openPrint = (deviceId?: string) => setDialog({ type: 'print', deviceId });
  const openScan = (deviceId?: string, job?: Job) => setDialog({ type: 'scan', deviceId, job });
  return (
    <div className={s.app}>
      <header className={s.appHeader}>
        <div className={s.headerInner}>
          <a
            className={s.brand}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              go('overview');
            }}
            aria-label="openwebprint Übersicht"
          >
            <span className={s.brandMark}>
              <Printer size={21} />
            </span>
            openwebprint
          </a>
          <nav className={s.navigation} aria-label="Hauptnavigation">
            {navigation.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`${s.navItem} ${view === id ? s.navActive : ''}`}
                onClick={() => go(id)}
                aria-current={view === id ? 'page' : undefined}
              >
                <Icon size={16} />
                {label}
                {id === 'jobs' && !!activeJobs.length && (
                  <span className={s.navCount}>{activeJobs.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className={s.headerActions}>
            <button
              className={s.iconButton}
              title="Farbschema wechseln"
              aria-label="Farbschema wechseln"
              onClick={() =>
                setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
              }
            >
              {document.documentElement.dataset.theme === 'dark' ? (
                <Sun size={18} />
              ) : (
                <Moon size={18} />
              )}
            </button>
            <button
              className={s.iconButton}
              title={`Abmelden: ${session.username}`}
              aria-label="Abmelden"
              onClick={() =>
                void action(async () => {
                  await post('/logout');
                  setSnapshot(undefined);
                  await loadSession();
                }, 'Abgemeldet')
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </header>
      <main className={s.main}>
        {demo && (
          <div className={s.demoBanner}>
            <span className={s.modeLabel}>Demo-Modus</span>
            <p>Geräte, Drucken und Scannen sind simuliert.</p>
            <button className={s.textButton} onClick={() => go('settings')}>
              Details <ArrowRight size={14} />
            </button>
          </div>
        )}
        {error && (
          <div className={s.errorBanner} role="alert">
            <AlertTriangle size={19} />
            <p>{error}</p>
            <button
              className={s.iconButton}
              aria-label="Fehler schließen"
              onClick={() => setError('')}
            >
              <X size={17} />
            </button>
          </div>
        )}
        <div className={s.pageHeading}>
          <div>
            <h1>
              {view === 'overview'
                ? 'Übersicht'
                : view === 'devices'
                  ? 'Meine Geräte'
                  : view === 'jobs'
                    ? 'Alle Aufträge'
                    : view === 'scans'
                      ? 'Meine Scans'
                      : 'Einstellungen'}
            </h1>
            <p>{subtitle[view]}</p>
          </div>
          <div className={s.pageActions}>
            {view === 'overview' ? (
              <>
                <button className={s.primary} onClick={() => openPrint()}>
                  <Printer size={17} /> Dokument drucken
                </button>
                <button className={s.secondary} onClick={() => openScan()}>
                  <ScanLine size={17} /> Scannen
                </button>
              </>
            ) : view === 'devices' ? (
              <button className={s.primary} onClick={() => setDialog({ type: 'device' })}>
                <Plus size={17} /> Gerät hinzufügen
              </button>
            ) : view === 'jobs' ? (
              <button className={s.primary} onClick={() => openPrint()}>
                <Plus size={17} /> Neuer Druckauftrag
              </button>
            ) : view === 'scans' ? (
              <button className={s.primary} onClick={() => openScan()}>
                <ScanLine size={17} /> Neuer Scan
              </button>
            ) : null}
          </div>
        </div>
        {!snapshot ? (
          <div className={s.loading}>
            <Spinner />
            <p>Geräte und Aufträge werden geladen …</p>
          </div>
        ) : (
          <>
            {snapshot.warnings.map((w) => (
              <p className={s.warning} key={w}>
                <AlertTriangle size={16} />
                {w}
              </p>
            ))}
            {view === 'overview' && (
              <>
                <section aria-labelledby="devices-title">
                  <div className={s.sectionHeading}>
                    <h2 id="devices-title">
                      Geräte <span className={s.counter}>{devices.length}</span>
                    </h2>
                    <button className={s.textButton} onClick={() => setDialog({ type: 'device' })}>
                      <Plus size={16} /> Gerät hinzufügen
                    </button>
                  </div>
                  {devices.length ? (
                    <div className={s.deviceList}>
                      {devices.slice(0, 3).map((device) => (
                        <DeviceCard
                          key={device.id}
                          device={device}
                          run={() =>
                            device.kind === 'printer' ? openPrint(device.id) : openScan(device.id)
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty icon={<Printer />} title="Noch keine Geräte">
                      Füge einen Drucker oder Scanner hinzu.
                    </Empty>
                  )}
                  {devices.length > 3 && (
                    <button className={s.moreDevices} onClick={() => go('devices')}>
                      Alle {devices.length} Geräte anzeigen <ArrowRight size={15} />
                    </button>
                  )}
                </section>
                <section aria-labelledby="activity-title">
                  <div className={s.sectionHeading}>
                    <h2 id="activity-title">Letzte Aufträge</h2>
                    <button className={s.textButton} onClick={() => go('jobs')}>
                      Alle Aufträge <ArrowRight size={16} />
                    </button>
                  </div>
                  <JobList
                    jobs={jobs.slice(0, 5)}
                    busy={busy}
                    cancel={(id) =>
                      void action(() => post(`/jobs/${id}/cancel`), 'Auftrag abgebrochen.')
                    }
                    preview={(job) => openScan(job.deviceId, job)}
                  />
                </section>
              </>
            )}
            {view === 'devices' && (
              <>
                <div className={s.toolbar}>
                  <label className={s.search}>
                    <Search size={18} />
                    <input
                      aria-label="Geräte durchsuchen"
                      placeholder="Geräte durchsuchen …"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <button className={s.secondary} onClick={() => setDialog({ type: 'device' })}>
                    <Radar size={16} /> Netzwerk durchsuchen
                  </button>
                </div>
                <div className={s.deviceList}>
                  {devices
                    .filter((d) =>
                      `${d.name} ${d.location}`.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((d) => (
                      <DeviceCard
                        key={d.id}
                        device={d}
                        run={() => (d.kind === 'printer' ? openPrint(d.id) : openScan(d.id))}
                        remove={() => setDeleting({ device: d })}
                        details
                      />
                    ))}
                </div>
                {!devices.filter((d) =>
                  `${d.name} ${d.location}`.toLowerCase().includes(query.toLowerCase()),
                ).length && (
                  <Empty
                    icon={<Printer />}
                    title={query ? 'Keine passenden Geräte.' : 'Hier ist Platz für deine Geräte.'}
                  >
                    {query
                      ? 'Versuche einen anderen Suchbegriff.'
                      : 'Suche im Netzwerk oder füge ein Gerät manuell hinzu.'}
                  </Empty>
                )}
                <p className={s.footnote}>
                  Der Druckerstatus wird von CUPS gemeldet und bestätigt nicht die physische
                  Erreichbarkeit. Scanner werden beim Scan angesprochen.
                </p>
              </>
            )}
            {view === 'jobs' && (
              <>
                <div className={s.toolbar}>
                  <div className={s.tabs}>
                    {[
                      ['all', 'Alle Aufträge'],
                      ['active', 'Offen'],
                      ['completed', 'Abgeschlossen'],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={jobFilter === id ? s.activeTab : ''}
                        onClick={() => setJobFilter(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    className={s.secondary}
                    disabled={busy}
                    onClick={() => void action(refresh, 'Status aktualisiert.')}
                  >
                    <RefreshCw size={16} /> Aktualisieren
                  </button>
                </div>
                <JobList
                  jobs={jobs.filter(
                    (j) =>
                      jobFilter === 'all' ||
                      (jobFilter === 'active'
                        ? !completed.has(j.status)
                        : j.status === 'completed'),
                  )}
                  busy={busy}
                  cancel={(id) =>
                    void action(() => post(`/jobs/${id}/cancel`), 'Auftrag abgebrochen.')
                  }
                  preview={(job) => openScan(job.deviceId, job)}
                  remove={(job) => setDeleting({ job })}
                />
                <p className={s.footnote}>
                  Die letzten 200 Aufträge werden angezeigt. „Status ungeklärt“ bedeutet, dass keine
                  verlässliche Bestätigung vorliegt. Prüfe CUPS, bevor du erneut druckst.
                </p>
              </>
            )}
            {view === 'scans' && (
              <>
                {scans.length ? (
                  <div className={s.scanGrid}>
                    {scans.map((job) => (
                      <article className={s.scanCard} key={job.id}>
                        <button
                          className={s.scanThumb}
                          disabled={!job.hasFile}
                          onClick={() => openScan(job.deviceId, job)}
                          aria-label={`Scanvorschau öffnen: ${job.title}`}
                        >
                          {job.hasFile ? (
                            <img
                              src={`/api/jobs/${job.id}/preview`}
                              alt="Gescannte Seite"
                              loading="lazy"
                            />
                          ) : (
                            <ScanLine size={44} strokeWidth={1} />
                          )}
                        </button>
                        <div className={s.scanCardBody}>
                          <JobBadge status={job.status} />
                          <h3>{job.title}</h3>
                          <p>{job.deviceName}</p>
                          <span className={s.small}>{formatDate(job.createdAt)}</span>
                          {job.error && <p className={s.error}>{job.error}</p>}
                          <div className={s.scanCardActions}>
                            {job.hasFile ? (
                              <a className={s.secondary} href={`/api/jobs/${job.id}/pdf`} download>
                                <ArrowDownToLine size={16} /> PDF speichern
                              </a>
                            ) : (
                              <span className={s.small}>
                                {job.status === 'completed'
                                  ? 'Datei bereits gelöscht'
                                  : 'Noch keine Datei'}
                              </span>
                            )}
                            <button
                              className={s.iconButton}
                              disabled={!completed.has(job.status)}
                              aria-label={`Scan löschen: ${job.title}`}
                              onClick={() => setDeleting({ job })}
                            >
                              <Trash2 size={17} />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <Empty
                    icon={<ScanLine />}
                    title="Noch keine Scans"
                    action={
                      <button className={s.primary} onClick={() => openScan()}>
                        <ScanLine size={17} /> Ersten Scan starten
                      </button>
                    }
                  >
                    Scanne eine Seite und lade sie als PDF herunter.
                  </Empty>
                )}
                <p className={s.footnote}>
                  Scans werden nach 7 Tagen automatisch gelöscht. Der MVP unterstützt einzelne
                  Seiten; mehrseitige PDF-Dateien und OCR sind noch nicht enthalten.
                </p>
              </>
            )}
            {view === 'settings' && (
              <div className={s.settingsGrid}>
                <SettingsCard icon={<Settings2 size={20} />} title="Betriebsmodus">
                  <span className={`${s.badge} ${demo ? s.amber : s.positive}`}>
                    {demo ? 'Demo-Modus aktiv' : 'Echte Hardware aktiv'}
                  </span>
                  <p>
                    {demo
                      ? 'Geräte, Druckvorgänge und Scanvorlagen sind simuliert. Es wird keine Verbindung zu echter Hardware hergestellt.'
                      : 'Geräte werden über CUPS und SANE angesprochen. Ergebnisse und Fehler stammen aus den tatsächlichen Vorgängen.'}
                  </p>
                  <div className={s.codeBlock}>MODE=hardware</div>
                  <p>
                    Zum Wechseln diesen Wert in der Serverkonfiguration setzen und den Dienst neu
                    starten. In Docker zusätzlich das Profil „hardware“ starten. Demo und Hardware
                    haben getrennte Gerätelisten und Aufträge.
                  </p>
                </SettingsCard>
                <SettingsCard icon={<Sun size={20} />} title="Darstellung">
                  <p>Wähle das Erscheinungsbild für diesen Browser.</p>
                  <div className={s.themePicker}>
                    {[
                      ['light', 'Hell', Sun],
                      ['dark', 'Dunkel', Moon],
                      ['system', 'System', Monitor],
                    ].map(([id, label, Icon]) => {
                      const ThemeIcon = Icon as typeof Sun;
                      return (
                        <button
                          key={String(id)}
                          className={theme === id ? s.themeActive : ''}
                          onClick={() => setTheme(String(id))}
                        >
                          <ThemeIcon size={23} />
                          {String(label)}
                        </button>
                      );
                    })}
                  </div>
                </SettingsCard>
                <SettingsCard icon={<Printer size={20} />} title="Brother-Geräte">
                  <p>
                    Moderne Brother-Drucker werden über IPP Everywhere / AirPrint mit CUPS
                    verbunden. Brother-Scanner nutzen sane-airscan über eSCL oder WSD, sofern das
                    Modell diese Protokolle unterstützt.
                  </p>
                  <p>
                    Ältere Modelle benötigen einen passenden CUPS-/SANE-Treiber auf dem Host.
                    Bestehende Warteschlangen kannst du über <code>cups://NAME</code> einbinden.
                    Eine Modellgarantie können wir ohne Hardwaretest nicht geben.
                  </p>
                </SettingsCard>
                <SettingsCard icon={<ShieldCheck size={20} />} title="Dokumente und Zugriff">
                  <p>
                    Deine Anmeldung gilt für 7 Tage. Scans werden nach 7 Tagen entfernt; vorab
                    kannst du sie unter „Meine Scans“ löschen. Druckdateien werden nach der
                    Übertragung aus openwebprint entfernt.
                  </p>
                  <p>
                    CUPS hat einen eigenen Spool und eigene Aufbewahrungsregeln. Für den Zugriff
                    außerhalb des Rechners richte HTTPS und sichere Cookies ein.
                  </p>
                  <a
                    className={s.textButton}
                    href="https://github.com/Florian-Cullmann/openwebprint#self-hosting"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Self-Hosting-Dokumentation <ArrowRight size={16} />
                  </a>
                </SettingsCard>
                <SettingsCard icon={<Github size={20} />} title="Über openwebprint">
                  <p>
                    openwebprint ist freie Software unter der MIT-Lizenz. Neue Provider, bessere
                    Geräteunterstützung oder eine kleine UX-Verbesserung: Beiträge sind willkommen.
                  </p>
                  <a
                    className={s.secondary}
                    href="https://github.com/Florian-Cullmann/openwebprint"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Github size={17} /> Zum Repository
                  </a>
                  <span className={s.small}>Version 0.1.0 · React + Fastify + CUPS + SANE</span>
                </SettingsCard>
              </div>
            )}
          </>
        )}
        <footer className={s.footer}>
          <span>openwebprint · Selbst gehostet</span>
          <a
            href="https://github.com/Florian-Cullmann/openwebprint"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowRight size={12} />
          </a>
        </footer>
      </main>
      {toast && (
        <div className={s.toast} role="status">
          <CheckCircle2 size={19} />
          {toast}
          <button
            className={s.iconButton}
            aria-label="Meldung schließen"
            onClick={() => setToast('')}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {dialog?.type === 'print' && (
        <PrintDialog
          devices={devices}
          initial={dialog.deviceId}
          demo={demo}
          close={() => setDialog(undefined)}
          changed={() => void refresh()}
        />
      )}
      {dialog?.type === 'scan' && (
        <ScanDialog
          devices={devices}
          initial={dialog.deviceId}
          existing={dialog.job}
          demo={demo}
          close={() => setDialog(undefined)}
          changed={() => void refresh()}
        />
      )}
      {dialog?.type === 'device' && (
        <DeviceDialog
          devices={devices}
          demo={demo}
          close={() => setDialog(undefined)}
          changed={() => void refresh()}
        />
      )}
      {deleting && (
        <Modal
          title={deleting.device ? 'Gerät entfernen?' : 'Auftrag und Dateien löschen?'}
          subtitle={deleting.device?.name ?? deleting.job?.title}
          close={() => {
            if (!busy) setDeleting(undefined);
          }}
        >
          <div className={s.modalBody}>
            <p>
              {deleting.device
                ? 'Das Gerät wird aus openwebprint entfernt. Die CUPS-Warteschlange und ihre Konfiguration bleiben bestehen.'
                : 'Der Eintrag und gespeicherte Scan-Dateien werden gelöscht. Ungeklärte Druckaufträge können in CUPS noch aktiv sein. Prüfe die Warteschlange; das Löschen bricht keinen Druckvorgang ab.'}
            </p>
            <div className={s.modalActions}>
              <button
                className={s.secondary}
                disabled={busy}
                onClick={() => setDeleting(undefined)}
              >
                Behalten
              </button>
              <button
                className={s.danger}
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api(
                      deleting.device
                        ? `/devices/${deleting.device.id}`
                        : `/jobs/${deleting.job!.id}`,
                      { method: 'DELETE' },
                    );
                    setDeleting(undefined);
                  }, 'Eintrag entfernt.')
                }
              >
                {busy ? <Spinner /> : <Trash2 size={16} />}{' '}
                {deleting.device ? 'Gerät entfernen' : 'Jetzt löschen'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
function DeviceCard({
  device,
  run,
  remove,
  details = false,
}: {
  device: Device;
  run: () => void;
  remove?: () => void;
  details?: boolean;
}) {
  return (
    <article className={s.deviceRow}>
      <DeviceIcon kind={device.kind} />
      <div className={s.deviceInfo}>
        <h3>{device.name}</h3>
        <p>
          {device.kind === 'printer' ? 'Drucker' : 'Scanner'}
          {device.location ? ` · ${device.location}` : ''}
        </p>
        {details && (
          <details className={s.deviceDetails}>
            <summary>Verbindungsdetails</summary>
            <code>{device.address}</code>
            <p>
              {device.provider === 'demo'
                ? 'Demo-Provider'
                : device.provider === 'cups'
                  ? 'CUPS / IPP'
                  : 'SANE'}
              {device.capabilities?.duplex ? ' · Duplex' : ''}
              {device.capabilities?.color ? ' · Farbe' : ''}
            </p>
            {device.detail && <p>{device.detail}</p>}
          </details>
        )}
      </div>
      <div className={s.deviceControls}>
        <DeviceBadge device={device} />
        <button className={s.secondary} onClick={run}>
          {device.kind === 'printer' ? 'Drucken' : 'Scannen'}
          <ArrowRight size={15} />
        </button>
        {remove && (
          <button className={s.iconButton} aria-label={`${device.name} entfernen`} onClick={remove}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </article>
  );
}
function JobList({
  jobs,
  cancel,
  preview,
  remove,
  busy,
}: {
  jobs: Job[];
  cancel: (id: string) => void;
  preview: (job: Job) => void;
  remove?: (job: Job) => void;
  busy: boolean;
}) {
  if (!jobs.length)
    return (
      <Empty icon={<ListOrdered />} title="Noch keine Aufträge">
        Druckaufträge und Scans erscheinen hier.
      </Empty>
    );
  return (
    <div className={s.jobTableWrap}>
      <table className={s.jobTable}>
        <thead>
          <tr>
            <th>Dokument</th>
            <th>Gerät</th>
            <th>Status</th>
            <th>Datum</th>
            <th>
              <span className={s.srOnly}>Aktionen</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <div className={s.documentCell}>
                  <span className={s.documentIcon}>
                    {job.kind === 'print' ? <FileText size={19} /> : <ScanLine size={19} />}
                  </span>
                  <div>
                    <strong>{job.title}</strong>
                    <span>
                      {job.mode === 'demo' ? 'Demo · ' : ''}
                      {job.kind === 'print' ? 'Druckauftrag' : 'Scan'}
                      {job.kind === 'print' && 'copies' in job.options
                        ? ` · ${job.options.copies} ${job.options.copies === 1 ? 'Kopie' : 'Kopien'}`
                        : ''}
                    </span>
                    {job.error && <p className={s.jobError}>{job.error}</p>}
                  </div>
                </div>
              </td>
              <td className={s.jobDevice}>{job.deviceName}</td>
              <td>
                <JobBadge status={job.status} />
              </td>
              <td className={s.jobDate}>{formatDate(job.createdAt)}</td>
              <td>
                <div className={s.rowActions}>
                  {job.kind === 'print' && !completed.has(job.status) && (
                    <button
                      className={s.iconButton}
                      disabled={busy}
                      title="Auftrag abbrechen"
                      aria-label={`Auftrag abbrechen: ${job.title}`}
                      onClick={() => cancel(job.id)}
                    >
                      <X size={17} />
                    </button>
                  )}
                  {job.hasFile && (
                    <button
                      className={s.iconButton}
                      aria-label={`Vorschau öffnen: ${job.title}`}
                      onClick={() => preview(job)}
                    >
                      <Search size={17} />
                    </button>
                  )}
                  {remove && (completed.has(job.status) || job.status === 'unknown') && (
                    <button
                      className={s.iconButton}
                      disabled={busy}
                      aria-label={`Auftrag löschen: ${job.title}`}
                      onClick={() => remove(job)}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function SettingsCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={s.settingsCard}>
      <div className={s.settingsTitle}>
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}
