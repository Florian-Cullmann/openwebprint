import { publicErrorBody } from '@openwebprint/shared';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DeviceInput,
  Mode,
  OnboardingState,
  RetentionPolicy,
  RetentionImpact,
} from '@openwebprint/shared';
import { expired, retentionPolicy } from './retention.js';
import type { Config } from './config.js';
import { Store } from './store.js';
import { Service } from './service.js';
import { DemoProvider } from './providers/demo.js';
import { HardwareProvider } from './providers/hardware.js';
import type { Provider } from './providers/types.js';
import { AppError } from './errors.js';

export class Workspace {
  readonly demo: Service;
  readonly hardware: Service;
  private transitioning = false;
  private operations = new Set<Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly config: Config,
    providers: { demo?: Provider; hardware?: Provider } = {},
  ) {
    this.demo = new Service(store, 'demo', providers.demo ?? new DemoProvider());
    this.hardware = new Service(
      store,
      'hardware',
      providers.hardware ??
        new HardwareProvider(config.cupsServer, undefined, undefined, config.hostDiscoveryFile),
      this.scanRoot,
    );
  }
  get mode(): Mode {
    return this.store.setting('mode') === 'demo' ? 'demo' : 'hardware';
  }
  get phase(): OnboardingState['phase'] {
    return (this.store.setting('onboarding-phase') as OnboardingState['phase']) ?? 'welcome';
  }
  get scanRoot() {
    return this.store.setting('scan-root') ?? join(this.config.dataDir, 'scans');
  }
  get service() {
    return this.mode === 'demo' ? this.demo : this.hardware;
  }
  get required() {
    return this.phase !== 'complete';
  }
  state(): OnboardingState {
    return {
      phase: this.phase,
      mode: this.mode,
      scanRoot: this.scanRoot,
      devices: this.store.devices(this.mode),
    };
  }
  async initialize() {
    // Preserve configured installations; only fresh databases start at the welcome screen.
    if (
      !this.store.setting('onboarding-phase') &&
      (this.store.setting('demo-seeded') ||
        this.store.devices('hardware').length ||
        this.store.jobs('hardware').length)
    ) {
      this.store.set(
        'mode',
        this.config.mode ??
          (this.store.devices('hardware').length || this.store.jobs('hardware').length
            ? 'hardware'
            : 'demo'),
      );
      this.store.set('onboarding-phase', 'complete');
    }
    await this.demo.initialize();
    await this.hardware.initialize();
  }
  private async exclusive<T>(operation: () => Promise<T>) {
    if (this.transitioning) throw new AppError(409, 'Another setup operation is in progress.');
    this.transitioning = true;
    try {
      await Promise.allSettled([...this.operations]);
      return await operation();
    } finally {
      this.transitioning = false;
    }
  }
  run<T>(operation: (service: Service) => Promise<T> | T): Promise<T> {
    if (this.transitioning) throw new AppError(409, 'Setup is changing. Please try again.');
    if (this.required) throw new AppError(409, 'Complete setup before printing or scanning.');
    return this.track(Promise.resolve().then(() => operation(this.service)));
  }
  snapshot() {
    if (this.transitioning) throw new AppError(409, 'Setup is changing. Please try again.');
    return this.track(this.service.snapshot());
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.operations.add(promise);
    void promise.then(
      () => this.operations.delete(promise),
      () => this.operations.delete(promise),
    );
    return promise;
  }
  async tryDemo() {
    return this.exclusive(async () => {
      if (this.phase === 'complete' && this.mode === 'demo') return this.state();
      if (this.phase !== 'welcome')
        throw new AppError(409, 'Demo mode is only available before hardware setup.');
      await this.demo.seedDemo();
      this.store.set('mode', 'demo');
      this.store.set('onboarding-phase', 'complete');
      return this.state();
    });
  }
  async startHardware() {
    return this.exclusive(async () => {
      if (this.phase !== 'welcome') throw new AppError(409, 'Setup has already started.');
      this.store.set('mode', 'hardware');
      this.store.set('onboarding-phase', 'devices');
      return this.state();
    });
  }
  async removeDemo() {
    return this.exclusive(async () => {
      if (this.mode !== 'demo') throw new AppError(409, 'Demo mode is not active.');
      // Drain pending scans and polls before deleting records, so workers cannot recreate them.
      await this.demo.close();
      for (const job of this.store.jobs('demo')) await this.demo.removeFiles(job);
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.db.prepare('DELETE FROM jobs WHERE mode=?').run('demo');
        this.store.db.prepare('DELETE FROM devices WHERE mode=?').run('demo');
        this.store.db.prepare('DELETE FROM settings WHERE key=?').run('demo-seeded');
        this.store.db
          .prepare('DELETE FROM settings WHERE key LIKE ?')
          .run('scan-capabilities:demo:%');
        this.store.set('mode', 'hardware');
        this.store.set('onboarding-phase', 'devices');
        this.store.db.exec('COMMIT');
      } catch (error) {
        this.store.db.exec('ROLLBACK');
        throw error;
      }
      return this.state();
    });
  }
  async discover() {
    if (this.transitioning) throw new AppError(409, 'Setup is changing. Please try again.');
    if (this.phase === 'welcome') throw new AppError(409, 'Choose demo mode or start setup first.');
    return this.service.provider.discover();
  }
  async addDevice(input: DeviceInput) {
    if (this.transitioning) throw new AppError(409, 'Setup is changing. Please try again.');
    if (this.phase === 'welcome') throw new AppError(409, 'Choose demo mode or start setup first.');
    return this.track(this.service.addDevice(input));
  }
  async selectDevices(inputs: DeviceInput[]) {
    return this.exclusive(async () => {
      if (this.mode !== 'hardware' || this.phase !== 'devices')
        throw new AppError(409, 'Device selection is not the current setup step.');
      const errors: { address: string; error: string }[] = [];
      for (const input of inputs) {
        try {
          await this.hardware.addDevice(input);
        } catch (error) {
          errors.push({
            address: input.address,
            ...publicErrorBody(error instanceof Error ? error.message : 'Unable to add device.'),
          });
        }
      }
      if (!errors.length) this.store.set('onboarding-phase', 'storage');
      return { ...this.state(), errors };
    });
  }
  private async writableRoot(path: string) {
    if (!isAbsolute(path) || path.length > 1024 || /[\x00-\x1f\x7f]/.test(path))
      throw new AppError(400, 'Enter an absolute server folder path.');
    let probe: string | undefined;
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const resolved = await realpath(path);
      probe = join(resolved, `.openwebprint-check-${randomUUID()}`);
      const handle = await open(probe, 'wx', 0o600);
      try {
        await handle.writeFile('Storage check');
      } finally {
        await handle.close();
      }
      await unlink(probe);
      probe = undefined;
      return resolved;
    } catch {
      throw new AppError(
        422,
        'Unable to write to this folder. Check the server path, permissions and Docker mounts.',
      );
    } finally {
      if (probe) await unlink(probe).catch(() => {});
    }
  }
  async saveStorage(path: string, finishSetup = false) {
    return this.exclusive(async () => {
      if (finishSetup && (this.phase !== 'storage' || this.mode !== 'hardware'))
        throw new AppError(409, 'Scan storage is not the current setup step.');
      const root = await this.writableRoot(path);
      this.store.set('scan-root', root);
      this.hardware.setScanDirectory(root);
      if (finishSetup) this.store.set('onboarding-phase', 'complete');
      return this.state();
    });
  }
  retentionImpact(policy: RetentionPolicy): RetentionImpact {
    const previous = retentionPolicy(this.store);
    const impact = { scans: 0, prints: 0 };
    for (const job of [...this.store.jobs('demo'), ...this.store.jobs('hardware')]) {
      const shorter =
        job.kind === 'scan'
          ? policy.scanDays < previous.scanDays
          : policy.printDays < previous.printDays;
      if (shorter && (job.hasFile || job.scanRecovery) && expired(job, policy)) {
        if (job.kind === 'scan') impact.scans++;
        else impact.prints++;
      }
    }
    return impact;
  }
  saveRetention(policy: RetentionPolicy, confirmed: boolean) {
    const impact = this.retentionImpact(policy);
    if ((impact.scans || impact.prints) && !confirmed)
      throw new AppError(
        409,
        'This shorter policy makes existing documents eligible for deletion. Review the impact and confirm the change.',
      );
    this.store.set('retention', JSON.stringify(policy));
    return policy;
  }
  async expireFiles() {
    if (!this.transitioning) {
      await this.track(Promise.all([this.demo.expireFiles(), this.hardware.expireFiles()]));
    }
  }
  async tick() {
    if (!this.transitioning) await this.service.tick();
  }
  async close() {
    await Promise.allSettled([...this.operations]);
    await Promise.all([this.demo.close(), this.hardware.close()]);
  }
}
