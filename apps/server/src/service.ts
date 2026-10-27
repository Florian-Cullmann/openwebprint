import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, rm, readdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Device,
  DeviceInput,
  JobPage,
  Mode,
  PrintOptions,
  ScanOptions,
  ScanPage,
  Snapshot,
} from '@openwebprint/shared';
import { MAX_SCAN_PAGES } from '@openwebprint/shared';
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
import { normalizeDocument, exportScanPages } from './documents.js';
import { ScannerCapabilities } from './scan-capabilities.js';

const terminal = new Set(['completed', 'canceled', 'failed']);
const DEVICE_STATUS_TTL = 5000;
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
        if (!job.hasFile) await this.removeFiles(job);
        this.store.putJob(job);
      }
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
  async expireFiles() {
    for (const job of [...this.store.jobs('demo'), ...this.store.jobs('hardware')]) {
      if (
        !this.activeJobs.has(job.id) &&
        (job.kind === 'print' || terminal.has(job.status)) &&
        Date.now() - new Date(job.createdAt).getTime() > 7 * 86400_000 &&
        job.hasFile
      ) {
        await this.removeFiles(job);
        if (this.store.job(job.id, job.mode)) this.store.putJob(job);
      }
    }
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
      jobs: this.store.jobPage(this.mode, { limit: 200 }).map(publicJob),
      mode: this.mode,
    };
  }
  listJobs(options: JobPageOptions): JobPage {
    const rows = this.store.jobPage(this.mode, { ...options, limit: options.limit + 1 });
    const jobs = rows.slice(0, options.limit).map(publicJob);
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
    let device = this.device(deviceId);
    if (device.kind !== 'printer') throw new AppError(400, 'The selected device is not a printer.');
    device = await this.provider.inspect(device);
    const caps = device.capabilities;
    if (!caps)
      throw new AppError(409, 'Unable to retrieve print options. Check the CUPS connection.');
    if (!caps.sides)
      throw new AppError(
        409,
        'Unable to retrieve supported print sides. Check the CUPS connection.',
      );
    if (
      (options.color === 'color' && !caps.color) ||
      !caps.sides.includes(options.sides) ||
      !caps.media.includes(options.media)
    ) {
      throw new AppError(400, 'This device does not support the selected print options.');
    }
    const normalized = await normalizeDocument(data, mime);
    const title = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 120) || 'Document';
    const job = this.createJob(device, 'print', title, options);
    job.filePath = join(this.filesDir, `${job.id}.pdf`);
    await writeFile(job.filePath, normalized, { mode: 0o600 });
    job.hasFile = true;
    this.store.putJob(job);
    try {
      job.externalId = await this.provider.print(device, job.filePath, title, options);
    } catch (e) {
      // A transport failure may happen after CUPS accepted the job: never auto-retry.
      job.status = 'unknown';
      job.error = e instanceof Error ? e.message : 'Print submission failed.';
    } finally {
      job.updatedAt = new Date().toISOString();
      this.store.putJob(job);
    }
    return publicJob(job);
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
    return publicJob(job);
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
    if (
      job.kind !== 'scan' ||
      !job.hasFile ||
      job.status !== 'completed' ||
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
    const previousPdf = job.filePath;
    const previousPreview = job.previewPath;
    job.filePath = filePath;
    job.previewPath = previewPath;
    job.scanPages = pages;
    job.scanRevision = randomUUID();
    job.hasFile = true;
    job.status = 'completed';
    job.scanWorkPath = undefined;
    job.updatedAt = new Date().toISOString();
    this.store.putJob(job);
    await remove(previousPdf);
    // A legacy scan uses its original preview as the page image.
    if (!pages.some((page) => page.path === previousPreview)) await remove(previousPreview);
  }
  private async failScan(job: StoredJob, error: unknown, signal?: AbortSignal) {
    if (job.scanWorkPath) await rm(job.scanWorkPath, { recursive: true, force: true });
    job.scanWorkPath = undefined;
    job.status = job.hasFile ? 'completed' : signal?.aborted ? 'canceled' : 'failed';
    job.error = signal?.aborted
      ? 'Scan canceled. New pages from this operation were discarded. Previously saved pages were kept.'
      : error instanceof Error
        ? error.message
        : 'Scan failed.';
    if (!job.hasFile) await this.removeFiles(job);
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
        await chmod(path, 0o600);
        pages.push({ id: randomUUID(), rotation: 0, path, resolution: options.resolution });
      }
      await this.publishScan(job, pages, signal);
    } catch (error) {
      await this.failScan(job, error, signal);
    }
  }
  editScan(id: string, revision: string, pages: ScanPage[]) {
    const job = this.job(id);
    this.editableScan(job);
    const originals = storedScanPages(job);
    if (revision !== (job.scanRevision ?? job.updatedAt))
      throw new AppError(409, 'This scan changed. Reopen it before editing.');
    if (
      pages.length !== originals.length ||
      new Set(pages.map((page) => page.id)).size !== originals.length ||
      pages.some((page) => !originals.some((original) => original.id === page.id))
    )
      throw new AppError(400, 'Include each scanned page exactly once.');
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
    return task.then(() => publicJob(job));
  }
  async removeFiles(job: StoredJob) {
    await remove(job.filePath);
    await remove(job.previewPath);
    for (const page of storedScanPages(job)) await remove(page.path);
    if (job.scanDirectory) await rm(job.scanDirectory, { recursive: true, force: true });
    job.filePath = undefined;
    job.previewPath = undefined;
    job.scanPages = undefined;
    job.scanDirectory = undefined;
    job.scanWorkPath = undefined;
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
            Object.assign(job, await this.provider.poll(job, device));
          } catch {
            job.status = 'unknown';
            job.error = 'Job status is currently unavailable.';
          }
          const current = this.store.job(job.id, this.mode);
          if (!current || current.status === 'canceled') return;
          job.updatedAt = new Date().toISOString();
          this.store.putJob(job);
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
      return publicJob(this.job(id));
    }
    if (terminal.has(job.status) || !job.externalId)
      throw new AppError(
        409,
        'This job cannot be canceled. Check unconfirmed submissions directly in CUPS.',
      );
    await this.provider.cancel(job, this.device(job.deviceId));
    job.status = 'canceled';
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    this.store.putJob(job);
    return publicJob(job);
  }
  async deleteJob(id: string) {
    const job = this.job(id);
    if (this.activeJobs.has(id) || (!terminal.has(job.status) && job.status !== 'unknown'))
      throw new AppError(409, 'Active jobs cannot be deleted.');
    await this.removeFiles(job);
    this.store.deleteJob(id, this.mode);
  }
  async close() {
    await this.scannerCapabilities.drain();
    await Promise.allSettled([...this.deviceInspections]);
    await Promise.all(this.tasks);
    await this.polling;
    this.deviceCache = undefined;
  }
}
