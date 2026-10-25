import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
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
  Sparkles,
  Sun,
  Trash2,
  X,
  Zap,
  AlertTriangle,
  Monitor,
  Menu,
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
  const [mobileMenu, setMobileMenu] = useState(false);
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
    setMobileMenu(false);
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
    overview: 'Alles bereit für deinen nächsten Schritt.',
    devices: 'Ein Ort für deine Drucker und Scanner.',
    jobs: 'Behalte deinen Workflow im Blick.',
    scans: 'Vom Papier ins Digitale. Ganz einfach.',
    settings: 'Dein Server. Deine Einstellungen.',
  };
  const openPrint = (deviceId?: string) => setDialog({ type: 'print', deviceId });
  const openScan = (deviceId?: string, job?: Job) => setDialog({ type: 'scan', deviceId, job });
  return (
    <div className={s.app}>
      {mobileMenu && (
        <button
          className={s.mobileOverlay}
          aria-label="Navigation schließen"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`${s.sidebar} ${mobileMenu ? s.sidebarOpen : ''}`}>
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
            <Printer size={23} />
          </span>
          openwebprint<span className={s.brandDot}>.</span>
        </a>
        <span className={s.workspaceLabel}>DEIN WORKSPACE</span>
        <nav aria-label="Hauptnavigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`${s.navItem} ${view === id ? s.navActive : ''}`}
              onClick={() => go(id)}
              aria-current={view === id ? 'page' : undefined}
            >
              <Icon size={19} />
              {label}
              {id === 'jobs' && !!activeJobs.length && (
                <span className={s.navCount}>{activeJobs.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className={s.sidebarBottom}>
          <div className={s.localCard}>
            <span className={s.localIcon}>
              <ShieldCheck size={20} />
            </span>
            <strong>Dein Server. Deine Daten.</strong>
            <p>
              Keine Cloud. Keine Umwege.
              <br />
              Einfach unter deiner Kontrolle.
            </p>
            <a
              href="https://github.com/Florian-Cullmann/openwebprint"
              target="_blank"
              rel="noreferrer"
            >
              Open Source entdecken <ArrowRight size={14} />
            </a>
          </div>
          <button
            className={`${s.navItem} ${view === 'settings' ? s.navActive : ''}`}
            onClick={() => go('settings')}
          >
            <Settings2 size={19} />
            Einstellungen
          </button>
          <div className={s.userRow}>
            <span className={s.avatar}>{session.username?.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{session.username}</strong>
              <span>Administrator</span>
            </div>
            <button
              className={s.iconButton}
              title="Abmelden"
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
      </aside>
      <div className={s.mainWrap}>
        <header className={s.topbar}>
          <div className={s.breadcrumb}>
            <button
              className={`${s.iconButton} ${s.mobileMenuButton}`}
              aria-label="Navigation öffnen"
              onClick={() => setMobileMenu(true)}
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {view === 'settings' ? 'Einstellungen' : navigation.find((n) => n.id === view)?.label}
            </strong>
          </div>
          <div className={s.topbarRight}>
            <span className={s.serverLabel}>
              <span className={s.dot} /> Selbst gehostet
            </span>
            <span className={s.topbarDivider} />
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
          </div>
        </header>
        <main className={s.main}>
          {demo && (
            <div className={s.demoBanner}>
              <Sparkles size={17} />
              <p>
                <strong>Einfach ausprobieren.</strong> Du bist im Demo-Modus. Alle Geräte und
                Hardwarevorgänge sind simuliert.
              </p>
              <button onClick={() => go('settings')}>
                Zum Hardwarebetrieb <ArrowRight size={15} />
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
              <span className={s.eyebrow}>
                {view === 'overview' ? 'WILLKOMMEN IN DEINEM WORKSPACE' : 'DEIN WORKFLOW'}
              </span>
              <h1>
                {view === 'overview'
                  ? 'Weniger Umwege. Mehr erledigt.'
                  : view === 'devices'
                    ? 'Meine Geräte'
                    : view === 'jobs'
                      ? 'Alle Aufträge'
                      : view === 'scans'
                        ? 'Meine Scans'
                        : 'Alles nach deinen Regeln.'}
              </h1>
              <p>{subtitle[view]}</p>
            </div>
            {view === 'devices' ? (
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
            ) : (
              <span className={s.date}>
                {new Intl.DateTimeFormat('de-DE', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                }).format(new Date())}
              </span>
            )}
          </div>
          {!snapshot ? (
            <div className={s.loading}>
              <Spinner />
              <p>Dein Workspace wird geladen …</p>
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
                  <section className={s.hero}>
                    <div className={s.heroCopy}>
                      <span className={s.heroKicker}>
                        <Zap size={14} /> BEREIT, WENN DU ES BIST
                      </span>
                      <h2>
                        Ein Dokument.
                        <br />
                        Viele Möglichkeiten.
                      </h2>
                      <p>
                        Drucken oder scannen? Mach es dir einfach.
                        <br />
                        Dein nächster Schritt ist nur einen Klick entfernt.
                      </p>
                      <div className={s.heroActions}>
                        <button className={s.primary} onClick={() => openPrint()}>
                          <Printer size={18} /> Dokument drucken <ArrowRight size={16} />
                        </button>
                        <button className={s.heroSecondary} onClick={() => openScan()}>
                          <ScanLine size={18} /> Scannen
                        </button>
                      </div>
                    </div>
                    <div className={s.heroArt} aria-hidden="true">
                      <div className={s.artOrbit} />
                      <div className={s.artSheet}>
                        <div className={s.artSheetHead} />
                        <span />
                        <span />
                        <span />
                        <div className={s.artChart}>
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                        </div>
                        <div className={s.artSheetFoot} />
                      </div>
                      <div className={s.artPrinter}>
                        <div className={s.artPrinterSlot} />
                        <div className={s.artPrinterLed} />
                        <Printer size={64} strokeWidth={0.8} />
                      </div>
                      <span className={s.artCheck}>
                        <Check size={23} />
                      </span>
                      <span className={s.artSpark}>✦</span>
                    </div>
                  </section>
                  <div className={s.stats}>
                    <Stat
                      icon={<Printer size={22} />}
                      label="Drucker"
                      value={devices.filter((d) => d.kind === 'printer').length}
                      detail="In deinem Workspace"
                    />
                    <Stat
                      icon={<ScanLine size={22} />}
                      label="Scanner"
                      value={devices.filter((d) => d.kind === 'scanner').length}
                      detail="Für deine Dokumente"
                    />
                    <Stat
                      icon={<Clock3 size={22} />}
                      label="Offene Aufträge"
                      value={activeJobs.length}
                      detail="Aktiv oder Status ungeklärt"
                    />
                    <Stat
                      icon={<CheckCircle2 size={22} />}
                      label="Abgeschlossen"
                      value={jobs.filter((j) => j.status === 'completed').length}
                      detail="In den letzten 200 Aufträgen"
                    />
                  </div>
                  <div className={s.sectionHeading}>
                    <div>
                      <h2>
                        Deine Geräte<span className={s.counter}>{devices.length}</span>
                      </h2>
                      <p>Alles verbunden. Alles an einem Ort.</p>
                    </div>
                    <button className={s.textButton} onClick={() => go('devices')}>
                      Alle Geräte <ArrowRight size={16} />
                    </button>
                  </div>
                  {devices.length ? (
                    <div className={s.deviceGrid}>
                      {devices.slice(0, 3).map((d) => (
                        <DeviceCard
                          key={d.id}
                          device={d}
                          run={() => (d.kind === 'printer' ? openPrint(d.id) : openScan(d.id))}
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<Printer />}
                      title="Dein erster Anschluss."
                      action={
                        <button className={s.primary} onClick={() => setDialog({ type: 'device' })}>
                          <Plus size={16} /> Gerät hinzufügen
                        </button>
                      }
                    >
                      Füge deinen Drucker oder Scanner hinzu und leg los.
                    </Empty>
                  )}
                  <div className={s.sectionHeading}>
                    <div>
                      <h2>Zuletzt passiert</h2>
                      <p>Deine Druck- und Scanaktivitäten.</p>
                    </div>
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
                  <div className={s.tip}>
                    <span>
                      <ShieldCheck size={22} />
                    </span>
                    <p>
                      <strong>Deine Dokumente bleiben deine Dokumente.</strong> Uploads werden nach
                      der Druckübertragung entfernt. Scans bleiben maximal 7 Tage auf deinem Server.
                    </p>
                    <span className={s.tipBadge}>LOCAL FIRST</span>
                  </div>
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
                  <div className={s.deviceGrid}>
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
                    Die letzten 200 Aufträge werden angezeigt. „Status ungeklärt“ bedeutet, dass
                    keine verlässliche Bestätigung vorliegt. Prüfe CUPS, bevor du erneut druckst.
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
                                <a
                                  className={s.secondary}
                                  href={`/api/jobs/${job.id}/pdf`}
                                  download
                                >
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
                      title="Hier beginnt dein papierloser Schreibtisch."
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
                    <span className={`${s.badge} ${demo ? s.amber : s.green}`}>
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
                  <SettingsCard icon={<Sun size={20} />} title="Mach es dir angenehm">
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
                  <SettingsCard icon={<Printer size={20} />} title="Brother? Von Anfang an dabei.">
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
                  <SettingsCard icon={<ShieldCheck size={20} />} title="Unter deiner Kontrolle">
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
                  <SettingsCard icon={<Github size={20} />} title="Offen für deine Ideen.">
                    <p>
                      openwebprint ist freie Software unter der MIT-Lizenz. Neue Provider, bessere
                      Geräteunterstützung oder eine kleine UX-Verbesserung: Beiträge sind
                      willkommen.
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
            <span>
              <span className={s.footerMark}>o.</span> Mit Offenheit gebaut. Für deinen Alltag.
            </span>
            <span>
              openwebprint <span>v0.1.0</span>
              <a
                href="https://github.com/Florian-Cullmann/openwebprint/blob/main/LICENSE"
                target="_blank"
                rel="noreferrer"
              >
                MIT-Lizenz <ArrowRight size={12} />
              </a>
            </span>
          </footer>
        </main>
      </div>
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
function Stat({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className={s.stat}>
      <div className={s.statTop}>
        <span>{label}</span>
        {icon}
      </div>
      <strong>
        {value}
        <span>{detail}</span>
      </strong>
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
    <article className={s.deviceCard}>
      <div className={s.deviceCardTop}>
        <DeviceIcon kind={device.kind} />
        <DeviceBadge device={device} />
      </div>
      <h3>{device.name}</h3>
      <p>
        {device.location || 'Kein Standort'}
        <span>·</span>
        {device.kind === 'printer' ? 'Drucker' : 'Scanner'}
      </p>
      {details && (
        <div className={s.deviceDetails}>
          <code>{device.address}</code>
          <span>
            {device.provider === 'demo'
              ? 'Simulierter Demo-Provider'
              : device.provider === 'cups'
                ? 'CUPS / IPP'
                : 'SANE'}
            {device.capabilities?.duplex ? ' · Duplex' : ''}
            {device.capabilities?.color ? ' · Farbe' : ''}
          </span>
          <span>{device.detail}</span>
        </div>
      )}
      <div className={s.deviceCardBottom}>
        <span className={s.deviceType}>
          {device.mode === 'demo' ? 'DEMO' : device.kind === 'printer' ? 'CUPS / IPP' : 'SANE'}
          <span className={s.dot} />
        </span>
        <div>
          {remove && (
            <button
              className={s.iconButton}
              aria-label={`${device.name} entfernen`}
              onClick={remove}
            >
              <Trash2 size={16} />
            </button>
          )}
          <button className={s.textButton} onClick={run}>
            {device.kind === 'printer' ? 'Drucken' : 'Scannen'}
            <ArrowRight size={16} />
          </button>
        </div>
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
      <Empty icon={<ListOrdered />} title="Ein frischer Start.">
        Deine Druck- und Scanaufträge erscheinen hier, sobald du loslegst.
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
