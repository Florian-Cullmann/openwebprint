import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  Capabilities,
  ProfileInput,
  ScanSources,
  SettingsProfile,
} from '@openwebprint/shared';
import { DemoProvider } from '../src/providers/demo.js';
import type { Provider } from '../src/providers/types.js';
import { credentials, fixture } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
const print: ProfileInput = {
  name: 'A4 duplex monochrome',
  kind: 'print',
  options: {
    copies: 2,
    color: 'monochrome',
    sides: 'two-sided-short-edge',
    media: 'iso_a4_210x297mm',
  },
};
const scan: ProfileInput = {
  name: '300 dpi grayscale',
  kind: 'scan',
  options: { resolution: 300, color: 'Gray', source: 'ADF', duplex: true },
};
const scanCaps: ScanSources = {
  sources: [
    { name: 'Flatbed', feeder: false },
    { name: 'ADF', feeder: true },
  ],
  duplex: true,
  resolutions: [150, 300, 600],
  colorModes: ['Color', 'Gray'],
};
const printCaps: Capabilities = {
  color: true,
  colorModes: ['monochrome', 'color'],
  sides: ['one-sided', 'two-sided-short-edge'],
  media: ['iso_a4_210x297mm'],
};
const device = (kind: 'printer' | 'scanner') =>
  f!.store.devices('demo').find((d) => d.kind === kind)!;
const path = (id: string) => `/api/devices/${id}/profiles`;
async function create(deviceId: string, input: ProfileInput) {
  const result = await f!.app.inject({
    method: 'POST',
    url: path(deviceId),
    headers: f!.headers,
    payload: input,
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json<SettingsProfile>();
}
async function apply(profile: SettingsProfile) {
  return f!.app.inject({
    method: 'POST',
    url: `${path(profile.deviceId)}/${profile.id}/apply`,
    headers: f!.headers,
  });
}
function controlled() {
  const provider: Provider = new DemoProvider();
  const readScan = vi.spyOn(provider, 'scanSources').mockResolvedValue(scanCaps);
  const inspect = vi
    .spyOn(provider, 'inspect')
    .mockImplementation(async (d) => ({ ...d, capabilities: printCaps }));
  return { provider, readScan, inspect };
}

it('persists print and source-specific scan settings across restarts, supports rename/update/delete, and never creates jobs', async () => {
  const { provider, readScan } = controlled();
  f = await fixture({ provider, users: false });
  const printer = device('printer');
  const scanner = device('scanner');
  const p = await create(printer.id, print);
  const s = await create(scanner.id, scan);
  expect(readScan).toHaveBeenLastCalledWith(expect.objectContaining({ id: scanner.id }), 'ADF');
  // Updating a device record must not cascade-delete its profiles.
  f.store.putDevice({ ...printer, location: 'Updated location' });
  const dataDir = f.dataDir;
  await f.close(false);
  f = undefined;
  f = await fixture({ provider, dataDir, users: false });
  expect((await apply(p)).json().profile).toEqual(p);
  expect((await apply(s)).json()).toEqual({ profile: s, scanSources: scanCaps });
  const edited = { ...print, name: 'Renamed profile', options: { ...print.options, copies: 4 } };
  const update = await f.app.inject({
    method: 'PUT',
    url: `${path(printer.id)}/${p.id}`,
    headers: f.headers,
    payload: edited,
  });
  expect(update.statusCode, update.body).toBe(200);
  expect((await apply(p)).json().profile).toEqual({ ...p, ...edited });
  expect(f.store.jobs('demo')).toEqual([]);
  const deletion = await f.app.inject({
    method: 'DELETE',
    url: `${path(printer.id)}/${p.id}`,
    headers: f.headers,
  });
  expect(deletion.statusCode).toBe(200);
  expect((await apply(p)).statusCode).toBe(404);
  expect(f.store.profiles(scanner.id, 'demo')).toEqual([s]);
});

it.each([
  [
    'color mode',
    { ...printCaps, color: false, colorModes: ['monochrome'] },
    { ...print, options: { ...print.options, color: 'color' } },
  ],
  ['color mode', { ...printCaps, colorModes: ['color'] }, print],
  ['unavailable', { ...printCaps, colorModes: undefined }, print],
  ['sides', { ...printCaps, sides: ['one-sided'] }, print],
  ['paper size', { ...printCaps, media: [] }, print],
  ['unavailable', undefined, print],
] as const)(
  'rechecks changed print capabilities (%s) and preserves incompatible profiles (stubbed provider)',
  async (message, caps, input) => {
    const { provider, inspect } = controlled();
    f = await fixture({ provider, users: false });
    const p = await create(device('printer').id, input);
    inspect.mockImplementation(async (d) => ({
      ...d,
      capabilities: caps as Capabilities | undefined,
    }));
    const result = await apply(p);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().error).toContain(message);
    expect(f.store.profiles(p.deviceId, 'demo')).toEqual([p]);
    expect(f.store.jobs('demo')).toEqual([]);
  },
);

it.each([
  ['resolution', { ...scanCaps, resolutions: [600] }],
  ['color mode', { ...scanCaps, colorModes: ['Color'] }],
  ['paper source', { ...scanCaps, sources: [{ name: 'Flatbed', feeder: false }] }],
  ['both sides', { ...scanCaps, duplex: false }],
  ['incomplete', { ...scanCaps, colorModes: undefined }],
  ['incomplete', { ...scanCaps, warning: 'Discovery incomplete' }],
] as const)(
  'bypasses cached scan capabilities on apply/update (%s) without changing saved settings (stubbed provider)',
  async (message, caps) => {
    const { provider, readScan } = controlled();
    f = await fixture({ provider, users: false });
    const p = await create(device('scanner').id, scan);
    readScan.mockResolvedValue(caps as ScanSources);
    const result = await apply(p);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().error).toContain(message);
    const update = await f.app.inject({
      method: 'PUT',
      url: `${path(p.deviceId)}/${p.id}`,
      headers: f.headers,
      payload: { ...scan, name: 'Changed name' },
    });
    expect(update.statusCode).toBe(409);
    expect(f.store.profiles(p.deviceId, 'demo')).toEqual([p]);
    readScan.mockResolvedValue(scanCaps);
    expect((await apply(p)).json().profile).toEqual(p);
  },
);

it('applies source-specific scan settings only when verified for that source (stubbed provider)', async () => {
  const { provider, readScan } = controlled();
  readScan.mockImplementation(async (_d, source) => ({
    ...scanCaps,
    resolutions: source === 'ADF' ? { min: 200, max: 800, step: 200 } : [300],
  }));
  f = await fixture({ provider, users: false });
  const p = await create(device('scanner').id, {
    ...scan,
    options: { ...scan.options, resolution: 400 },
  });
  expect((await apply(p)).json().profile.options.resolution).toBe(400);
  const invalid = await f.app.inject({
    method: 'POST',
    url: path(p.deviceId),
    headers: f.headers,
    payload: { ...scan, options: { ...scan.options, resolution: 300 } },
  });
  expect(invalid.statusCode).toBe(409);
});

it('rejects document/job fields, invalid settings, wrong device kinds, and cross-device profile access', async () => {
  f = await fixture({ users: false });
  const id = device('printer').id;
  for (const input of [
    { ...print, jobId: randomUUID() },
    { ...print, options: { ...print.options, filePath: '/tmp/private.pdf' } },
    { ...scan, options: { ...scan.options, batch: true } },
    { ...print, options: { ...print.options, copies: 0 } },
    { ...print, options: { ...print.options, pageRanges: '1-3' } },
    { ...print, options: { ...print.options, pageParity: 'odd' } },
    { ...print, name: ' ' },
    { ...print, name: 'a'.repeat(81) },
    { ...print, name: 'invalid\nname' },
    scan,
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: path(id),
      headers: f.headers,
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(400);
  }
  const p = await create(id, print);
  const another = f.store.devices('demo').find((d) => d.kind === 'printer' && d.id !== id)!;
  for (const [method, suffix] of [
    ['PUT', ''],
    ['DELETE', ''],
    ['POST', '/apply'],
  ] as const) {
    const response = await f.app.inject({
      method,
      url: `${path(another.id)}/${p.id}${suffix}`,
      headers: f.headers,
      ...(method === 'PUT' ? { payload: print } : {}),
    });
    expect(response.statusCode).toBe(404);
  }
  expect(f.store.profiles(id, 'hardware')).toEqual([]);
});

it('cascades device/demo deletion while preserving hardware profiles and never resurrects them on re-add', async () => {
  f = await fixture({ users: false });
  const printer = device('printer');
  const p = await create(printer.id, print);
  const hardware = { ...printer, id: randomUUID(), mode: 'hardware' as const };
  f.store.putDevice(hardware);
  const hardwareProfile = { ...p, id: randomUUID(), deviceId: hardware.id };
  f.store.putProfile(hardwareProfile);
  const result = await f.app.inject({
    method: 'DELETE',
    url: `/api/devices/${printer.id}`,
    headers: f.headers,
  });
  expect(result.statusCode).toBe(200);
  expect(f.store.db.prepare('SELECT * FROM profiles WHERE id=?').get(p.id)).toBeUndefined();
  const added = await f.service.addDevice(printer);
  expect(added.id).not.toBe(printer.id);
  expect(f.store.profiles(added.id, 'demo')).toEqual([]);
  await create(added.id, print);
  await f.workspace.removeDemo();
  expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM profiles').get()!.count).toBe(1);
  expect(f.store.profiles(hardware.id, 'hardware')).toEqual([hardwareProfile]);
});

it('shares profiles before/after enabling login and requires authentication on every profile endpoint', async () => {
  f = await fixture({ users: false });
  const p = await create(device('printer').id, print);
  await f.app.inject({
    method: 'POST',
    url: '/api/users',
    headers: f.headers,
    payload: credentials,
  });
  for (const [method, suffix, payload] of [
    ['GET', '', undefined],
    ['POST', '', print],
    ['PUT', `/${p.id}`, print],
    ['POST', `/${p.id}/apply`, undefined],
    ['DELETE', `/${p.id}`, undefined],
  ] as const) {
    expect(
      (
        await f.app.inject({
          method,
          url: `${path(p.deviceId)}${suffix}`,
          headers: f.headers,
          payload,
        })
      ).statusCode,
    ).toBe(401);
  }
  const login = await f.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: f.headers,
    payload: credentials,
  });
  const headers = { ...f.headers, cookie: String(login.headers['set-cookie']).split(';')[0] };
  const second = { username: 'second', password: 'another-password' };
  await f.app.inject({ method: 'POST', url: '/api/users', headers, payload: second });
  const otherLogin = await f.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: f.headers,
    payload: second,
  });
  const otherHeaders = {
    ...f.headers,
    cookie: String(otherLogin.headers['set-cookie']).split(';')[0],
  };
  expect((await f.app.inject({ url: path(p.deviceId), headers: otherHeaders })).json()).toEqual([
    p,
  ]);
  const update = await f.app.inject({
    method: 'PUT',
    url: `${path(p.deviceId)}/${p.id}`,
    headers: otherHeaders,
    payload: { ...print, name: 'Shared change' },
  });
  expect(update.statusCode).toBe(200);
  expect((await f.app.inject({ url: path(p.deviceId), headers })).json()[0].name).toBe(
    'Shared change',
  );
});
