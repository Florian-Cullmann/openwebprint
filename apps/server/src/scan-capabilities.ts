import type { Device, Mode, ScanSources } from '@openwebprint/shared';
import type { Store } from './store.js';
import type { Provider } from './providers/types.js';

interface SavedCapabilities {
  version: 2;
  fingerprint: string;
  entries: Record<string, ScanSources>;
}
const fingerprint = (device: Device) =>
  JSON.stringify([device.provider, device.address, device.target]);
const known = (value: ScanSources) =>
  !value.warning && value.resolutions !== undefined && value.colorModes !== undefined;

// This cache serves configuration reads only. Providers re-probe before acquisition.
export class ScannerCapabilities {
  private generations = new Map<string, number>();
  private pending = new Map<string, Promise<ScanSources>>();
  private tasks = new Set<Promise<unknown>>();
  constructor(
    private store: Store,
    private mode: Mode,
    private provider: Provider,
  ) {}
  private key(id: string) {
    return `scan-capabilities:${this.mode}:${id}`;
  }
  private saved(device: Device): SavedCapabilities | undefined {
    try {
      const value = JSON.parse(this.store.setting(this.key(device.id)) ?? 'null');
      if (
        value?.version === 2 &&
        value.fingerprint === fingerprint(device) &&
        typeof value.entries === 'object' &&
        value.entries !== null &&
        !Array.isArray(value.entries)
      )
        return value;
    } catch {
      // A missing, incompatible or damaged cache is rebuilt from the provider.
    }
  }
  invalidate(id: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.store.deleteSetting(this.key(id));
  }
  get(device: Device, source?: string, refresh = false): Promise<ScanSources> {
    if (refresh) this.invalidate(device.id);
    const sourceKey = JSON.stringify(source ?? null);
    const cached = this.saved(device)?.entries[sourceKey];
    if (cached && known(cached)) return Promise.resolve(cached);
    const generation = this.generations.get(device.id) ?? 0;
    const requestKey = JSON.stringify([device.id, fingerprint(device), sourceKey, generation]);
    const existing = this.pending.get(requestKey);
    if (existing) return existing;
    const task = this.provider
      .scanSources(device, source)
      .then((result) => {
        const current = this.store.device(device.id, this.mode);
        if (
          known(result) &&
          current &&
          fingerprint(current) === fingerprint(device) &&
          generation === (this.generations.get(device.id) ?? 0)
        ) {
          const saved = this.saved(device) ?? {
            version: 2,
            fingerprint: fingerprint(device),
            entries: {},
          };
          saved.entries[sourceKey] = result;
          this.store.set(this.key(device.id), JSON.stringify(saved));
        }
        return result;
      })
      .finally(() => {
        this.pending.delete(requestKey);
        this.tasks.delete(task);
      });
    this.pending.set(requestKey, task);
    this.tasks.add(task);
    return task;
  }
  warm(device: Device): Promise<void> {
    const task = (async () => {
      // Setup succeeds even when capability discovery is temporarily unavailable.
      const defaults = await this.get(device).catch(() => undefined);
      for (const source of defaults?.sources ?? []) {
        // SANE devices may reject concurrent opens, so query sources sequentially.
        if (!this.store.device(device.id, this.mode)) break;
        await this.get(device, source.name).catch(() => undefined);
      }
    })().finally(() => this.tasks.delete(task));
    this.tasks.add(task);
    return task;
  }
  async drain() {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
}
