import { t, displayJobTitle, jobError, useLanguage, getLocale, formatNumber, plural } from './i18n';
import { LanguagePicker } from './LanguagePicker';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  FileText,
  Github,
  LayoutDashboard,
  LayoutGrid,
  List,
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
import type { Device, Job, JobFilter, SessionInfo, Snapshot } from '@openwebprint/shared';
import { Link, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Brand } from './Brand';
import { SetupScreen } from './SetupScreen';
import { StorageSettings } from './StorageSettings';
import { RetentionSettings } from './RetentionSettings';
import { JobPreviewDialog } from './JobPreviewDialog';
import { JobHistory } from './JobHistory';
import { UsersSettings } from './UsersSettings';
import { api, post } from './api';
import { AuthScreen } from './AuthScreen';
import { DeviceDialog } from './DeviceDialog';
import { PrintDialog } from './PrintDialog';
import { ScanDialog } from './ScanDialog';
import { DeviceBadge, DeviceIcon, Empty, JobBadge, Modal, Spinner } from './ui';
import s from './App.module.css';

type View = 'overview' | 'devices' | 'jobs' | 'scans' | 'settings';
type Dialog =
  | { type: 'print' | 'scan'; deviceId?: string; job?: Job }
  | { type: 'device' }
  | { type: 'document'; job: Job };
const navigation: { id: View; label: string; icon: typeof Printer }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'devices', label: 'Devices', icon: Printer },
  { id: 'jobs', label: 'Jobs', icon: ListOrdered },
  { id: 'scans', label: 'Scans', icon: ScanLine },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];
const formatDate = (date: string) =>
  new Intl.DateTimeFormat(getLocale(), {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
const completed = new Set(['completed', 'canceled', 'failed']);
export function App() {
  const language = useLanguage();
  const [session, setSession] = useState<SessionInfo>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const location = useLocation();
  const navigate = useNavigate();
  const view = location.pathname.split('/')[1] as View;
  const settingsCategory = location.pathname.split('/')[2] ?? 'general';
  const canAccess =
    !!session &&
    !session.onboardingRequired &&
    (!session.authenticationRequired || session.authenticated);
  const [dialog, setDialog] = useState<Dialog>();
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [jobFilter, setJobFilter] = useState<JobFilter>('all');
  const [historyRevision, setHistoryRevision] = useState(0);
  const [scanLayout, setScanLayout] = useState<'grid' | 'list'>(() =>
    localStorage.getItem('owp-scan-layout') === 'list' ? 'list' : 'grid',
  );
  const [deleting, setDeleting] = useState<{ device?: Device; job?: Job }>();
  const [theme, setTheme] = useState(() => localStorage.getItem('owp-theme') ?? 'system');
  const [dark, setDark] = useState(
    () =>
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
  const refreshing = useRef(false);
  useEffect(() => {
    localStorage.setItem('owp-scan-layout', scanLayout);
  }, [scanLayout]);
  useEffect(() => {
    setDialog(undefined);
    setQuery('');
    setJobFilter('all');
  }, [location.pathname]);
  useEffect(() => {
    const labels: Record<string, string> = {
      general: 'General',
      users: 'Users',
      appearance: 'Appearance',
      hardware: 'Hardware',
      login: 'Sign in',
      setup: 'Setup',
    };
    document.title = `openwebprint · ${location.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => t(labels[part] ?? navigation.find((item) => item.id === part)?.label ?? part))
      .join(' / ')}`;
  }, [location.pathname, language]);
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
      setDark(document.documentElement.dataset.theme === 'dark');
    };
    apply();
    localStorage.setItem('owp-theme', theme);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  const refresh = useCallback(async (updateHistory = true) => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setSnapshot(await api<Snapshot>('/snapshot'));
      if (updateHistory) setHistoryRevision((value) => value + 1);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refreshing.current = false;
    }
  }, []);
  useEffect(() => {
    if (!canAccess) return;
    void refresh(false);
    const timer = setInterval(() => {
      if (!document.hidden) void refresh(false);
    }, 5000);
    return () => clearInterval(timer);
  }, [canAccess, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function action(operation: () => Promise<unknown>, message: string, updateSnapshot = true) {
    setBusy(true);
    try {
      await operation();
      setToast(message);
      if (updateSnapshot) await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function go(next: View) {
    navigate(`/${next}`);
    setQuery('');
    setJobFilter('all');
  }
  if (!session)
    return (
      <div className={s.loading}>
        <Brand />
        {error ? (
          <>
            <p role="alert">{t(error)}</p>
            <button
              className={s.secondary}
              onClick={() => void loadSession().catch((e) => setError(e.message))}
            >
              {t('Reconnect')}
            </button>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    );
  if (session.authenticationRequired && !session.authenticated) {
    if (location.pathname !== '/login')
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    return <AuthScreen demo={session.mode === 'demo'} done={loadSession} />;
  }
  if (session.onboardingRequired) {
    if (location.pathname !== '/setup') return <Navigate to="/setup" replace />;
    return <SetupScreen changed={loadSession} />;
  }
  if (location.pathname === '/setup') return <Navigate to="/overview" replace />;
  if (location.pathname === '/login') {
    const from = (location.state as { from?: string } | null)?.from;
    return (
      <Navigate
        to={
          from &&
          [
            'overview',
            'devices',
            'jobs',
            'scans',
            'settings',
            'settings/general',
            'settings/users',
            'settings/appearance',
            'settings/hardware',
          ].some((page) => from === `/${page}`)
            ? from
            : '/overview'
        }
        replace
      />
    );
  }
  const demo = session.mode === 'demo';
  const devices = snapshot?.devices ?? [];
  const jobs = snapshot?.jobs ?? [];
  const activeJobs = jobs.filter((j) => !completed.has(j.status));
  const subtitle = {
    overview: t('Print and scan documents.'),
    devices: t('Manage printers and scanners.'),
    jobs: t('Track print and scan jobs.'),
    scans: t('Preview scans and download PDFs.'),
    settings: t('Manage users, appearance and hardware.'),
  };
  const openPrint = (deviceId?: string) => setDialog({ type: 'print', deviceId });
  const openScan = (deviceId?: string, job?: Job) => setDialog({ type: 'scan', deviceId, job });
  const openPreview = (job: Job) =>
    job.kind === 'scan' &&
    (job.hasFile || job.recovery || ['queued', 'processing'].includes(job.status))
      ? openScan(job.deviceId, job)
      : setDialog({ type: 'document', job });
  return (
    <div className={s.app}>
      <header className={s.appHeader}>
        <div className={s.headerInner}>
          <Link className={s.brand} to="/overview" aria-label={t('openwebprint overview')}>
            <Brand />
          </Link>
          <nav className={s.navigation} aria-label={t('Main navigation')}>
            {navigation.map(({ id, label, icon: Icon }) => (
              <NavLink
                key={id}
                to={`/${id}`}
                className={`${s.navItem} ${view === id ? s.navActive : ''}`}
                onClick={() => {
                  setQuery('');
                  setJobFilter('all');
                  setDialog(undefined);
                }}
              >
                <Icon size={16} />
                {t(label)}
                {id === 'jobs' && !!activeJobs.length && (
                  <span className={s.navCount}>{formatNumber(activeJobs.length)}</span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className={s.headerActions}>
            <LanguagePicker />
            <button
              className={s.iconButton}
              title={t('Change color scheme')}
              aria-label={t('Change color scheme')}
              onClick={() => setTheme(dark ? 'light' : 'dark')}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {session.authenticated && (
              <button
                className={s.iconButton}
                title={t('Sign out: {value1}', { value1: session.user?.username })}
                aria-label={t('Sign out')}
                onClick={() =>
                  void post('/logout')
                    .then(async () => {
                      setSnapshot(undefined);
                      setDialog(undefined);
                      await loadSession();
                    })
                    .catch((e) => setError(e.message))
                }
              >
                <LogOut size={17} />
              </button>
            )}
          </div>
        </div>
      </header>
      <main className={s.main}>
        {demo && (
          <div className={s.demoBanner}>
            <span className={s.modeLabel}>{t('Demo mode')}</span>
            <p>{t('Devices, printing and scanning are simulated.')}</p>
            <button
              className={s.textButton}
              disabled={busy}
              onClick={() =>
                void action(
                  async () => {
                    await post('/onboarding/remove-demo');
                    setSnapshot(undefined);
                    setDialog(undefined);
                    await loadSession();
                  },
                  'Demo data removed.',
                  false,
                )
              }
            >
              {busy ? <Spinner /> : null}
              {t('Remove demo data')}
            </button>
          </div>
        )}
        {error && (
          <div className={s.errorBanner} role="alert">
            <AlertTriangle size={19} />
            <p>{t(error)}</p>
            <button
              className={s.iconButton}
              aria-label={t('Dismiss error')}
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
                ? t('Overview')
                : view === 'devices'
                  ? t('Devices')
                  : view === 'jobs'
                    ? t('All jobs')
                    : view === 'scans'
                      ? t('Scans')
                      : t('Settings')}
            </h1>
            <p>{subtitle[view]}</p>
          </div>
          <div className={s.pageActions}>
            {view === 'overview' ? (
              <>
                <button className={s.primary} onClick={() => openPrint()}>
                  <Printer size={17} />
                  {t('Print')}
                </button>
                <button className={s.secondary} onClick={() => openScan()}>
                  <ScanLine size={17} />
                  {t('Scan')}
                </button>
              </>
            ) : view === 'devices' ? (
              <button className={s.primary} onClick={() => setDialog({ type: 'device' })}>
                <Plus size={17} />
                {t('Add device')}
              </button>
            ) : view === 'jobs' ? (
              <button className={s.primary} onClick={() => openPrint()}>
                <Plus size={17} />
                {t('Print')}
              </button>
            ) : view === 'scans' ? (
              <button className={s.primary} onClick={() => openScan()}>
                <ScanLine size={17} />
                {t('New scan')}
              </button>
            ) : null}
          </div>
        </div>
        {!snapshot ? (
          <div className={s.loading}>
            <Spinner />
            <p>{t('Loading devices and jobs…')}</p>
          </div>
        ) : (
          <>
            {snapshot.warnings.map((w) => (
              <p className={s.warning} key={t(w)}>
                <AlertTriangle size={16} />
                {t(w)}
              </p>
            ))}
            {view === 'overview' && (
              <>
                <section aria-labelledby="devices-title">
                  <div className={s.sectionHeading}>
                    <h2 id="devices-title">
                      {t('Devices')}
                      <span className={s.counter}>{formatNumber(devices.length)}</span>
                    </h2>
                    <button className={s.textButton} onClick={() => setDialog({ type: 'device' })}>
                      <Plus size={16} />
                      {t('Add device')}
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
                    <Empty icon={<Printer />} title={t('No devices yet')}>
                      {t('Add a printer or scanner.')}
                    </Empty>
                  )}
                  {devices.length > 3 && (
                    <button className={s.moreDevices} onClick={() => go('devices')}>
                      {t('Show all {value1} devices', { value1: devices.length })}
                      <ArrowRight size={15} />
                    </button>
                  )}
                </section>
                <section aria-labelledby="activity-title">
                  <div className={s.sectionHeading}>
                    <h2 id="activity-title">{t('Recent jobs')}</h2>
                    <button className={s.textButton} onClick={() => go('jobs')}>
                      {t('All jobs')}
                      <ArrowRight size={16} />
                    </button>
                  </div>
                  <JobList
                    jobs={jobs.slice(0, 5)}
                    busy={busy}
                    cancel={(id) => void action(() => post(`/jobs/${id}/cancel`), 'Job canceled.')}
                    preview={openPreview}
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
                      aria-label={t('Search devices')}
                      placeholder={t('Search devices…')}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <button className={s.secondary} onClick={() => setDialog({ type: 'device' })}>
                    <Radar size={16} />
                    {t('Search network')}
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
                    title={query ? t('No matching devices') : t('No devices yet')}
                  >
                    {query
                      ? t('Try another search term.')
                      : t('Search the network or add a device manually.')}
                  </Empty>
                )}
                <p className={s.footnote}>
                  {t(
                    'Printer status is reported by CUPS and does not confirm physical connectivity. Scanners are contacted when a scan starts.',
                  )}
                </p>
              </>
            )}
            {view === 'jobs' && (
              <>
                <div className={s.toolbar}>
                  <div className={s.tabs}>
                    {[
                      ['all', t('All jobs')],
                      ['active', t('Active')],
                      ['completed', t('Completed')],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={jobFilter === id ? s.activeTab : ''}
                        onClick={() => setJobFilter(id as JobFilter)}
                      >
                        {t(label)}
                      </button>
                    ))}
                  </div>
                  <button
                    className={s.secondary}
                    disabled={busy}
                    onClick={() => void action(refresh, 'Status updated.', false)}
                  >
                    <RefreshCw size={16} />
                    {t('Refresh')}
                  </button>
                </div>
                <JobHistory key={jobFilter} filter={jobFilter} revision={historyRevision}>
                  {(history) => (
                    <JobList
                      jobs={history}
                      busy={busy}
                      cancel={(id) =>
                        void action(() => post(`/jobs/${id}/cancel`), 'Job canceled.')
                      }
                      preview={openPreview}
                      remove={(job) => setDeleting({ job })}
                    />
                  )}
                </JobHistory>
                <p className={s.footnote}>
                  {t(
                    'Unknown status means the result could not be confirmed. Check CUPS before printing again.',
                  )}
                </p>
              </>
            )}
            {view === 'scans' && (
              <>
                <div className={s.toolbar}>
                  <div className={s.tabs} role="group" aria-label={t('Scan view')}>
                    {(
                      [
                        ['grid', t('Grid view'), LayoutGrid],
                        ['list', t('List view'), List],
                      ] as const
                    ).map(([layout, label, Icon]) => (
                      <button
                        key={layout}
                        aria-pressed={scanLayout === layout}
                        className={scanLayout === layout ? s.activeTab : ''}
                        onClick={() => setScanLayout(layout)}
                      >
                        <Icon size={16} /> {t(label)}
                      </button>
                    ))}
                  </div>
                  <span className={s.small}>{t('30 scans per page')}</span>
                </div>
                <JobHistory kind="scan" revision={historyRevision}>
                  {(scans) => (
                    <>
                      {scans.length && scanLayout === 'list' ? (
                        <JobList
                          jobs={scans}
                          busy={busy}
                          scanList
                          preview={openPreview}
                          remove={(job) => setDeleting({ job })}
                        />
                      ) : scans.length ? (
                        <div className={s.scanGrid}>
                          {scans.map((job) => (
                            <article className={s.scanCard} key={job.id}>
                              <button
                                className={s.scanThumb}
                                disabled={
                                  !job.hasFile &&
                                  !job.recovery &&
                                  !['queued', 'processing'].includes(job.status)
                                }
                                onClick={() => openScan(job.deviceId, job)}
                                aria-label={t('Open scan preview: {value1}', {
                                  value1: displayJobTitle(job),
                                })}
                              >
                                {job.hasFile ? (
                                  <img
                                    src={`/api/jobs/${job.id}/preview?page=${encodeURIComponent(JSON.stringify(job.pages?.[0] ?? job.scanRevision ?? job.updatedAt))}`}
                                    alt={t('Scanned page')}
                                    loading="lazy"
                                    decoding="async"
                                  />
                                ) : (
                                  <ScanLine size={44} strokeWidth={1} />
                                )}
                              </button>
                              <div className={s.scanCardBody}>
                                <JobBadge status={job.status} />
                                <h3>{displayJobTitle(job)}</h3>
                                <p>{job.deviceName}</p>
                                <span className={s.small}>{formatDate(job.createdAt)}</span>
                                {job.error && <p className={s.error}>{jobError(job)}</p>}
                                <div className={s.scanCardActions}>
                                  {job.hasFile ? (
                                    <a
                                      className={s.secondary}
                                      href={`/api/jobs/${job.id}/pdf`}
                                      download
                                    >
                                      <ArrowDownToLine size={16} />
                                      {t('Save PDF')}
                                    </a>
                                  ) : (
                                    <span className={s.small}>
                                      {job.status === 'completed'
                                        ? t('File already deleted')
                                        : t('No file yet')}
                                    </span>
                                  )}
                                  <button
                                    className={s.iconButton}
                                    disabled={!completed.has(job.status)}
                                    aria-label={t('Delete scan: {value1}', {
                                      value1: displayJobTitle(job),
                                    })}
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
                          title={t('No scans yet')}
                          action={
                            <button className={s.primary} onClick={() => openScan()}>
                              <ScanLine size={17} />
                              {t('Start first scan')}
                            </button>
                          }
                        >
                          {t('Scan a page and download it as a PDF.')}
                        </Empty>
                      )}
                    </>
                  )}
                </JobHistory>
              </>
            )}
            {view === 'settings' && (
              <div className={s.settingsGrid}>
                <nav className={s.settingsNav} aria-label={t('Settings categories')}>
                  {['general', 'users', 'appearance', 'hardware'].map((category) => (
                    <NavLink
                      key={category}
                      to={`/settings/${category}`}
                      className={({ isActive }) => (isActive ? s.settingsTabActive : s.settingsTab)}
                    >
                      {t(category.charAt(0).toUpperCase() + category.slice(1))}
                    </NavLink>
                  ))}
                </nav>
                <div className={s.settingsContent}>
                  {settingsCategory === 'general' && (
                    <>
                      <SettingsCard icon={<Settings2 size={20} />} title={t('Operating mode')}>
                        <span className={`${s.badge} ${demo ? s.amber : s.positive}`}>
                          {demo ? t('Demo mode enabled') : t('Hardware mode enabled')}
                        </span>
                        <p>
                          {demo
                            ? t(
                                'Devices, print jobs and scan samples are simulated. No real hardware is contacted.',
                              )
                            : t(
                                'Devices are accessed through CUPS and SANE. Status and errors come from actual operations.',
                              )}
                        </p>
                        <p>
                          {demo
                            ? t(
                                'Use Remove demo data to delete simulated devices, jobs and scan files and begin hardware setup.',
                              )
                            : t(
                                'Your devices are configured through the setup flow and managed on the Devices page.',
                              )}
                        </p>
                      </SettingsCard>
                      <StorageSettings demo={demo} />
                      <RetentionSettings />
                      <SettingsCard
                        icon={<ShieldCheck size={20} />}
                        title={t('Documents and access')}
                      >
                        <p>
                          {t(
                            'Sessions last 7 days. Document files follow the retention periods above, or are removed earlier when you delete their jobs.',
                          )}
                        </p>
                        <p>
                          {t(
                            'CUPS has its own spool and retention rules. Use HTTPS and secure cookies for network access.',
                          )}
                        </p>
                        <a
                          className={s.textButton}
                          href="https://github.com/Florian-Cullmann/openwebprint#self-hosting"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('Self-hosting documentation')}
                          <ArrowRight size={16} />
                        </a>
                      </SettingsCard>
                      <SettingsCard icon={<Github size={20} />} title={t('About openwebprint')}>
                        <p>
                          {t(
                            'openwebprint is free software under the MIT license. Contributions to providers, hardware support and user experience are welcome.',
                          )}
                        </p>
                        <a
                          className={s.secondary}
                          href="https://github.com/Florian-Cullmann/openwebprint"
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Github size={17} />
                          {t('View repository')}
                        </a>
                        <span className={s.small}>
                          {t('Version 0.1.0 · React + Fastify + CUPS + SANE')}
                        </span>
                      </SettingsCard>
                    </>
                  )}
                  {settingsCategory === 'users' && (
                    <UsersSettings session={session} changed={loadSession} />
                  )}
                  {settingsCategory === 'appearance' && (
                    <>
                      <SettingsCard icon={<Sun size={20} />} title={t('Appearance')}>
                        <p>{t('Choose the appearance for this browser.')}</p>
                        <div className={s.themePicker}>
                          {[
                            ['light', t('Light'), Sun],
                            ['dark', t('Dark'), Moon],
                            ['system', t('System'), Monitor],
                          ].map(([id, label, Icon]) => {
                            const ThemeIcon = Icon as typeof Sun;
                            return (
                              <button
                                key={String(id)}
                                className={theme === id ? s.themeActive : ''}
                                onClick={() => setTheme(String(id))}
                              >
                                <ThemeIcon size={23} />
                                {t(String(label))}
                              </button>
                            );
                          })}
                        </div>
                      </SettingsCard>
                    </>
                  )}
                  {settingsCategory === 'hardware' && (
                    <>
                      <SettingsCard icon={<Printer size={20} />} title={t('Printers and scanners')}>
                        <p>
                          {t(
                            'Compatible printers connect to CUPS through IPP Everywhere / AirPrint. Scanners connect through SANE, including eSCL or WSD via sane-airscan where supported by the model.',
                          )}
                        </p>
                        <p>
                          {t(
                            'Older models need a suitable CUPS/SANE driver on the host. Import existing queues using',
                          )}{' '}
                          <code>cups://NAME</code>{' '}
                          {t(
                            'as the address. Model compatibility requires a physical hardware test.',
                          )}
                        </p>
                      </SettingsCard>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        <footer className={s.footer}>
          <a
            href="https://github.com/Florian-Cullmann/openwebprint"
            target="_blank"
            rel="noreferrer"
          >
            {t('GitHub')}
            <ArrowRight size={12} />
          </a>
        </footer>
      </main>
      {toast && (
        <div className={s.toast} role="status">
          <CheckCircle2 size={19} />
          {t(toast)}
          <button
            className={s.iconButton}
            aria-label={t('Dismiss notification')}
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
          source={dialog.job}
          demo={demo}
          close={() => setDialog(undefined)}
          changed={() => void refresh()}
        />
      )}
      {dialog?.type === 'document' && (
        <JobPreviewDialog
          job={dialog.job}
          close={() => setDialog(undefined)}
          print={(job) => setDialog({ type: 'print', job })}
        />
      )}
      {dialog?.type === 'scan' && (
        <ScanDialog
          devices={devices}
          initial={dialog.deviceId}
          existing={dialog.job}
          print={(job) => setDialog({ type: 'print', job })}
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
          title={deleting.device ? t('Remove device?') : t('Delete job and files?')}
          subtitle={
            deleting.device?.name ?? (deleting.job ? displayJobTitle(deleting.job) : undefined)
          }
          close={() => {
            if (!busy) setDeleting(undefined);
          }}
        >
          <div className={s.modalBody}>
            <p>
              {deleting.device
                ? t(
                    'The device will be removed from openwebprint. Its CUPS queue and configuration will remain.',
                  )
                : t(
                    'The record and any stored scan files will be deleted. Unconfirmed print jobs may still be active in CUPS. Check the queue; deleting a record does not cancel printing.',
                  )}
            </p>
            <div className={s.modalActions}>
              <button
                className={s.secondary}
                disabled={busy}
                onClick={() => setDeleting(undefined)}
              >
                {t('Keep')}
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
                  }, 'Record removed.')
                }
              >
                {busy ? <Spinner /> : <Trash2 size={16} />}{' '}
                {deleting.device ? t('Remove device') : t('Delete')}
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
          {device.kind === 'printer' ? t('Printer') : t('Scanner')}
          {device.location ? ` · ${device.location}` : ''}
        </p>
        {details && (
          <details className={s.deviceDetails}>
            <summary>{t('Connection details')}</summary>
            <code>{device.address}</code>
            <p>
              {device.provider === 'demo'
                ? t('Demo-Provider')
                : device.provider === 'cups'
                  ? t('CUPS / IPP')
                  : t('SANE')}
              {device.capabilities?.sides?.some((side) => side !== 'one-sided')
                ? t(' · Duplex')
                : ''}
              {device.capabilities?.color ? t('  · Color') : ''}
            </p>
            {device.detail && <p>{t(device.detail)}</p>}
          </details>
        )}
      </div>
      <div className={s.deviceControls}>
        <DeviceBadge device={device} />
        <button className={s.secondary} onClick={run}>
          {device.kind === 'printer' ? t('Print') : t('Scan')}
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
  scanList = false,
}: {
  jobs: Job[];
  cancel?: (id: string) => void;
  preview: (job: Job) => void;
  remove?: (job: Job) => void;
  busy: boolean;
  scanList?: boolean;
}) {
  if (!jobs.length)
    return (
      <Empty icon={<ListOrdered />} title={t('No jobs yet')}>
        {t('Print jobs and scans will appear here.')}
      </Empty>
    );
  return (
    <div className={s.jobTableWrap}>
      <table className={s.jobTable}>
        <thead>
          <tr>
            <th>{t('Document')}</th>
            <th>{t('Device')}</th>
            <th>{t('Status')}</th>
            <th>{t('Date')}</th>
            <th>
              <span className={s.srOnly}>{t('Actions')}</span>
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
                    <button className={s.documentTitle} onClick={() => preview(job)}>
                      {displayJobTitle(job)}
                    </button>
                    <span>
                      {job.mode === 'demo' ? t('Demo · ') : ''}
                      {job.kind === 'print' ? t('Print job') : t('Scan')}
                      {job.kind === 'print' && 'copies' in job.options
                        ? ` · ${plural('{count} Copy', '{count} Copies', job.options.copies)}`
                        : ''}
                      {scanList && !job.hasFile
                        ? job.status === 'completed'
                          ? t(' · File already deleted')
                          : t(' · No file yet')
                        : ''}
                    </span>
                    {job.error && <p className={s.jobError}>{jobError(job)}</p>}
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
                  {cancel && job.kind === 'print' && !completed.has(job.status) && (
                    <button
                      className={s.iconButton}
                      disabled={busy}
                      title={t('Cancel job')}
                      aria-label={t('Cancel job: {value1}', { value1: displayJobTitle(job) })}
                      onClick={() => cancel(job.id)}
                    >
                      <X size={17} />
                    </button>
                  )}
                  {job.hasFile && (
                    <button
                      className={s.iconButton}
                      aria-label={t('Open preview: {value1}', { value1: displayJobTitle(job) })}
                      onClick={() => preview(job)}
                    >
                      <Search size={17} />
                    </button>
                  )}
                  {scanList && job.hasFile && (
                    <a
                      className={s.iconButton}
                      href={`/api/jobs/${job.id}/pdf`}
                      download
                      title={t('Save PDF')}
                      aria-label={t('Save PDF: {value1}', { value1: displayJobTitle(job) })}
                    >
                      <ArrowDownToLine size={17} />
                    </a>
                  )}
                  {remove && (completed.has(job.status) || job.status === 'unknown') && (
                    <button
                      className={s.iconButton}
                      disabled={busy}
                      aria-label={t('Delete {value1}: {value2}', {
                        value1: t(scanList ? 'scan' : 'job'),
                        value2: displayJobTitle(job),
                      })}
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
