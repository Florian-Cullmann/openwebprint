import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { scanOptionsSchema, type Device, type Job, type ScanSources } from '@openwebprint/shared';
import { saneCapabilities } from '../src/providers/sane-capabilities.js';
import { HardwareProvider } from '../src/providers/hardware.js';
import { DemoProvider } from '../src/providers/demo.js';
import { fixture } from './helpers.js';

// Synthetic C-locale scanimage output; no physical compatibility claim.
const sources = '    --source Flatbed|ADF [Flatbed]\n';
const flatbed = `${sources}    --resolution 75|200|300|1200dpi [200]\n    --mode Color|Grayscale|Lineart [Color]\n`;
const feeder = `${sources}    --resolution 100..400dpi (in steps of 100) [100]\n    --mode Grayscale|Lineart [Grayscale]\n`;
const scanner: Device = {
  id: randomUUID(),
  name: 'SANE fixture',
  kind: 'scanner',
  mode: 'hardware',
  address: 'airscan:e0:Fixture',
  target: 'airscan:e0:Fixture',
  provider: 'sane',
  status: 'unknown',
  location: '',
};
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

it.each([
  ['75|200|300|1200dpi [200]', [75, 200, 300, 1200], 200],
  ['600|150|300|150dpi [300]', [150, 300, 600], 300],
  ['100..400dpi (in steps of 100) [100]', { min: 100, max: 400, step: 100 }, 100],
  ['75..1200dpi [300]', { min: 75, max: 1200 }, 300],
  ['75.5..600.5dpi (in steps of 0.5) [150.5]', { min: 75.5, max: 600.5, step: 0.5 }, 150.5],
  ['0..20000dpi (in steps of 100) [300]', { min: 100, max: 9600, step: 100 }, 300],
  ['20000|30000dpi [20000]', [], undefined],
  ['150|300dpi [inactive]', [], undefined],
  ['150|300dpi [300] [read-only]', [], undefined],
  ['{no_wordlist}dpi [300]', [], undefined],
  ['auto|150|300dpi [300]', [150, 300], 300],
  ['<int> [300]', undefined, undefined],
  ['600..75dpi [300]', undefined, undefined],
  ['75..600dpi (in steps of 0) [300]', undefined, undefined],
  ['not-a-range [300]', undefined, undefined],
])(
  'parses resolution constraints: %s (synthetic SANE fixture)',
  (value, resolutions, defaultResolution) => {
    const caps = saneCapabilities(`    --resolution ${value}\n        Sets the resolution.\n`);
    expect(caps.resolutions).toEqual(resolutions);
    expect(caps.defaultResolution).toBe(defaultResolution);
  },
);

it('keeps exact mode names, wrapped lists, defaults, and unknown versus unavailable values', () => {
  expect(
    saneCapabilities(`${sources}    --mode Color|Grayscale|\n        Black & White [Grayscale]\n`),
  ).toMatchObject({
    colorModes: ['Color', 'Grayscale', 'Black & White'],
    defaultColorMode: 'Grayscale',
  });
  expect(saneCapabilities('    --mode Color|Gray [inactive]\n').colorModes).toEqual([]);
  expect(saneCapabilities('    --mode {no_stringlist} [Color]\n').colorModes).toEqual([]);
  expect(saneCapabilities('    --mode <string> [Color]\n').colorModes).toBeUndefined();
  expect(saneCapabilities('Scanner disconnected').resolutions).toBeUndefined();
  expect(saneCapabilities('    --duplex[=(yes|no)] [inactive]\n').duplex).toBe(false);
});

function transport() {
  return vi.fn(async (_executable: string, args: string[]) => {
    if (args.includes('--all-options')) return args.includes('ADF') ? feeder : flatbed;
    const path = args[args.indexOf('--output-file') + 1];
    await writeFile(
      path,
      await sharp({ create: { width: 100, height: 200, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
    );
    return '';
  });
}

it('queries source-specific settings and enforces them before acquisition (stubbed SANE)', async () => {
  const run = transport();
  const provider = new HardwareProvider('localhost:631', run);
  expect((await provider.scanSources(scanner)).resolutions).toEqual([75, 200, 300, 1200]);
  expect(await provider.scanSources(scanner, 'ADF')).toMatchObject({
    resolutions: { min: 100, max: 400, step: 100 },
    colorModes: ['Grayscale', 'Lineart'],
  });
  expect(run).toHaveBeenLastCalledWith(
    'scanimage',
    ['--device-name', scanner.target, '--source', 'ADF', '--all-options'],
    20_000,
  );
  for (const options of [
    { resolution: 150, color: 'Grayscale', source: 'ADF' },
    { resolution: 300, color: 'Color', source: 'ADF' },
    { resolution: 600, color: 'Grayscale', source: 'ADF' },
    { resolution: 300, color: 'Gray' },
  ]) {
    run.mockClear();
    await expect(provider.scan(scanner, '/unused.png', options)).rejects.toThrow(
      'does not support',
    );
    expect(run.mock.calls.every(([, args]) => args.includes('--all-options'))).toBe(true);
  }
  await expect(provider.scanSources(scanner, 'Unadvertised')).rejects.toThrow('selected source');
});

it('returns safe unknown capabilities after discovery failures and only allows bounded fallback settings', async () => {
  const run = vi.fn(async (_tool: string, args: string[]) => {
    if (args.includes('--all-options')) throw new Error('private-device-address');
    return '';
  });
  const provider = new HardwareProvider('localhost:631', run);
  const caps = await provider.scanSources(scanner);
  expect(caps.warning).toContain('could not be determined');
  expect(caps.resolutions).toBeUndefined();
  expect(caps.colorModes).toBeUndefined();
  expect(JSON.stringify(caps)).not.toContain('private-device-address');
  await provider.scan(scanner, '/unused.png', { resolution: 300, color: 'Gray' });
  await expect(
    provider.scan(scanner, '/unused.png', { resolution: 200, color: 'Gray' }),
  ).rejects.toThrow('resolution');
  await expect(
    provider.scan(scanner, '/unused.png', { resolution: 300, color: 'Lineart' }),
  ).rejects.toThrow('color mode');
});

it('does not reuse default-source capabilities when the selected-source query fails', async () => {
  const run = vi.fn(async (_tool: string, args: string[]) => {
    if (args.includes('--source')) throw new Error('private-backend-message');
    return flatbed;
  });
  const caps = await new HardwareProvider('localhost:631', run).scanSources(scanner, 'ADF');
  expect(caps.sources).toHaveLength(2);
  expect(caps.warning).toBeTruthy();
  expect(caps.resolutions).toBeUndefined();
  expect(caps.colorModes).toBeUndefined();
});

it('supports discovered values through the API and rechecks settings at execution (stubbed SANE)', async () => {
  const run = transport();
  f = await fixture({
    mode: 'hardware',
    users: false,
    provider: new HardwareProvider('localhost:631', run),
  });
  f.store.putDevice(scanner);
  const endpoint = `/api/devices/${scanner.id}/scan-sources`;
  const caps = await f.app.inject(endpoint + '?source=ADF');
  expect(caps.statusCode).toBe(200);
  expect(caps.json<ScanSources>().colorModes).toEqual(['Grayscale', 'Lineart']);
  expect((await f.app.inject(endpoint + '?source=%00')).statusCode).toBe(400);
  for (const [resolution, color, valid] of [
    [200, 'Lineart', true],
    [150, 'Color', false],
  ] as const) {
    run.mockClear();
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/scans',
      headers: f.headers,
      payload: { deviceId: scanner.id, options: { resolution, color, source: 'ADF' } },
    });
    expect(response.statusCode, response.body).toBe(202);
    await f.service.close();
    const job = f.service.job(response.json<Job>().id);
    expect(job.status).toBe(valid ? 'completed' : 'failed');
    expect(job.hasFile).toBe(valid);
    expect(run.mock.calls.some(([, args]) => args.includes('--format=png'))).toBe(valid);
    if (valid) expect(job.options).toMatchObject({ resolution: 200, color: 'Lineart' });
    else expect(job.error).toContain('resolution');
  }
});

it('keeps demo settings deterministic and rejects out-of-capability options', async () => {
  const demo = new DemoProvider();
  expect(await demo.scanSources()).toEqual(await demo.scanSources());
  expect(await demo.scanSources()).toMatchObject({
    resolutions: [150, 300, 600],
    colorModes: ['Color', 'Gray'],
  });
  await expect(
    demo.scan(scanner, '/unused.png', { resolution: 200, color: 'Color' }),
  ).rejects.toThrow('resolution');
  expect(scanOptionsSchema.safeParse({ resolution: 9601, color: 'Color' }).success).toBe(false);
  expect(scanOptionsSchema.safeParse({ resolution: 200, color: 'Gray\n--help' }).success).toBe(
    false,
  );
});

it('rechecks capabilities after discovery instead of trusting previously advertised choices', async () => {
  const run = vi.fn().mockResolvedValue(flatbed);
  const provider = new HardwareProvider('localhost:631', run);
  expect((await provider.scanSources(scanner)).resolutions).toContain(1200);
  run.mockResolvedValue(feeder);
  run.mockClear();
  await expect(
    provider.scan(scanner, '/unused.png', { resolution: 1200, color: 'Color' }),
  ).rejects.toThrow('resolution');
  expect(run).toHaveBeenCalledExactlyOnceWith(
    'scanimage',
    ['--device-name', scanner.target, '--all-options'],
    20_000,
  );
});

it.each([
  ['    --resolution 150|300dpi [inactive]\n    --mode Color|Gray [Color]\n', 'resolution'],
  ['    --resolution 150|300dpi [300]\n    --mode Color|Gray [inactive]\n', 'color mode'],
])('blocks unavailable settings without treating them as unknown: %s', async (output, error) => {
  const run = vi.fn().mockResolvedValue(output);
  const provider = new HardwareProvider('localhost:631', run);
  await expect(
    provider.scan(scanner, '/unused.png', { resolution: 300, color: 'Color' }),
  ).rejects.toThrow(error);
  expect(run.mock.calls.every(([, args]) => args.includes('--all-options'))).toBe(true);
});
