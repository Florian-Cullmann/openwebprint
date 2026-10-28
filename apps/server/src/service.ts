import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, rm, readdir, chmod, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Device,
  DeviceInput,
  JobPage,
  Mode,
  PrintOptions,
  ProfileInput,
  SettingsProfile,
  AppliedProfile,
  ScanOptions,
  ScanPage,
  Snapshot,
} from '@openwebprint/shared';
import { MAX_SCAN_PAGES, printProfileError, scanProfileError } from '@openwebprint/shared';
import { AppError, missingDevice } from './errors.js';
import {
  Store,
  publicJob,
  storedScanPages,
  type JobPageOptions,
  type StoredJob,
  type StoredScanPage,
} from './store.js';
import type { Provider } from './providers/types.js';
import { demoDevices } from './providers/demo.js';
import {
  normalizeDocument,
  selectPrintPages,
  exportScanPages,
  renderScanPage,
  SCAN_THUMBNAIL_SIZE,
  validateScanImage,
} from './documents.js';
import { ScannerCapabilities } from './scan-capabilities.js';
import { expired, retentionPolicy } from './retention.js';

const terminal = new Set(['completed', 'canceled', 'failed']);
const DEVICE_STATUS_TTL = 5000;
// Version the key when the thumbnail format changes. Original page paths
// are immutable; document revision/order must not invalidate unchanged pages.
function thumbnailName(page: StoredScanPage) {
  const crop = page.crop;
  const key = [
    'png-v1',
    SCAN_THUMBNAIL_SIZE,
    page.id,
    page.path,
    page.rotation,
    crop && [crop.x, crop.y, crop.width, crop.height],
  ];
  return createHash('sha256').update(JSON.stringify(key)).digest('hex') + '.png';
}
type DeviceState = Pick<Snapshot, 'devices' | 'warnings' | 'devicesCheckedAt'>;
const remove = async (path?: string) => {
  if (path)
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT')
        throw new AppError(
          500,
          'Could not remove a document file. Check file permissions and try again.',
        );
    });
};
export class Service {
  readonly filesDir: string;
  private tasks = new Set<Promise<void>>();
  private activeJobs = new Set<string>();
  private activeScanners = new Set<string>();
  private activeScans = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private polling?: Promise<void>;
  private deviceCache?: { result: Promise<DeviceState>; expiresAt: number };
  private deviceInspections = new Set<Promise<DeviceState>>();
  private scannerCapabilities: ScannerCapabilities;
  private thumbnailTasks = new Map<string, Promise<Buffer>>();
  private removingFiles = new Set<string>();
  constructor(
    readonly store: Store,
    readonly mode: Mode,
    readonly provider: Provider,
    private scanDirectory = join(store.directory, 'files'),
  ) {
    this.filesDir = join(store.directory, 'files');
    this.scannerCapabilities = new ScannerCapabilities(store, mode, provider);
  }
  async initialize() {
    await mkdir(this.filesDir, { recursive: true, mode: 0o700 });
    for (const job of this.store.jobs(this.mode)) {
      if (!terminal.has(job.status) && (job.kind === 'scan' || !job.externalId)) {
        job.status = job.kind === 'scan' ? (job.hasFile ? 'completed' : 'failed') : 'unknown';
        job.error =
          'The server restarted during this operation. Check the device before trying again.';
        if (job.scanWorkPath) await rm(job.scanWorkPath, { recursive: true, force: true });
        job.scanWorkPath = undefined;
        if (!job.hasFile && !job.scanRecovery) await this.removeFiles(job);
        this.store.putJob(job);
      }
      if (job.kind === 'scan' && job.hasFile) await this.pruneThumbnails(job, true);
    }
    await this.expireFiles();
  }
  setScanDirectory(path: string) {
    this.scanDirectory = path;
  }
  async seedDemo() {
    if (this.mode !== 'demo' || this.store.setting('demo-seeded')) return;
    for (const input of demoDevices) await this.addDevice(input);
    this.store.set('demo-seeded', 'true');
  }
  expireFiles(): Promise<void> {
    // Share overlapping cleanup passes and drain them before shutdown/mode transitions.
    this.cleanup ??= this.cleanupFiles().finally(() => {
      this.cleanup = undefined;
    });
    return this.cleanup;
  }
  private cleanup?: Promise<void>;
  private async cleanupFiles() {
    for (const { id } of this.store.jobs(this.mode)) {
      const job = this.store.job(id, this.mode);
      if (
        job &&
        !this.activeJobs.has(job.id) &&
        (terminal.has(job.status) || (job.kind === 'print' && job.status === 'unknown')) &&
        expired(job, retentionPolicy(this.store)) &&
        (job.hasFile || job.scanRecovery)
      ) {
        // Lock synchronously before filesystem awaits so an edit/append cannot race deletion.
        this.activeJobs.add(job.id);
        try {
          await this.removeFiles(job);
          const current = this.store.job(job.id, this.mode);
          if (current) {
            this.clearFileReferences(current);
            this.store.putJob(current);
          }
        } finally {
          this.activeJobs.delete(job.id);
        }
      }
    }
  }
  publicJob(job: StoredJob) {
    return publicJob(job, retentionPolicy(this.store));
  }
  availableJob(id: string) {
    const job = this.job(id);
    if (!job.hasFile || expired(job, retentionPolicy(this.store)))
      throw new AppError(
        410,
        'This document has expired or was deleted. Upload it again or create a new scan.',
      );
    return job;
  }
  private thumbnailDirectory(id: string) {
    return join(this.filesDir, `${id}.thumbnails`);
  }
  scanThumbnail(id: string, pageId?: string): Promise<Buffer> {
    const job = this.job(id);
    if (job.kind !== 'scan' || !job.hasFile || this.removingFiles.has(id))
      throw new AppError(404, 'Page unavailable.');
    this.availableJob(id);
    const pages = storedScanPages(job);
    const page = pageId ? pages.find((page) => page.id === pageId) : pages[0];
    if (!page) throw new AppError(404, 'Page unavailable.');
    const name = thumbnailName(page);
    const key = `${id}/${name}`;
    const existing = this.thumbnailTasks.get(key);
    if (existing) return existing;
    const directory = this.thumbnailDirectory(id);
    const task = (async () => {
      const path = join(directory, name);
      try {
        return await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const { image } = await renderScanPage(page, true, true);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, image, { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await remove(temporary);
      }
      return image;
    })().finally(() => this.thumbnailTasks.delete(key));
    this.thumbnailTasks.set(key, task);
    return task;
  }
  private async drainThumbnails(id: string) {
    await Promise.allSettled(
      [...this.thumbnailTasks].filter(([key]) => key.startsWith(`${id}/`)).map(([, task]) => task),
    );
  }
  private async pruneThumbnails(job: StoredJob, removeTemporary = false) {
    // Publication already exposes the new pages. Drain old requests before
    // pruning so they cannot recreate obsolete variants after cleanup.
    await this.drainThumbnails(job.id);
    const directory = this.thumbnailDirectory(job.id);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const retained = new Set(storedScanPages(job).map(thumbnailName));
    await Promise.all(
      names
        // New requests may be writing valid variants after publication. Only
        // startup, before requests are accepted, can discard temporary files.
        .filter(
          (name) =>
            (name.endsWith('.png') && !retained.has(name)) ||
            (removeTemporary && name.endsWith('.tmp')),
        )
        .map((name) => remove(join(directory, name))),
    );
  }
  device(id: string) {
    const device = this.store.device(id, this.mode);
    if (!device) throw missingDevice();
    return device;
  }
  async addDevice(input: DeviceInput) {
    const existing = this.store.devices(this.mode).find((d) => d.address === input.address);
    if (existing) {
      if (existing.kind === 'scanner') await this.scannerCapabilities.warm(existing);
      return existing;
    }
    if (this.mode === 'demo' && !input.address.startsWith('demo://'))
      throw new AppError(
        400,
        'Only demo:// devices are allowed in demo mode. Remove demo data and start setup to use real devices.',
      );
    const device = await this.provider.add(input, randomUUID());
    this.store.putDevice(device);
    this.deviceCache = undefined;
    if (device.kind === 'scanner') await this.scannerCapabilities.warm(device);
    return device;
  }
  deleteDevice(id: string) {
    this.device(id);
    if (this.store.jobs(this.mode).some((j) => j.deviceId === id && !terminal.has(j.status)))
      throw new AppError(409, 'This device still has active or unconfirmed jobs.');
    this.store.deleteDevice(id, this.mode);
    this.scannerCapabilities.invalidate(id);
    this.deviceCache = undefined;
  }
  profiles(deviceId: string) {
    this.device(deviceId);
    return this.store.profiles(deviceId, this.mode);
  }
  private profile(deviceId: string, id: string) {
    const profile = this.profiles(deviceId).find((profile) => profile.id === id);
    if (!profile) throw new AppError(404, 'Settings profile not found.');
    return profile;
  }
  private async validateProfile(deviceId: string, input: ProfileInput) {
    const device = this.device(deviceId);
    if ((input.kind === 'print') !== (device.kind === 'printer'))
      throw new AppError(400, 'The profile kind does not match this device.');
    if (input.kind === 'print') {
      const inspected = await this.provider.inspect(device);
      const error = printProfileError(inspected.capabilities, input.options);
      if (error) throw new AppError(409, error);
    } else {
      // A saved capability cache cannot establish that an old profile still works.
      const sources = await this.scanSources(deviceId, input.options.source, true);
      const error = scanProfileError(sources, input.options);
      if (error) throw new AppError(409, error);
      return sources;
    }
  }
  async saveProfile(deviceId: string, input: ProfileInput, id?: string): Promise<SettingsProfile> {
    if (id) this.profile(deviceId, id);
    await this.validateProfile(deviceId, input);
    // Device/profile deletion may have happened while the provider was queried.
    const profiles = this.profiles(deviceId);
    if (id) this.profile(deviceId, id);
    else if (profiles.length >= 50)
      throw new AppError(409, 'This device already has 50 profiles. Delete a profile first.');
    const profile = { ...input, id: id ?? randomUUID(), deviceId };
    this.store.putProfile(profile);
    return profile;
  }
  async applyProfile(deviceId: string, id: string): Promise<AppliedProfile> {
    const profile = this.profile(deviceId, id);
    const scanSources = await this.validateProfile(deviceId, profile);
    this.device(deviceId);
    // Do not apply a profile that was changed or removed during capability discovery.
    if (JSON.stringify(this.profile(deviceId, id)) !== JSON.stringify(profile))
      throw new AppError(409, 'This profile changed. Select it again and retry.');
    return { profile, ...(scanSources ? { scanSources } : {}) };
  }
  deleteProfile(deviceId: string, id: string) {
    this.profile(deviceId, id);
    this.store.deleteProfile(id);
  }
  private deviceState(): Promise<DeviceState> {
    if (this.deviceCache && Date.now() < this.deviceCache.expiresAt) return this.deviceCache.result;
    const result = this.inspectDevices();
    // Pending checks stay shared even when the provider takes longer than the TTL.
    const entry = { result, expiresAt: Infinity };
    this.deviceCache = entry;
    this.deviceInspections.add(result);
    void result.then(
      () => {
        // Update only this entry: an intervening device change may have replaced it.
        entry.expiresAt = Date.now() + DEVICE_STATUS_TTL;
        this.deviceInspections.delete(result);
      },
      () => {
        if (this.deviceCache === entry) this.deviceCache = undefined;
        this.deviceInspections.delete(result);
      },
    );
    return result;
  }
  private async inspectDevices(): Promise<DeviceState> {
    const warnings: string[] = [];
    const devices = await Promise.all(
      this.store.devices(this.mode).map(async (device) => {
        try {
          return await this.provider.inspect(device);
        } catch {
          warnings.push(`${device.name}: Unable to determine device status.`);
          return {
            ...device,
            status: 'unknown' as const,
            capabilities: undefined,
            detail: 'Unable to determine device status.',
          };
        }
      }),
    );
    return { devices, warnings, devicesCheckedAt: new Date(Date.now()).toISOString() };
  }
  async snapshot(): Promise<Snapshot> {
    return {
      ...(await this.deviceState()),
      jobs: this.store.jobPage(this.mode, { limit: 200 }).map((job) => this.publicJob(job)),
      mode: this.mode,
    };
  }
  listJobs(options: JobPageOptions): JobPage {
    const rows = this.store.jobPage(this.mode, { ...options, limit: options.limit + 1 });
    const jobs = rows.slice(0, options.limit).map((job) => this.publicJob(job));
    const last = jobs.at(-1);
    return {
      jobs,
      ...this.store.jobStats(this.mode, options),
      ...(rows.length > options.limit && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                createdAt: last.createdAt,
                id: last.id,
                mode: this.mode,
                kind: options.kind,
                filter: options.filter ?? 'all',
              }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  private createJob(
    device: Device,
    kind: 'print' | 'scan',
    title: string,
    options: PrintOptions | ScanOptions,
  ): StoredJob {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      deviceId: device.id,
      deviceName: device.name,
      kind,
      title,
      options,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      mode: this.mode,
      hasFile: false,
    };
  }
  async print(deviceId: string, data: Buffer, mime: string, name: string, options: PrintOptions) {
    return this.submitPrint(deviceId, () => normalizeDocument(data, mime), name, options);
  }
  async document(id: string, revision?: string) {
    const job = this.availableJob(id);
    if (!job.filePath)
      throw new AppError(
        410,
        'This document has expired or was deleted. Upload it again or create a new scan.',
      );
    if (revision !== undefined && revision !== job.scanRevision)
      throw new AppError(
        409,
        'This scan has changed. Close this dialog and reopen it to review the latest document.',
      );
    try {
      return await readFile(job.filePath);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new AppError(
          410,
          'This document is no longer available. Upload it again or create a new scan.',
        );
      throw new AppError(
        503,
        'Cannot read the saved document. Check document storage permissions.',
      );
    }
  }
  async printSaved(id: string, deviceId: string, options: PrintOptions, revision?: string) {
    const source = this.store.job(id, this.mode);
    if (!source)
      throw new AppError(
        404,
        'The saved document was deleted or is unavailable in this mode. Upload it again or create a new scan.',
      );
    if (source.kind === 'scan' && source.status !== 'completed')
      throw new AppError(409, 'Wait for the scan to finish before printing it.');
    if (source.kind === 'scan' && revision !== source.scanRevision)
      throw new AppError(
        409,
        'This scan has changed. Close this dialog and reopen it to review the latest document.',
      );
    // Read a private snapshot before awaiting printer inspection. Deletion/expiration may
    // then remove the source, but can neither alter this submission nor resurrect it.
    const data = await this.document(id, revision);
    // Retained PDFs were already normalized or exported internally; the upload
    // size limit must not prevent printing a larger, server-generated scan.
    return this.submitPrint(deviceId, async () => data, source.title, options);
  }
  private async submitPrint(
    deviceId: string,
    document: () => Promise<Buffer>,
    name: string,
    options: PrintOptions,
  ) {
    let device = this.store.device(deviceId, this.mode);
    if (!device)
      throw new AppError(
        404,
        'This printer is no longer available. Select another printer or add one on the Devices page.',
      );
    if (device.kind !== 'printer') throw new AppError(400, 'The selected device is not a printer.');
    device = await this.provider.inspect(device);
    if (device.status === 'offline')
      throw new AppError(
        409,
        'This printer is offline. Check its connection or select another printer.',
      );
    const caps = device.capabilities;
    if (!caps)
      throw new AppError(409, 'Unable to retrieve print options. Check the CUPS connection.');
    if (!caps.sides)
      throw new AppError(
        409,
        'Unable to retrieve supported print sides. Check the CUPS connection.',
      );
    if (!caps.colorModes)
      throw new AppError(
        409,
        'Unable to retrieve supported print color modes. Check the CUPS connection.',
      );
    if (
      !caps.colorModes.includes(options.color) ||
      !caps.sides.includes(options.sides) ||
      !caps.media.includes(options.media)
    ) {
      throw new AppError(400, 'This device does not support the selected print options.');
    }
    const normalized = await selectPrintPages(await document(), options);
    const title = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 120) || 'Document';
    const job = this.createJob(device, 'print', title, options);
    job.filePath = join(this.filesDir, `${job.id}.pdf`);
    await writeFile(job.filePath, normalized, { mode: 0o600 });
    job.hasFile = true;
    this.store.putJob(job);
    this.activeJobs.add(job.id);
    try {
      // The PDF already contains the selection. Providers must not filter it again.
      const providerOptions = { ...options };
      delete providerOptions.pageRanges;
      delete providerOptions.pageParity;
      job.externalId = await this.provider.print(device, job.filePath, title, providerOptions);
    } catch (e) {
      // A transport failure may happen after CUPS accepted the job: never auto-retry.
      job.status = 'unknown';
      job.error = e instanceof Error ? e.message : 'Print submission failed.';
    } finally {
      this.activeJobs.delete(job.id);
      job.updatedAt = new Date().toISOString();
      this.store.putJob(job);
    }
    return this.publicJob(job);
  }
  async scanSources(deviceId: string, source?: string, refresh = false) {
    const device = this.device(deviceId);
    if (device.kind !== 'scanner') throw new AppError(400, 'The selected device is not a scanner.');
    if (this.activeScanners.has(deviceId))
      throw new AppError(409, 'This scanner is already in use.');
    return this.scannerCapabilities.get(device, source, refresh);
  }
  scan(deviceId: string, options: ScanOptions, jobId?: string) {
    const device = this.device(deviceId);
    if (device.kind !== 'scanner') throw new AppError(400, 'The selected device is not a scanner.');
    if (this.activeScanners.has(deviceId))
      throw new AppError(409, 'This scanner is already in use.');
    const job = jobId
      ? this.job(jobId)
      : this.createJob(device, 'scan', 'Scan · ' + new Date().toLocaleDateString('en-GB'), options);
    if (jobId) {
      if (job.scanRecovery)
        throw new AppError(409, 'Keep or discard recoverable pages before scanning again.');
      this.editableScan(job);
      if (job.deviceId !== deviceId)
        throw new AppError(400, 'Use the original scanner to add pages.');
    }
    if (storedScanPages(job).length >= MAX_SCAN_PAGES)
      throw new AppError(400, `A scan can contain at most ${MAX_SCAN_PAGES} pages.`);
    this.prepareScan(job);
    job.options = options;
    this.activeScanners.add(deviceId);
    const controller = new AbortController();
    const task = this.performScan(job, device, options, controller.signal).finally(() => {
      this.activeScans.delete(job.id);
      this.activeScanners.delete(deviceId);
      this.activeJobs.delete(job.id);
      this.tasks.delete(task);
    });
    this.activeScans.set(job.id, { controller, task });
    this.tasks.add(task);
    return this.publicJob(job);
  }
  private prepareScan(job: StoredJob) {
    job.scanDirectory ??= join(
      dirname(job.filePath ?? join(this.scanDirectory, `${job.id}.pdf`)),
      `${job.id}.pages`,
    );
    job.scanWorkPath = join(job.scanDirectory, randomUUID());
    job.status = 'processing';
    job.error = undefined;
    this.activeJobs.add(job.id);
    this.store.putJob(job);
  }
  private editableScan(job: StoredJob) {
    this.availableJob(job.id);
    if (
      job.kind !== 'scan' ||
      !job.hasFile ||
      job.status !== 'completed' ||
      !!job.scanRecovery ||
      this.activeJobs.has(job.id)
    )
      throw new AppError(409, 'Wait for a completed scan with available pages.');
  }
  private async publishScan(job: StoredJob, pages: StoredScanPage[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const filePath = join(job.scanWorkPath!, 'document.pdf');
    const previewPath = join(job.scanWorkPath!, 'preview.png');
    await exportScanPages(pages, filePath, previewPath);
    await chmod(previewPath, 0o600);
    // Publication is synchronous from this check through putJob. Cancellation
    // either discards the whole new operation or observes the committed result.
    signal?.throwIfAborted();
    const previousFiles = new Set([
      job.filePath,
      job.previewPath,
      ...storedScanPages(job).map((page) => page.path),
    ]);
    const published: StoredJob = {
      ...job,
      filePath,
      previewPath,
      scanPages: pages,
      scanRevision: randomUUID(),
      hasFile: true,
      status: 'completed',
      scanWorkPath: undefined,
      scanRecovery: undefined,
      updatedAt: new Date().toISOString(),
    };
    // Keep the previous revision intact until its replacement is durably stored.
    this.store.putJob(published);
    Object.assign(job, published);
    const retainedFiles = new Set([filePath, previewPath, ...pages.map((page) => page.path)]);
    const cleanup = await Promise.allSettled([
      ...[...previousFiles].filter((path) => path && !retainedFiles.has(path)).map(remove),
      this.pruneThumbnails(job),
    ]);
    // A cleanup failure must not turn a successfully saved edit into a failed request.
    if (cleanup.some((result) => result.status === 'rejected')) {
      job.error = [
        job.error,
        'The document was saved, but obsolete files could not be removed. Check scan storage permissions.',
      ]
        .filter(Boolean)
        .join(' ');
      this.store.putJob(job);
    }
  }
  private async failScan(job: StoredJob, error: unknown, signal?: AbortSignal) {
    // A cancel arriving while failed output is being decoded still discards it.
    if (signal?.aborted && job.scanRecovery) {
      job.scanWorkPath = job.scanRecovery.directory;
      job.scanRecovery = undefined;
    }
    if (job.scanWorkPath) await rm(job.scanWorkPath, { recursive: true, force: true });
    job.scanWorkPath = undefined;
    job.status = job.hasFile ? 'completed' : signal?.aborted ? 'canceled' : 'failed';
    job.error = signal?.aborted
      ? 'Scan canceled. New pages from this operation were discarded. Previously saved pages were kept.'
      : error instanceof Error
        ? error.message
        : 'Scan failed.';
    if (!job.hasFile && !job.scanRecovery) await this.removeFiles(job);
    job.updatedAt = new Date().toISOString();
    this.store.putJob(job);
  }
  private async performScan(
    job: StoredJob,
    device: Device,
    options: ScanOptions,
    signal: AbortSignal,
  ) {
    try {
      const directory = job.scanWorkPath!;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      await this.provider.scan(
        device,
        join(directory, options.batch ? 'page-%d.png' : 'page-1.png'),
        options,
        MAX_SCAN_PAGES - storedScanPages(job).length,
        signal,
      );
      signal.throwIfAborted();
      const files = (await readdir(directory))
        .filter((name) => /^page-[1-9]\d*\.png$/.test(name))
        .sort((a, b) => Number(a.slice(5, -4)) - Number(b.slice(5, -4)));
      const pages = [...storedScanPages(job)];
      if (!files.length)
        throw new AppError(422, 'No pages were scanned. Load paper and try again.');
      if (pages.length + files.length > MAX_SCAN_PAGES)
        throw new AppError(
          400,
          `A scan can contain at most ${MAX_SCAN_PAGES} pages. Existing pages were kept.`,
        );
      for (const name of files) {
        const path = join(directory, name);
        await validateScanImage(path);
        await chmod(path, 0o600);
        pages.push({ id: randomUUID(), rotation: 0, path, resolution: options.resolution });
      }
      await this.publishScan(job, pages, signal);
    } catch (error) {
      if (!signal.aborted) await this.collectRecovery(job, options, error);
      await this.failScan(job, error, signal);
    }
  }
  private async collectRecovery(job: StoredJob, options: ScanOptions, error: unknown) {
    const directory = job.scanWorkPath!;
    const pages: NonNullable<StoredJob['scanRecovery']>['pages'] = [];
    const names = await readdir(directory).catch(() => [] as string[]);
    const candidates = names
      .filter((name) => /^page-[1-9]\d*\.png$/.test(name))
      .sort((a, b) => Number(a.slice(5, -4)) - Number(b.slice(5, -4)));
    for (const name of candidates) {
      const number = Number(name.slice(5, -4));
      if (
        !Number.isSafeInteger(number) ||
        pages.length + storedScanPages(job).length >= MAX_SCAN_PAGES
      )
        continue;
      const path = join(directory, name);
      try {
        await validateScanImage(path);
        await chmod(path, 0o600);
        pages.push({ id: randomUUID(), rotation: 0, path, resolution: options.resolution, number });
      } catch {
        // Missing, incomplete, oversized or undecodable output is never offered.
      }
    }
    if (!pages.length) return;
    const retained = new Set(pages.map((page) => page.path));
    // Failure to remove unrelated output must not strand the scan in processing.
    // Only validated originals are referenced/published; lifecycle cleanup retries
    // removal of the whole private directory on discard, deletion or expiry.
    await Promise.allSettled(
      names
        .filter((name) => !retained.has(join(directory, name)))
        .map((name) => rm(join(directory, name), { recursive: true, force: true })),
    );
    job.scanRecovery = {
      revision: randomUUID(),
      baseRevision: job.scanRevision,
      directory,
      pages,
      error: error instanceof Error ? error.message : 'Scan failed.',
    };
    job.scanWorkPath = undefined;
  }
  resolveRecovery(id: string, revision: string, action: 'keep' | 'discard') {
    const job = this.job(id);
    const recovery = job.scanRecovery;
    if (this.activeJobs.has(id) || !terminal.has(job.status))
      throw new AppError(409, 'Wait for the current scan operation to finish.');
    if (!recovery || recovery.revision !== revision || recovery.baseRevision !== job.scanRevision)
      throw new AppError(409, 'This recovery changed. Reopen the scan before trying again.');
    if (expired(job, retentionPolicy(this.store)))
      throw new AppError(410, 'These recoverable pages have expired. Start a new scan.');
    this.activeJobs.add(id);
    const task = (async () => {
      if (action === 'discard') {
        await rm(recovery.directory, { recursive: true, force: true });
        job.scanRecovery = undefined;
        job.updatedAt = new Date().toISOString();
        if (!job.hasFile) await this.removeFiles(job);
        this.store.putJob(job);
      } else {
        const work = join(job.scanDirectory!, randomUUID());
        const previousStatus = job.status;
        job.scanWorkPath = work;
        job.status = 'processing';
        this.store.putJob(job);
        try {
          // Revalidate retained images before publication, including after restart.
          for (const page of recovery.pages) await validateScanImage(page.path);
          await mkdir(work, { recursive: true, mode: 0o700 });
          job.error = `Acquisition incomplete. Kept ${recovery.pages.length} recovered pages. ${recovery.error}`;
          await this.publishScan(job, [...storedScanPages(job), ...recovery.pages]);
        } catch (error) {
          // Cleanup diagnostics after a durable publication cannot roll it back.
          if (!job.scanRecovery) return this.publicJob(job);
          await rm(work, { recursive: true, force: true });
          job.scanWorkPath = undefined;
          job.status = previousStatus;
          job.error = recovery.error;
          this.store.putJob(job);
          // Publication failed: the previous PDF, revision and recovery remain intact.
          throw error;
        }
      }
      return this.publicJob(job);
    })().finally(() => this.activeJobs.delete(id));
    const tracked = task
      .then(
        () => {},
        () => {},
      )
      .finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
    return task;
  }
  editScan(id: string, revision: string, pages: ScanPage[]) {
    const job = this.job(id);
    this.editableScan(job);
    const originals = storedScanPages(job);
    if (revision !== (job.scanRevision ?? job.updatedAt))
      throw new AppError(409, 'This scan changed. Reopen it before editing.');
    if (
      pages.length === 0 ||
      new Set(pages.map((page) => page.id)).size !== pages.length ||
      pages.some((page) => !originals.some((original) => original.id === page.id))
    )
      throw new AppError(400, 'Keep at least one scanned page and include each page at most once.');
    const updated = pages.map((page) => ({
      ...originals.find((original) => original.id === page.id)!,
      rotation: page.rotation,
      crop: page.crop,
    }));
    this.prepareScan(job);
    const task = (async () => {
      try {
        await mkdir(job.scanWorkPath!, { recursive: true, mode: 0o700 });
        await this.publishScan(job, updated);
      } catch (error) {
        await this.failScan(job, error);
        throw error;
      } finally {
        this.activeJobs.delete(job.id);
      }
    })();
    // Track the work without an unhandled rejection during shutdown.
    const tracked = task.catch(() => {}).finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
    return task.then(() => this.publicJob(job));
  }
  async removeFiles(job: StoredJob) {
    this.removingFiles.add(job.id);
    try {
      await this.drainThumbnails(job.id);
      await rm(this.thumbnailDirectory(job.id), { recursive: true, force: true });
      await remove(job.filePath);
      await remove(job.previewPath);
      for (const page of storedScanPages(job)) await remove(page.path);
      if (job.scanDirectory) await rm(job.scanDirectory, { recursive: true, force: true });
      this.clearFileReferences(job);
    } finally {
      this.removingFiles.delete(job.id);
    }
  }
  private clearFileReferences(job: StoredJob) {
    job.filePath = undefined;
    job.previewPath = undefined;
    job.scanPages = undefined;
    job.scanDirectory = undefined;
    job.scanWorkPath = undefined;
    job.scanRecovery = undefined;
    job.hasFile = false;
  }
  tick(): Promise<void> {
    this.polling ??= this.pollJobs().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private async pollJobs() {
    await Promise.all(
      this.store
        .jobs(this.mode)
        .filter((j) => j.kind === 'print' && !terminal.has(j.status) && j.externalId)
        .map(async (job) => {
          const device = this.store.device(job.deviceId, this.mode);
          if (!device) return;
          try {
            const result = await this.provider.poll(job, device);
            job.status = result.status;
            job.error = result.error;
          } catch {
            job.status = 'unknown';
            job.error = 'Job status is currently unavailable.';
          }
          const current = this.store.job(job.id, this.mode);
          if (!current || current.status === 'canceled') return;
          current.status = job.status;
          current.error = job.error;
          current.updatedAt = new Date().toISOString();
          this.store.putJob(current);
        }),
    );
  }
  job(id: string) {
    const job = this.store.job(id, this.mode);
    if (!job) throw new AppError(404, 'Job not found.');
    return job;
  }
  async cancel(id: string) {
    const job = this.job(id);
    if (job.kind === 'scan') {
      const active = this.activeScans.get(id);
      if (active) {
        if (!terminal.has(job.status)) active.controller.abort();
        await active.task;
      } else if (!terminal.has(job.status)) {
        throw new AppError(409, 'This scan operation cannot be canceled.');
      }
      // A completed publication wins a late cancel; never overwrite its state.
      return this.publicJob(this.job(id));
    }
    if (terminal.has(job.status) || !job.externalId)
      throw new AppError(
        409,
        'This job cannot be canceled. Check unconfirmed submissions directly in CUPS.',
      );
    await this.provider.cancel(job, this.device(job.deviceId));
    const current = this.job(id);
    current.status = 'canceled';
    current.error = undefined;
    current.updatedAt = new Date().toISOString();
    this.store.putJob(current);
    return this.publicJob(current);
  }
  async deleteJob(id: string) {
    const job = this.job(id);
    if (this.activeJobs.has(id) || (!terminal.has(job.status) && job.status !== 'unknown'))
      throw new AppError(409, 'Active jobs cannot be deleted.');
    this.activeJobs.add(id);
    try {
      await this.removeFiles(job);
      this.store.deleteJob(id, this.mode);
    } finally {
      this.activeJobs.delete(id);
    }
  }
  async close() {
    await this.scannerCapabilities.drain();
    await Promise.allSettled([...this.deviceInspections]);
    await Promise.all(this.tasks);
    await Promise.allSettled(this.thumbnailTasks.values());
    await this.polling;
    await this.cleanup;
    this.deviceCache = undefined;
  }
}
