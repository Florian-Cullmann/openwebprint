import { afterEach, expect, it, vi } from 'vitest';
import type { Device, ScanSources } from '@openwebprint/shared';
import { DemoProvider } from '../src/providers/demo.js';
import type { Provider } from '../src/providers/types.js';
import { AppError } from '../src/errors.js';
import { fixture } from './helpers.js';

// All discovery here is a controlled provider, with no physical scanner.
const defaults: ScanSources = {
  sources: [
    { name: 'Flatbed', feeder: false },
    { name: 'ADF', feeder: true },
  ],
  duplex: false,
  resolutions: [150, 300, 600],
  colorModes: ['Color', 'Gray'],
};
const feeder: ScanSources = {
  ...defaults,
  resolutions: [200, 400],
  colorModes: ['Gray'],
};
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
function controlled() {
  const provider: Provider = new DemoProvider();
  const read = vi
    .spyOn(provider, 'scanSources')
    .mockImplementation(async (_device, source) => (source === 'ADF' ? feeder : defaults));
  return { provider, read };
}
function scanner() {
  return f!.store.devices('demo').find((d) => d.kind === 'scanner')!;
}
function get(query = '') {
  return f!.app.inject({
    url: `/api/devices/${scanner().id}/scan-sources${query}`,
    headers: f!.headers,
  });
}

it('discovers all advertised sources at setup and serves repeated dialog reads from the cache', async () => {
  const { provider, read } = controlled();
  f = await fixture({ provider });
  expect(read.mock.calls.map(([, source]) => source)).toEqual([undefined, 'Flatbed', 'ADF']);
  read.mockClear();
  for (let repeat = 0; repeat < 2; repeat++) {
    expect((await get()).json()).toEqual(defaults);
    expect((await get('?source=ADF')).json()).toEqual(feeder);
    expect((await get('?source=Flatbed')).json()).toEqual(defaults);
  }
  expect(read).not.toHaveBeenCalled();
});

it('preserves source-specific capability caches across server restarts', async () => {
  const { provider, read } = controlled();
  f = await fixture({ provider });
  const dataDir = f.dataDir;
  await f.close(false);
  f = undefined;
  read.mockClear();
  f = await fixture({ provider, dataDir });
  expect((await get()).json()).toEqual(defaults);
  expect((await get('?source=ADF')).json()).toEqual(feeder);
  expect(read).not.toHaveBeenCalled();
});

it.each(['partial', 'warning', 'failure'] as const)(
  'retries %s discovery instead of persisting unknown settings',
  async (kind) => {
    const { provider, read } = controlled();
    const unknown: ScanSources =
      kind === 'warning'
        ? { sources: [], duplex: false, warning: 'Controlled discovery failure.' }
        : { sources: [], duplex: false, resolutions: [300] };
    if (kind === 'failure')
      read.mockRejectedValue(new AppError(503, 'Controlled discovery failure.'));
    else read.mockResolvedValue(unknown);
    f = await fixture({ provider });
    expect(scanner()).toBeDefined(); // Capability failure does not undo device setup.
    read.mockClear();
    expect((await get()).statusCode).toBe(kind === 'failure' ? 503 : 200);
    expect((await get()).statusCode).toBe(kind === 'failure' ? 503 : 200);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(defaults);
    expect((await get()).json()).toEqual(defaults);
    read.mockClear();
    expect((await get()).json()).toEqual(defaults);
    expect(read).not.toHaveBeenCalled();
  },
);

it('caches known empty constraints without falling back or rediscovering them', async () => {
  const { provider, read } = controlled();
  const unavailable = { sources: [], duplex: false, resolutions: [], colorModes: [] };
  read.mockResolvedValue(unavailable);
  f = await fixture({ provider });
  read.mockClear();
  expect((await get()).json()).toEqual(unavailable);
  expect((await get()).json()).toEqual(unavailable);
  expect(read).not.toHaveBeenCalled();
});

it('refreshes explicitly, invalidates other source entries, and discards stale data on failure', async () => {
  const { provider, read } = controlled();
  f = await fixture({ provider });
  const changed = { ...defaults, resolutions: [600], colorModes: ['Gray'] };
  read.mockResolvedValue(changed);
  read.mockClear();
  expect((await get('?source=ADF')).json()).toEqual(feeder);
  expect(read).not.toHaveBeenCalled();
  expect((await get('?source=ADF&refresh=true')).json()).toEqual(changed);
  expect(read).toHaveBeenCalledTimes(1);
  expect((await get('?source=Flatbed')).json()).toEqual(changed);
  expect(read).toHaveBeenCalledTimes(2);
  const unknown = { sources: [], duplex: false, warning: 'Controlled discovery failure.' };
  read.mockResolvedValue(unknown);
  expect((await get('?refresh=true')).json()).toEqual(unknown);
  expect((await get()).json()).toEqual(unknown);
  expect(read).toHaveBeenCalledTimes(4);
  expect((await get('?refresh=false')).statusCode).toBe(400);
});

it('shares pending reads and prevents an older response from undoing a refresh', async () => {
  const { provider, read } = controlled();
  f = await fixture({ provider });
  let release!: (value: ScanSources) => void;
  const pending = new Promise<ScanSources>((resolve) => {
    release = resolve;
  });
  read.mockClear();
  read.mockImplementationOnce(() => pending).mockResolvedValue(feeder);
  const first = f.service.scanSources(scanner().id, undefined, true);
  const second = f.service.scanSources(scanner().id);
  expect(read).toHaveBeenCalledTimes(1);
  try {
    expect(await f.service.scanSources(scanner().id, undefined, true)).toEqual(feeder);
  } finally {
    release(defaults);
  }
  expect(await first).toEqual(defaults);
  expect(await second).toEqual(defaults);
  read.mockClear();
  expect((await get()).json()).toEqual(feeder);
  expect(read).not.toHaveBeenCalled();
});

it('does not resurrect persisted capabilities after deleting a device with a pending request', async () => {
  const { provider, read } = controlled();
  f = await fixture({ provider });
  const device = scanner();
  let release!: (value: ScanSources) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.service.scanSources(device.id, undefined, true);
  try {
    f.service.deleteDevice(device.id);
  } finally {
    release(defaults);
  }
  await pending;
  expect(f.store.setting(`scan-capabilities:demo:${device.id}`)).toBeUndefined();
  expect(
    (await f.app.inject({ url: `/api/devices/${device.id}/scan-sources`, headers: f.headers }))
      .statusCode,
  ).toBe(404);
});

it('isolates scanner targets and drains pending reads before closing the database', async () => {
  const { provider, read } = controlled();
  f = await fixture({ provider });
  const device: Device = { ...scanner(), target: 'demo://different-scanner' };
  f.store.putDevice(device);
  let release!: (value: ScanSources) => void;
  read.mockClear();
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.service.scanSources(device.id);
  expect(read).toHaveBeenCalledTimes(1);
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release(feeder);
  await pending;
  await closing;
  expect(closed).toBe(true);
  read.mockClear();
  expect((await get()).json()).toEqual(feeder);
  expect(read).not.toHaveBeenCalled();
});

it('removes demo capability records along with demo devices', async () => {
  f = await fixture();
  const device = scanner();
  expect(f.store.setting(`scan-capabilities:demo:${device.id}`)).toBeTruthy();
  await f.workspace.removeDemo();
  expect(f.store.setting(`scan-capabilities:demo:${device.id}`)).toBeUndefined();
});
