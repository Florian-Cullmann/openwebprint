import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createDeflate, crc32 } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import {
  MAX_SCAN_PIXELS,
  SCAN_SIZE_ERROR,
  scanSettingsError,
  type Device,
  type Job,
} from '@openwebprint/shared';
import { saneCapabilities } from '../src/providers/sane-capabilities.js';
import { HardwareProvider } from '../src/providers/hardware.js';
import { renderScanPage } from '../src/documents.js';
import { fixture } from './helpers.js';

// Valid synthetic grayscale PNGs compressed a row at a time, avoiding a 139 MB
// raw fixture allocation. Transport is controlled; no physical scanner is used.
async function png(width: number, height: number) {
  function chunk(type: string, data: Buffer) {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(data, crc32(name)));
    return Buffer.concat([length, name, data, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const row = Buffer.alloc(width + 1); // filter byte followed by grayscale pixels
  const compressed = Readable.from(
    (function* () {
      for (let y = 0; y < height; y++) yield row;
    })(),
  ).pipe(createDeflate());
  const chunks: Buffer[] = [];
  for await (const data of compressed) chunks.push(data);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.concat(chunks)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const scanner: Device = {
  id: randomUUID(),
  name: 'Pixel budget fixture',
  kind: 'scanner',
  mode: 'hardware',
  address: 'airscan:e0:Fixture',
  target: 'airscan:e0:Fixture',
  provider: 'sane',
  status: 'unknown',
  location: '',
};
const settings = '    --resolution 300|600|1200dpi [300]\n    --mode Color|Gray [Color]\n';
const area = (width: number, height: number) =>
  `    -x 0..216mm [${width}]\n    -y 0..356mm [${height}]\n`;
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

it('checks the full current area, keeps smaller 1200 dpi scans, and treats missing geometry as unknown', () => {
  const options = { resolution: 1200, color: 'Color' };
  expect(scanSettingsError(saneCapabilities(settings + area(210, 297)), options)).toBe(
    SCAN_SIZE_ERROR,
  );
  expect(scanSettingsError(saneCapabilities(settings + area(50, 75)), options)).toBeUndefined();
  expect(scanSettingsError(saneCapabilities(settings), options)).toBeUndefined();
  for (const geometry of [
    '    -x 0..216pel [210]\n    -y 0..356pel [297]\n',
    '    -x 0..216mm [210]\n',
    '    -x 0..216mm [inactive]\n    -y 0..356mm [297]\n',
    '    -x 0..216mm [210] [read-only]\n    -y 0..356mm [297]\n',
    '    -x 0..216mm [210]\n    -y 0..356mm [auto]\n',
    area(0, 297),
  ])
    expect(saneCapabilities(settings + geometry).acquisitionArea).toBeUndefined();
});

it('rejects known A4 at 1200 dpi before acquisition and reapplies a small area (stubbed SANE)', async () => {
  let geometry = area(210, 297);
  const run = vi.fn(async (_tool: string, args: string[]) => {
    if (args.includes('--all-options')) return settings + geometry;
    return '';
  });
  const provider = new HardwareProvider('localhost:631', run);
  await expect(
    provider.scan(scanner, '/unused.png', { resolution: 1200, color: 'Color' }),
  ).rejects.toThrow(SCAN_SIZE_ERROR);
  expect(run.mock.calls.every(([, args]) => args.includes('--all-options'))).toBe(true);
  await provider.scan(scanner, '/unused.png', { resolution: 600, color: 'Color' });
  expect(run.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(['-x', '210', '-y', '297']));
  geometry = area(50, 75);
  await provider.scan(scanner, '/unused.png', { resolution: 1200, color: 'Color' });
  expect(run.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(['-x', '50', '-y', '75']));
});

it('exports a small 1200 dpi original and preserves it when unexpected A4 output exceeds the budget (stubbed SANE)', async () => {
  let geometry = area(50, 75);
  let image = await png(2362, 3543);
  const run = vi.fn(async (_tool: string, args: string[]) => {
    if (args.includes('--all-options')) return settings + geometry;
    await writeFile(args[args.indexOf('--output-file') + 1], image);
    return '';
  });
  f = await fixture({
    mode: 'hardware',
    users: false,
    provider: new HardwareProvider('localhost:631', run),
  });
  f.store.putDevice(scanner);
  async function scan(jobId?: string) {
    const response = await f!.app.inject({
      method: 'POST',
      url: '/api/scans',
      headers: f!.headers,
      payload: { deviceId: scanner.id, jobId, options: { resolution: 1200, color: 'Color' } },
    });
    expect(response.statusCode).toBe(202);
    await f!.service.close();
    return f!.service.job(response.json<Job>().id);
  }
  const saved = await scan();
  expect(saved.status).toBe('completed');
  expect(saved.hasFile).toBe(true);
  const pdf = await readFile(saved.filePath!);
  const preview = await readFile(saved.previewPath!);
  const page = (await PDFDocument.load(pdf)).getPage(0);
  expect(page.getWidth()).toBeCloseTo((2362 * 72) / 1200);
  expect(page.getHeight()).toBeCloseTo((3543 * 72) / 1200);

  const cached = await f.app.inject(`/api/devices/${scanner.id}/scan-sources`);
  expect(cached.json().acquisitionArea).toEqual({ widthMm: 50, heightMm: 75 });
  geometry = area(210, 297);
  const acquisitions = () =>
    run.mock.calls.filter(([, args]) => args.includes('--format=png')).length;
  const before = acquisitions();
  const rejected = await scan(saved.id);
  expect(rejected.error).toBe(SCAN_SIZE_ERROR);
  expect(rejected.scanRevision).toBe(saved.scanRevision);
  expect(rejected.scanPages).toEqual(saved.scanPages);
  expect(await readFile(rejected.filePath!)).toEqual(pdf);
  expect(acquisitions()).toBe(before);

  // A backend can return too much even with a known small area, or have no
  // geometry at all. Both cases must fail with an actionable error atomically.
  image = await png(9921, 14031);
  expect(9921 * 14031).toBeGreaterThan(MAX_SCAN_PIXELS);
  for (const currentGeometry of [area(50, 75), '']) {
    geometry = currentGeometry;
    const appended = await scan(saved.id);
    expect(appended.status).toBe('completed');
    expect(appended.error).toBe(SCAN_SIZE_ERROR);
    expect(appended.scanRevision).toBe(saved.scanRevision);
    expect(appended.scanPages).toEqual(saved.scanPages);
    expect(appended.scanRecovery).toBeUndefined();
    expect(await readFile(appended.filePath!)).toEqual(pdf);
    expect(await readFile(appended.previewPath!)).toEqual(preview);
    await access(appended.scanPages![0].path);
    const download = await f.app.inject({ url: `/api/jobs/${saved.id}/pdf`, headers: f.headers });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(pdf);
  }
  const failed = await scan();
  expect(failed.status).toBe('failed');
  expect(failed.hasFile).toBe(false);
  expect(failed.error).toBe(SCAN_SIZE_ERROR);
  const publicJob = await f.app.inject(`/api/jobs/${failed.id}`);
  expect(publicJob.statusCode).toBe(200);
  expect(publicJob.json()).toMatchObject({
    error: SCAN_SIZE_ERROR,
    errorMessages: [{ code: 'scan_size_exceeded', params: {} }],
  });
});

it('applies the same budget to legacy rendering before a crop can hide an oversized original', async () => {
  f = await fixture({ users: false });
  const path = `${f.dataDir}/oversized.png`;
  await writeFile(path, await png(9921, 14031));
  await expect(
    renderScanPage({
      id: randomUUID(),
      path,
      rotation: 0,
      crop: { x: 0, y: 0, width: 10, height: 10 },
    }),
  ).rejects.toThrow(SCAN_SIZE_ERROR);
});

it('uses the selected source geometry rather than the default bed size (stubbed SANE)', async () => {
  const run = vi.fn(async (_tool: string, args: string[]) => {
    if (!args.includes('--all-options')) return '';
    return (
      '    --source Flatbed|Photo [Flatbed]\n' +
      settings +
      (args.includes('Photo') ? area(50, 75) : area(210, 297))
    );
  });
  const provider = new HardwareProvider('localhost:631', run);
  const selected = await provider.scanSources(scanner, 'Photo');
  expect(selected.acquisitionArea).toEqual({ widthMm: 50, heightMm: 75 });
  await provider.scan(scanner, '/unused.png', {
    resolution: 1200,
    color: 'Color',
    source: 'Photo',
  });
  expect(run.mock.calls.at(-1)![1]).toEqual(
    expect.arrayContaining(['--source', 'Photo', '-x', '50', '-y', '75']),
  );
});
