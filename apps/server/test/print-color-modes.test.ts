import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { PRINT_COLOR_MODES, type Device, type Job, type PrintOptions } from '@openwebprint/shared';
import { HardwareProvider } from '../src/providers/hardware.js';
import { fixture, multipart, pdf } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
const printer: Device = {
  id: randomUUID(),
  name: 'Color fixture',
  kind: 'printer',
  address: 'cups://Color_fixture',
  target: 'Color_fixture',
  provider: 'cups',
  mode: 'hardware',
  status: 'unknown',
  location: '',
};
const attributes = {
  'printer-state': 'idle',
  'media-supported': ['iso_a4_210x297mm'],
  'sides-supported': ['one-sided'],
};
async function submit(color?: PrintOptions['color']) {
  const body = await multipart(await pdf(), 'application/pdf', printer.id, { color });
  return f!.app.inject({
    method: 'POST',
    url: '/api/print',
    headers: { ...f!.headers, 'content-type': body.contentType },
    payload: body.payload,
  });
}

it.each([
  ['color only', ['color']],
  ['monochrome only', ['monochrome']],
  ['both modes', [...PRINT_COLOR_MODES]],
  ['single IPP keyword', 'color'],
  ['empty modes', []],
  [
    'other IPP modes without an explicit application mapping',
    ['auto', 'bi-level', 'process-monochrome'],
  ],
])(
  'enforces %s from IPP to stored options and command values (stubbed CUPS)',
  async (_name, advertised) => {
    const modes = PRINT_COLOR_MODES.filter((mode) =>
      (Array.isArray(advertised) ? advertised : [advertised]).includes(mode),
    );
    const run = vi.fn().mockResolvedValue('request id is Color_fixture-42 (1 file(s))\n');
    // The legacy summary cannot override exact advertised modes.
    const request = vi.fn().mockResolvedValue({
      ...attributes,
      'print-color-mode-supported': advertised,
      'color-supported': !modes.includes('color'),
    });
    f = await fixture({
      mode: 'hardware',
      users: false,
      provider: new HardwareProvider('localhost:631', run, request),
    });
    f.store.putDevice(printer);
    expect((await f.service.snapshot()).devices[0].capabilities).toMatchObject({
      colorModes: modes,
      color: modes.includes('color'),
    });
    for (const mode of PRINT_COLOR_MODES) {
      run.mockClear();
      const before = f.store.jobs('hardware').length;
      const files = await readdir(f.service.filesDir);
      const response = await submit(mode);
      if (modes.includes(mode)) {
        expect(response.statusCode, response.body).toBe(201);
        const job = response.json<Job>();
        expect(job.options).toMatchObject({ color: mode });
        expect(f.store.job(job.id, 'hardware')!.options).toMatchObject({ color: mode });
        expect(run).toHaveBeenCalledExactlyOnceWith(
          'lp',
          expect.arrayContaining([`print-color-mode=${mode}`]),
        );
        expect(
          run.mock.calls[0][1].filter((arg: string) => arg.startsWith('print-color-mode=')),
        ).toEqual([`print-color-mode=${mode}`]);
      } else {
        expect(response.statusCode, response.body).toBe(400);
        expect(run).not.toHaveBeenCalled();
        expect(f.store.jobs('hardware')).toHaveLength(before);
        expect(await readdir(f.service.filesDir)).toEqual(files);
      }
    }
  },
);

it.each([
  ['missing modes', {}],
  ['null modes', { 'print-color-mode-supported': null }],
  ['legacy color summary only', { 'color-supported': true }],
  ['legacy monochrome summary only', { 'color-supported': false }],
  ['unreachable printer', undefined],
])('blocks %s without assuming either color mode (stubbed IPP)', async (_name, extra) => {
  const run = vi.fn();
  const request =
    extra === undefined
      ? vi.fn().mockRejectedValue(new Error('Unreachable fixture'))
      : vi.fn().mockResolvedValue({ ...attributes, ...extra });
  f = await fixture({
    mode: 'hardware',
    users: false,
    provider: new HardwareProvider('localhost:631', run, request),
  });
  f.store.putDevice(printer);
  expect((await f.service.snapshot()).devices[0].capabilities?.colorModes).toBeUndefined();
  for (const mode of PRINT_COLOR_MODES) expect((await submit(mode)).statusCode).toBe(409);
  expect(run).not.toHaveBeenCalled();
  expect(f.store.jobs('hardware')).toEqual([]);
  expect(await readdir(f.service.filesDir)).toEqual([]);
});

it('rechecks changed modes for uploads and saved documents without changing existing jobs (stubbed CUPS)', async () => {
  const run = vi.fn().mockResolvedValue('request id is Color_fixture-42 (1 file(s))\n');
  const request = vi
    .fn()
    .mockResolvedValue({ ...attributes, 'print-color-mode-supported': [...PRINT_COLOR_MODES] });
  f = await fixture({
    mode: 'hardware',
    users: false,
    provider: new HardwareProvider('localhost:631', run, request),
  });
  f.store.putDevice(printer);
  expect((await f.service.snapshot()).devices[0].capabilities?.colorModes).toEqual(
    PRINT_COLOR_MODES,
  );
  const old = (await submit('monochrome')).json<Job>();
  const stored = f.store.job(old.id, 'hardware');
  request.mockResolvedValue({ ...attributes, 'print-color-mode-supported': ['color'] });
  run.mockClear();
  // The schema's legacy default must also be checked, never silently submitted.
  expect((await submit()).statusCode).toBe(400);
  const options: PrintOptions = {
    copies: 1,
    color: 'monochrome',
    sides: 'one-sided',
    media: 'iso_a4_210x297mm',
  };
  await expect(f.service.printSaved(old.id, printer.id, options)).rejects.toMatchObject({
    statusCode: 400,
  });
  expect(run).not.toHaveBeenCalled();
  expect(f.store.jobs('hardware')).toHaveLength(1);
  const next = await f.service.printSaved(old.id, printer.id, { ...options, color: 'color' });
  expect(next.options).toMatchObject({ color: 'color' });
  expect(run).toHaveBeenCalledExactlyOnceWith(
    'lp',
    expect.arrayContaining(['print-color-mode=color']),
  );
  expect(f.store.job(old.id, 'hardware')).toEqual(stored);
});

it('refreshes legacy demo capabilities after restart while preserving stored job color options', async () => {
  f = await fixture({ users: false });
  const printers = f.store.devices('demo').filter((device) => device.kind === 'printer');
  const colorPrinter = printers.find((device) => device.capabilities!.color)!;
  const old = await f.service.print(
    colorPrinter.id,
    await pdf(),
    'application/pdf',
    'Existing PDF',
    {
      copies: 1,
      color: 'color',
      sides: 'one-sided',
      media: 'iso_a4_210x297mm',
    },
  );
  const stored = f.store.job(old.id, 'demo');
  for (const device of printers) {
    delete device.capabilities!.colorModes;
    f.store.putDevice(device);
  }
  const dataDir = f.dataDir;
  await f.close(false);
  f = await fixture({ dataDir, users: false });
  const snapshot = await f.service.snapshot();
  for (const device of snapshot.devices.filter((device) => device.kind === 'printer')) {
    expect(device.capabilities!.colorModes).toEqual(
      device.id === colorPrinter.id ? PRINT_COLOR_MODES : ['monochrome'],
    );
  }
  expect(f.store.job(old.id, 'demo')).toEqual(stored);
});
