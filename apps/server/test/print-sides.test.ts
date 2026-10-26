import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { PRINT_SIDES, type Device, type Job } from '@openwebprint/shared';
import { HardwareProvider } from '../src/providers/hardware.js';
import { fixture, multipart, pdf } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
const printer: Device = {
  id: randomUUID(),
  name: 'Sides fixture',
  kind: 'printer',
  address: 'cups://Sides_fixture',
  target: 'Sides_fixture',
  provider: 'cups',
  mode: 'hardware',
  status: 'unknown',
  location: '',
};
const attributes = {
  'printer-state': 'idle',
  'media-supported': ['iso_a4_210x297mm'],
  'print-color-mode-supported': ['monochrome'],
};
async function submit(side: (typeof PRINT_SIDES)[number]) {
  const body = await multipart(await pdf(), 'application/pdf', printer.id, { sides: side });
  return f!.app.inject({
    method: 'POST',
    url: '/api/print',
    headers: { ...f!.headers, 'content-type': body.contentType },
    payload: body.payload,
  });
}

it.each([
  ['short edge only', ['one-sided', 'two-sided-short-edge']],
  ['long edge only', ['one-sided', 'two-sided-long-edge']],
  ['both edges', [...PRINT_SIDES]],
  ['simplex only', ['one-sided']],
  ['no supported application sides', ['vendor-specific']],
  ['empty advertised sides', []],
])('enforces %s from IPP through API submission (stubbed CUPS)', async (_name, advertised) => {
  const sides = PRINT_SIDES.filter((side) => advertised.includes(side));
  const run = vi.fn().mockResolvedValue('request id is Sides_fixture-42 (1 file(s))\n');
  const request = vi.fn().mockResolvedValue({ ...attributes, 'sides-supported': advertised });
  f = await fixture({
    mode: 'hardware',
    users: false,
    provider: new HardwareProvider('localhost:631', run, request),
  });
  f.store.putDevice(printer);
  const snapshot = await f.service.snapshot();
  expect(snapshot.devices[0].capabilities?.sides).toEqual(sides);
  for (const side of PRINT_SIDES) {
    run.mockClear();
    const before = f.store.jobs('hardware').length;
    const response = await submit(side);
    if (sides.includes(side)) {
      expect(response.statusCode, response.body).toBe(201);
      const job = response.json<Job>();
      expect(job.options).toMatchObject({ sides: side });
      expect(f.store.job(job.id, 'hardware')!.options).toMatchObject({ sides: side });
      expect(run).toHaveBeenCalledExactlyOnceWith('lp', expect.arrayContaining([`sides=${side}`]));
    } else {
      expect(response.statusCode, response.body).toBe(400);
      expect(run).not.toHaveBeenCalled();
      expect(f.store.jobs('hardware')).toHaveLength(before);
    }
  }
});

it.each(['missing sides', 'unreachable printer'])(
  'blocks %s without inventing simplex support',
  async (failure) => {
    const run = vi.fn();
    const request =
      failure === 'missing sides'
        ? vi.fn().mockResolvedValue(attributes)
        : vi.fn().mockRejectedValue(new Error('Unreachable fixture'));
    f = await fixture({
      mode: 'hardware',
      users: false,
      provider: new HardwareProvider('localhost:631', run, request),
    });
    f.store.putDevice(printer);
    expect((await f.service.snapshot()).devices[0].capabilities?.sides).toBeUndefined();
    for (const side of PRINT_SIDES) expect((await submit(side)).statusCode).toBe(409);
    expect(run).not.toHaveBeenCalled();
    expect(f.store.jobs('hardware')).toEqual([]);
    expect(await readdir(f.service.filesDir)).toEqual([]);
  },
);

it('rechecks sides at submission even when a cached snapshot still permits an edge', async () => {
  const run = vi.fn();
  const request = vi.fn().mockResolvedValue({ ...attributes, 'sides-supported': [...PRINT_SIDES] });
  f = await fixture({
    mode: 'hardware',
    users: false,
    provider: new HardwareProvider('localhost:631', run, request),
  });
  f.store.putDevice(printer);
  expect((await f.service.snapshot()).devices[0].capabilities?.sides).toContain(
    'two-sided-short-edge',
  );
  request.mockResolvedValue({
    ...attributes,
    'sides-supported': ['one-sided', 'two-sided-long-edge'],
  });
  expect((await submit('two-sided-short-edge')).statusCode).toBe(400);
  expect(run).not.toHaveBeenCalled();
  expect(f.store.jobs('hardware')).toEqual([]);
});

it('refreshes legacy demo capabilities and keeps existing job options unchanged across restart', async () => {
  f = await fixture({ users: false });
  const device = f.store.devices('demo').find((d) => d.kind === 'printer')!;
  const oldJob = await f.service.print(device.id, await pdf(), 'application/pdf', 'Existing PDF', {
    copies: 1,
    color: 'monochrome',
    sides: 'two-sided-short-edge',
    media: 'iso_a4_210x297mm',
  });
  const storedJob = f.store.job(oldJob.id, 'demo');
  // This is the persisted shape from before individual sides discovery.
  device.capabilities = JSON.parse(
    JSON.stringify({ color: false, duplex: true, media: ['iso_a4_210x297mm'] }),
  );
  f.store.putDevice(device);
  const dataDir = f.dataDir;
  await f.close(false);
  f = await fixture({ dataDir, users: false });
  expect(
    (await f.service.snapshot()).devices.find((d) => d.id === device.id)?.capabilities?.sides,
  ).toEqual(PRINT_SIDES);
  expect(f.store.job(oldJob.id, 'demo')).toEqual(storedJob);
  const newJob = await f.service.print(device.id, await pdf(), 'application/pdf', 'New PDF', {
    copies: 1,
    color: 'monochrome',
    sides: 'two-sided-short-edge',
    media: 'iso_a4_210x297mm',
  });
  expect(newJob.options).toMatchObject({ sides: 'two-sided-short-edge' });
});
