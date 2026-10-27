import { expect, it, vi } from 'vitest';
import type { Device } from '@openwebprint/shared';
import { HardwareProvider } from '../src/providers/hardware.js';
import type { Command } from '../src/providers/command.js';

const scanner: Device = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Controlled scanner',
  kind: 'scanner',
  address: 'airscan:e0:Fixture',
  target: 'airscan:e0:Fixture',
  location: '',
  provider: 'sane',
  mode: 'hardware',
  status: 'unknown',
};
it.each(['default probe', 'source probe', 'single page', 'batch'])(
  'propagates cancellation during %s without starting subsequent commands (stubbed SANE process boundary)',
  async (stage) => {
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = vi.fn<Command>(async (_executable, args, _timeout, signal) => {
      const current = args.includes('--all-options')
        ? args.includes('--source')
          ? 'source probe'
          : 'default probe'
        : args.includes('--output-file')
          ? 'single page'
          : 'batch';
      if (current === stage) {
        expect(signal).toBe(controller.signal);
        entered();
        await new Promise<void>((resolve) =>
          signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        signal!.throwIfAborted();
      }
      return '  --source Flatbed|ADF [Flatbed]\n';
    });
    const pending = new HardwareProvider('localhost:631', run).scan(
      scanner,
      '/private/page-%d.png',
      { resolution: 300, color: 'Gray', source: 'ADF', batch: stage === 'batch' },
      10,
      controller.signal,
    );
    const settled = pending.catch((error: Error) => error);
    await ready;
    controller.abort();
    expect(await settled).toMatchObject({ name: 'AbortError' });
    expect(run).toHaveBeenCalledTimes(
      stage === 'default probe' ? 1 : stage === 'source probe' ? 2 : 3,
    );
  },
);
