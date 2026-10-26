import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Device, DeviceInput, Mode, PrintOptions, ScanOptions } from '@openwebprint/shared';
import { AppError, missingDevice } from './errors.js';
import { Store, publicJob, type StoredJob } from './store.js';
import type { Provider } from './providers/types.js';
import { demoDevices } from './providers/demo.js';
import { normalizeDocument, exportScan } from './documents.js';

const terminal = new Set(['completed', 'canceled', 'failed']);
const remove = async (path?: string) => {
  if (path) await unlink(path).catch(() => {});
};
export class Service {
  readonly filesDir: string;
  private tasks = new Set<Promise<void>>();
  private activeScanners = new Set<string>();
  private polling?: Promise<void>;
  constructor(
    readonly store: Store,
    readonly mode: Mode,
    readonly provider: Provider,
  ) {
    this.filesDir = join(store.directory, 'files');
  }
  async initialize() {
    await mkdir(this.filesDir, { recursive: true, mode: 0o700 });
    if (this.mode === 'demo' && !this.store.setting('demo-seeded')) {
      for (const input of demoDevices) await this.addDevice(input);
      this.store.set('demo-seeded', 'true');
    }
    for (const job of this.store.jobs(this.mode)) {
      if (!terminal.has(job.status) && (job.kind === 'scan' || !job.externalId)) {
        job.status = job.kind === 'scan' ? 'failed' : 'unknown';
        job.error =
          'The server restarted during this operation. Check the device before trying again.';
        this.store.putJob(job);
        await remove(job.filePath);
        await remove(job.previewPath);
      }
    }
    await this.expireFiles();
  }
  async expireFiles() {
    for (const job of [...this.store.jobs('demo'), ...this.store.jobs('hardware')]) {
      if (
        job.kind === 'scan' &&
        terminal.has(job.status) &&
        Date.now() - new Date(job.createdAt).getTime() > 7 * 86400_000 &&
        job.hasFile
      ) {
        await remove(job.filePath);
        await remove(job.previewPath);
        job.filePath = undefined;
        job.previewPath = undefined;
        job.hasFile = false;
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
    if (existing) return existing;
    if (this.mode === 'demo' && !input.address.startsWith('demo://'))
      throw new AppError(
        400,
        'Only demo:// devices are allowed in demo mode. Set MODE=hardware to use real devices.',
      );
    const device = await this.provider.add(input, randomUUID());
    this.store.putDevice(device);
    return device;
  }
  deleteDevice(id: string) {
    this.device(id);
    if (this.store.jobs(this.mode).some((j) => j.deviceId === id && !terminal.has(j.status)))
      throw new AppError(409, 'This device still has active or unconfirmed jobs.');
    this.store.deleteDevice(id, this.mode);
  }
  async snapshot() {
    const warnings: string[] = [];
    const devices = await Promise.all(
      this.store.devices(this.mode).map(async (device) => {
        try {
          return await this.provider.inspect(device);
        } catch {
          warnings.push(`${device.name}: Unable to determine device status.`);
          return { ...device, status: 'unknown' as const };
        }
      }),
    );
    return {
      devices,
      jobs: this.store.jobs(this.mode).slice(0, 200).map(publicJob),
      warnings,
      mode: this.mode,
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
    if (
      (options.color === 'color' && !caps.color) ||
      (options.sides !== 'one-sided' && !caps.duplex) ||
      !caps.media.includes(options.media)
    ) {
      throw new AppError(400, 'This device does not support the selected print options.');
    }
    const normalized = await normalizeDocument(data, mime);
    const title = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 120) || 'Document';
    const job = this.createJob(device, 'print', title, options);
    job.filePath = join(this.filesDir, `${job.id}.pdf`);
    await writeFile(job.filePath, normalized, { mode: 0o600 });
    this.store.putJob(job);
    try {
      job.externalId = await this.provider.print(device, job.filePath, title, options);
    } catch (e) {
      // A transport failure may happen after CUPS accepted the job: never auto-retry.
      job.status = 'unknown';
      job.error = e instanceof Error ? e.message : 'Print submission failed.';
    } finally {
      await remove(job.filePath);
      job.filePath = undefined;
      job.updatedAt = new Date().toISOString();
      this.store.putJob(job);
    }
    return publicJob(job);
  }
  scan(deviceId: string, options: ScanOptions) {
    const device = this.device(deviceId);
    if (device.kind !== 'scanner') throw new AppError(400, 'The selected device is not a scanner.');
    if (this.activeScanners.has(deviceId))
      throw new AppError(409, 'This scanner is already in use.');
    const job = this.createJob(
      device,
      'scan',
      'Scan · ' + new Date().toLocaleDateString('en-GB'),
      options,
    );
    job.filePath = join(this.filesDir, `${job.id}.pdf`);
    job.previewPath = join(this.filesDir, `${job.id}.png`);
    this.activeScanners.add(deviceId);
    this.store.putJob(job);
    const task = this.performScan(job, device, options).finally(() => {
      this.activeScanners.delete(deviceId);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return publicJob(job);
  }
  private async performScan(job: StoredJob, device: Device, options: ScanOptions) {
    try {
      job.status = 'processing';
      this.store.putJob(job);
      await this.provider.scan(device, job.previewPath!, options);
      await exportScan(job.previewPath!, job.filePath!);
      job.status = 'completed';
      job.hasFile = true;
    } catch (e) {
      job.status = 'failed';
      job.error = e instanceof Error ? e.message : 'Scan fehlgeschlagen.';
      await remove(job.filePath);
      await remove(job.previewPath);
      job.filePath = undefined;
      job.previewPath = undefined;
    }
    job.updatedAt = new Date().toISOString();
    this.store.putJob(job);
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
    if (job.kind !== 'print' || terminal.has(job.status) || !job.externalId)
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
    if (!terminal.has(job.status) && job.status !== 'unknown')
      throw new AppError(409, 'Active jobs cannot be deleted.');
    await remove(job.filePath);
    await remove(job.previewPath);
    this.store.deleteJob(id, this.mode);
  }
  async close() {
    await Promise.all(this.tasks);
    await this.polling;
  }
}
