import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, access, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { DemoProvider } from '../src/providers/demo.js';
import type { Device, DeviceInput, ScanOptions } from '@openwebprint/shared';
const headers = { 'x-openwebprint': '1' };
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
let directory: string;
afterEach(async () => {
  await instance?.app.close();
  instance = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fresh(options: Parameters<typeof createApp>[1] = {}) {
  directory = await mkdtemp(join(tmpdir(), 'owp-onboarding-'));
  instance = await createApp(readConfig({ DATA_DIR: directory }), {
    background: false,
    ...options,
  });
  return instance;
}
describe('optional demo and hardware onboarding', () => {
  it('starts with an explicit choice, without devices, users or accepted jobs', async () => {
    const { app, store } = await fresh();
    expect((await app.inject('/api/session')).json()).toMatchObject({
      onboardingRequired: true,
      authenticationRequired: false,
    });
    expect((await app.inject('/api/onboarding')).json().phase).toBe('welcome');
    expect(store.devices('demo')).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/scans',
          headers,
          payload: { deviceId: randomUUID(), options: {} },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: '/api/devices/discover', headers })).statusCode,
    ).toBe(409);
    const demo = await app.inject({ method: 'POST', url: '/api/onboarding/demo', headers });
    expect(demo.statusCode).toBe(200);
    expect(demo.json()).toMatchObject({ mode: 'demo', phase: 'complete' });
    expect(store.devices('demo')).toHaveLength(3);
    expect((await app.inject('/api/session')).json().onboardingRequired).toBe(false);
  });
  it('upgrades an existing demo without onboarding or replacing its devices', async () => {
    const { app, workspace, store } = await fresh();
    await workspace.tryDemo();
    const device = store.devices('demo')[0];
    device.location = 'Existing installation';
    store.putDevice(device);
    // Previous releases only persisted the seed marker and mode on records.
    store.db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run('mode', 'onboarding-phase');
    await app.close();
    instance = await createApp(readConfig({ DATA_DIR: directory }), { background: false });
    expect(instance.workspace.state()).toMatchObject({ mode: 'demo', phase: 'complete' });
    expect(instance.store.devices('demo')).toHaveLength(3);
    expect(instance.store.device(device.id, 'demo')?.location).toBe('Existing installation');
  });
  it('removes all demo records and files, preserves accounts and real records, and never reseeds after restart', async () => {
    const { app, workspace, store } = await fresh();
    await workspace.tryDemo();
    const scanner = store.devices('demo').find((device) => device.kind === 'scanner')!;
    const job = workspace.demo.scan(scanner.id, { resolution: 150, color: 'Color' });
    await workspace.demo.close();
    const file = workspace.demo.job(job.id).filePath!;
    const real: Device = {
      ...store.devices('demo')[0],
      id: randomUUID(),
      mode: 'hardware',
      provider: 'cups',
      address: 'cups://real',
    };
    store.putDevice(real);
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers,
      payload: { username: 'owner', password: 'a' },
    });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { username: 'owner', password: 'a' },
    });
    const authenticated = { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0] };
    expect(
      (await app.inject({ method: 'POST', url: '/api/onboarding/remove-demo', headers }))
        .statusCode,
    ).toBe(401);
    const result = await app.inject({
      method: 'POST',
      url: '/api/onboarding/remove-demo',
      headers: authenticated,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ phase: 'devices', mode: 'hardware' });
    expect(store.jobs('demo')).toEqual([]);
    expect(store.devices('demo')).toEqual([]);
    await expect(access(file)).rejects.toThrow();
    expect(store.devices('hardware')).toEqual([real]);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM users').get()!.count).toBe(1);
    await app.close();
    instance = undefined;
    instance = await createApp(readConfig({ DATA_DIR: directory, MODE: 'demo' }), {
      background: false,
    });
    expect(instance.workspace.phase).toBe('devices');
    expect(instance.workspace.mode).toBe('hardware');
    expect(instance.store.devices('demo')).toEqual([]);
  });
  it('drains a running demo scan before removal instead of resurrecting its files', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowDemo extends DemoProvider {
      override async scan(device: Device, path: string, options: ScanOptions) {
        await gate;
        await super.scan(device, path, options);
      }
    }
    const { workspace, store } = await fresh({ demoProvider: new SlowDemo() });
    await workspace.tryDemo();
    workspace.demo.scan(store.devices('demo').find((device) => device.kind === 'scanner')!.id, {
      resolution: 150,
      color: 'Color',
    });
    const removing = workspace.removeDemo();
    try {
      expect(() => workspace.run((service) => service.snapshot())).toThrow('Setup is changing');
    } catch (error) {
      release();
      await removing;
      throw error;
    }
    release();
    await removing;
    expect(store.jobs('demo')).toEqual([]);
    expect(await readdir(workspace.demo.filesDir)).toEqual([]);
  });
  it('adds selected hardware through the real adapter contract and validates writable scan storage', async () => {
    class HardwareFixture extends DemoProvider {
      override async add(input: DeviceInput, id: string): Promise<Device> {
        if (input.address === 'ipp://bad/ipp/print') throw new Error('Device unreachable');
        return {
          ...input,
          id,
          mode: 'hardware',
          provider: 'sane',
          status: 'unknown',
          target: input.address,
        };
      }
    }
    const { app, workspace, store } = await fresh({ hardwareProvider: new HardwareFixture() });
    await workspace.startHardware();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/onboarding/storage',
          headers,
          payload: { path: join(directory, 'scans') },
        })
      ).statusCode,
    ).toBe(409);
    const scanner = {
      name: 'Scanner fixture',
      kind: 'scanner',
      address: 'airscan:e0:test',
      location: '',
    };
    const failed = await app.inject({
      method: 'POST',
      url: '/api/onboarding/devices',
      headers,
      payload: { devices: [{ ...scanner, kind: 'printer', address: 'ipp://bad/ipp/print' }] },
    });
    expect(failed.json().errors).toHaveLength(1);
    expect(workspace.phase).toBe('devices');
    const selected = await app.inject({
      method: 'POST',
      url: '/api/onboarding/devices',
      headers,
      payload: { devices: [scanner] },
    });
    expect(selected.json().phase).toBe('storage');
    expect(store.devices('hardware')).toHaveLength(1);
    expect(store.devices('demo')).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/onboarding/storage',
          headers,
          payload: { path: '../unsafe' },
        })
      ).statusCode,
    ).toBe(400);
    const notDirectory = join(directory, 'plain-file');
    await writeFile(notDirectory, 'test');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/onboarding/storage',
          headers,
          payload: { path: notDirectory },
        })
      ).statusCode,
    ).toBe(422);
    expect(workspace.phase).toBe('storage');
    const root = join(directory, 'custom-scans');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/onboarding/storage',
          headers,
          payload: { path: root },
        })
      ).json().phase,
    ).toBe('complete');
    const scan = await app.inject({
      method: 'POST',
      url: '/api/scans',
      headers,
      payload: { deviceId: store.devices('hardware')[0].id, options: {} },
    });
    expect(scan.statusCode).toBe(202);
    await workspace.hardware.close();
    expect(workspace.hardware.job(scan.json().id).filePath).toBe(
      join(await realpath(root), scan.json().id + '.pdf'),
    );
    expect(await readdir(root)).toHaveLength(2);
    const scannerId = store.devices('hardware')[0].id;
    const secondRoot = join(directory, 'future-scans');
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/storage',
      headers,
      payload: { path: secondRoot },
    });
    expect(changed.statusCode).toBe(200);
    await app.close();
    instance = await createApp(readConfig({ DATA_DIR: directory }), {
      background: false,
      hardwareProvider: new HardwareFixture(),
    });
    expect(instance.workspace.scanRoot).toBe(await realpath(secondRoot));
    expect((await instance.app.inject(`/api/jobs/${scan.json().id}/pdf`)).statusCode).toBe(200);
    const next = instance.workspace.hardware.scan(scannerId, { resolution: 150, color: 'Color' });
    await instance.workspace.hardware.close();
    expect(instance.workspace.hardware.job(next.id).filePath).toBe(
      join(await realpath(secondRoot), next.id + '.pdf'),
    );
    expect(await readdir(root)).toHaveLength(2);
    expect(await readdir(secondRoot)).toHaveLength(2);
  });
});
