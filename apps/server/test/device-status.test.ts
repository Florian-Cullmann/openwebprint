import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '@openwebprint/shared';
import { DemoProvider } from '../src/providers/demo.js';
import type { Provider } from '../src/providers/types.js';
import { fixture, pdf } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await f?.close();
  f = undefined;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('device status caching (controlled demo provider, no hardware)', () => {
  it('coalesces concurrent API snapshots, caches for five seconds, and keeps jobs live', async () => {
    const provider: Provider = new DemoProvider();
    f = await fixture({ provider });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const pending = deferred();
    const started = deferred();
    const inspect = vi.spyOn(provider, 'inspect').mockImplementation(async (device) => {
      started.resolve();
      await pending.promise;
      return { ...device, status: 'busy' };
    });
    const request = () => f!.app.inject({ url: '/api/snapshot', headers: f!.headers });
    const first = request();
    const second = request();
    try {
      await started.promise;
      expect(inspect).toHaveBeenCalledTimes(3);
      // A slow check remains shared; the freshness interval begins on completion.
      clock.mockReturnValue(now + 6000);
      const third = request();
      pending.resolve();
      const responses = await Promise.all([first, second, third]);
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json<Snapshot>().devices.every((device) => device.status === 'busy')).toBe(
          true,
        );
        expect(response.json<Snapshot>().devicesCheckedAt).toBe(new Date(now + 6000).toISOString());
      }
      expect(inspect).toHaveBeenCalledTimes(3);
      const scanner = f.store.devices('demo').find((device) => device.kind === 'scanner')!;
      f.service.scan(scanner.id, { resolution: 150, color: 'Color' });
      clock.mockReturnValue(now + 10999);
      expect((await request()).json<Snapshot>().jobs).toHaveLength(1);
      expect(inspect).toHaveBeenCalledTimes(3);
      clock.mockReturnValue(now + 11000);
      await request();
      expect(inspect).toHaveBeenCalledTimes(6);
    } finally {
      pending.resolve();
    }
  });

  it('invalidates additions/removals and never reuses an obsolete in-flight result', async () => {
    const provider: Provider = new DemoProvider();
    f = await fixture({ provider });
    const pending = deferred();
    let initial = true;
    const inspect = vi.spyOn(provider, 'inspect').mockImplementation(async (device) => {
      if (initial) await pending.promise;
      return { ...device, status: 'ready' };
    });
    const old = f.service.snapshot();
    try {
      const added = await f.service.addDevice({
        name: 'Extra printer',
        address: 'demo://extra',
        kind: 'printer',
        location: '',
      });
      initial = false;
      const updated = f.service.snapshot();
      expect(inspect).toHaveBeenCalledTimes(7);
      expect((await updated).devices).toHaveLength(4);
      // Let the obsolete check finish last; it must not replace the newer cache.
      pending.resolve();
      await old;
      expect((await f.service.snapshot()).devices).toHaveLength(4);
      expect(inspect).toHaveBeenCalledTimes(7);
      f.service.deleteDevice(added.id);
      const removed = await f.service.snapshot();
      expect(removed.devices.some((device) => device.id === added.id)).toBe(false);
      expect(inspect).toHaveBeenCalledTimes(10);
    } finally {
      pending.resolve();
    }
  });

  it('replaces expired healthy results with unknown warnings, then recovers', async () => {
    const provider: Provider = new DemoProvider();
    f = await fixture({ provider });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const inspect = vi.spyOn(provider, 'inspect');
    for (const device of f.store.devices('demo'))
      f.store.putDevice({ ...device, detail: 'Previously ready' });
    await f.service.snapshot();
    inspect.mockRejectedValue(new Error('Private backend diagnostics'));
    clock.mockReturnValue(now + 5000);
    const failed = await f.service.snapshot();
    expect(failed.devices.every((device) => device.status === 'unknown')).toBe(true);
    expect(failed.devices.every((device) => device.capabilities === undefined)).toBe(true);
    expect(
      failed.devices.every((device) => device.detail === 'Unable to determine device status.'),
    ).toBe(true);
    expect(failed.warnings).toHaveLength(3);
    expect(JSON.stringify(failed)).not.toContain('Private backend diagnostics');
    await f.service.snapshot();
    expect(inspect).toHaveBeenCalledTimes(6);
    inspect.mockImplementation(async (device) => ({ ...device, status: 'offline' }));
    clock.mockReturnValue(now + 10000);
    const recovered = await f.service.snapshot();
    expect(recovered.devices.every((device) => device.status === 'offline')).toBe(true);
    expect(recovered.warnings).toEqual([]);
  });

  it('still inspects current printer capabilities when submitting a print', async () => {
    const provider: Provider = new DemoProvider();
    f = await fixture({ provider });
    const inspect = vi.spyOn(provider, 'inspect');
    await f.service.snapshot();
    const printer = f.store.devices('demo').find((device) => device.kind === 'printer')!;
    await f.service.print(printer.id, await pdf(), 'application/pdf', 'Sample', {
      copies: 1,
      color: 'monochrome',
      sides: 'one-sided',
      media: 'iso_a4_210x297mm',
    });
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it('waits for in-flight checks on shutdown and drops cached results', async () => {
    const provider: Provider = new DemoProvider();
    f = await fixture({ provider });
    const pending = deferred();
    const inspect = vi.spyOn(provider, 'inspect').mockImplementation(async (device) => {
      await pending.promise;
      return device;
    });
    const snapshot = f.service.snapshot();
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      pending.resolve();
      await Promise.all([snapshot, closing]);
      await f.service.snapshot();
      expect(inspect).toHaveBeenCalledTimes(6);
    } finally {
      pending.resolve();
    }
  });

  it('drains snapshots before changing modes and isolates hardware status', async () => {
    const provider: Provider = new DemoProvider();
    f = await fixture({ provider });
    const pending = deferred();
    const started = deferred();
    vi.spyOn(provider, 'inspect').mockImplementation(async (device) => {
      started.resolve();
      await pending.promise;
      return device;
    });
    const request = f.app.inject({ url: '/api/snapshot', headers: f.headers });
    try {
      await started.promise;
      let changed = false;
      const changing = f.workspace.removeDemo().then(() => {
        changed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(changed).toBe(false);
      expect((await f.app.inject({ url: '/api/snapshot', headers: f.headers })).statusCode).toBe(
        409,
      );
      pending.resolve();
      expect((await request).json<Snapshot>().mode).toBe('demo');
      await changing;
      const hardware = (
        await f.app.inject({ url: '/api/snapshot', headers: f.headers })
      ).json<Snapshot>();
      expect(hardware.mode).toBe('hardware');
      expect(hardware.devices).toEqual([]);
    } finally {
      pending.resolve();
    }
  });
});
