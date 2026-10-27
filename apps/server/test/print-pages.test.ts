import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PDFDocument, degrees } from 'pdf-lib';
import { resolvePrintPages, formatPrintPages, type Device, type Job } from '@openwebprint/shared';
import { HardwareProvider } from '../src/providers/hardware.js';
import { fixture, multipart } from './helpers.js';

it.each([
  [{}, [1, 2, 3, 4, 5, 6, 7]],
  [{ pageRanges: ' 7, 1 - 3, 2, 3-4 ' }, [1, 2, 3, 4, 7]],
  [{ pageRanges: '1-3, 7', pageParity: 'odd' as const }, [1, 3, 7]],
  [{ pageRanges: '1-3, 7', pageParity: 'even' as const }, [2]],
  [{ pageParity: 'even' as const }, [2, 4, 6]],
  [{ pageParity: 'odd' as const }, [1, 3, 5, 7]],
])('resolves original page numbers, deduplicates and sorts %j', (selection, pages) => {
  expect(resolvePrintPages(7, selection)).toEqual(pages);
  expect(resolvePrintPages(7, { pageRanges: formatPrintPages(pages) })).toEqual(pages);
});

it.each([
  '',
  ' ',
  '0',
  '-1',
  '01',
  '1.5',
  '1e2',
  '1-',
  '-3',
  '3-1',
  '1,,2',
  '1,',
  '1 2',
  'all',
  '1;2',
  '1–3',
  '8',
  '1-8',
  '9999999999999999999',
  '1'.repeat(2001),
])('rejects invalid or out-of-bounds range %j', (pageRanges) =>
  expect(() => resolvePrintPages(7, { pageRanges })).toThrow(),
);
it('rejects empty parity intersections and checks bounds before filtering', () => {
  expect(() => resolvePrintPages(1, { pageParity: 'even' })).toThrow(/no pages/);
  expect(() => resolvePrintPages(7, { pageRanges: '2,4', pageParity: 'odd' })).toThrow(/no pages/);
  expect(() => resolvePrintPages(7, { pageRanges: '1-8', pageParity: 'odd' })).toThrow(
    /between 1 and 7/,
  );
});

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
const printer: Device = {
  id: randomUUID(),
  name: 'Page selection fixture',
  kind: 'printer',
  address: 'cups://Pages_fixture',
  target: 'Pages_fixture',
  provider: 'cups',
  mode: 'hardware',
  status: 'unknown',
  location: '',
};
async function sourcePdf() {
  const pdf = await PDFDocument.create();
  for (let number = 1; number <= 7; number++) {
    const page = pdf.addPage([400 + number, 600]);
    page.drawText(`Original page ${number}`);
    if (number === 3) page.setRotation(degrees(90));
  }
  return Buffer.from(await pdf.save());
}
async function setup() {
  const submitted: Buffer[] = [];
  const run = vi.fn(async (_tool: string, args: string[]) => {
    submitted.push(await readFile(args.at(-1)!));
    return 'request id is Pages_fixture-42 (1 file(s))';
  });
  const request = vi.fn().mockResolvedValue({
    'printer-state': 'idle',
    'media-supported': ['iso_a4_210x297mm'],
    'print-color-mode-supported': ['monochrome'],
    'sides-supported': ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'],
  });
  f = await fixture({
    mode: 'hardware',
    users: false,
    provider: new HardwareProvider('localhost:631', run, request),
  });
  f.store.putDevice(printer);
  return { run, submitted };
}
async function upload(options: Record<string, unknown>) {
  const body = await multipart(await sourcePdf(), 'application/pdf', printer.id, options);
  return f!.app.inject({
    method: 'POST',
    url: '/api/print',
    headers: { ...f!.headers, 'content-type': body.contentType },
    payload: body.payload,
  });
}
async function pageNumbers(buffer: Buffer) {
  return (await PDFDocument.load(buffer)).getPages().map((page) => page.getWidth() - 400);
}

it.each(['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'])(
  'sends only selected PDF pages to the actual hardware provider with %s (stubbed CUPS transport)',
  async (sides) => {
    const { run, submitted } = await setup();
    const selection = { pageRanges: '7, 1-3, 3', pageParity: 'odd', copies: 2, sides };
    const response = await upload(selection);
    expect(response.statusCode, response.body).toBe(201);
    const job = response.json<Job>();
    expect(job.options).toMatchObject(selection);
    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['-n', '2', `sides=${sides}`]));
    expect(args.join(' ')).not.toMatch(/page-ranges|page-set/);
    expect(await pageNumbers(submitted[0])).toEqual([1, 3, 7]);
    expect((await PDFDocument.load(submitted[0])).getPage(1).getRotation().angle).toBe(90);
    expect(await readFile(f!.service.job(job.id).filePath!)).toEqual(submitted[0]);
    // Reprinting defaults to every page of the retained selection, without filtering twice.
    const again = await f!.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/print`,
      headers: f!.headers,
      payload: { deviceId: printer.id, options: {} },
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(await pageNumbers(submitted[1])).toEqual([1, 3, 7]);
    const subset = await f!.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/print`,
      headers: f!.headers,
      payload: { deviceId: printer.id, options: { pageRanges: '2' } },
    });
    expect(subset.statusCode, subset.body).toBe(201);
    expect(await pageNumbers(submitted[2])).toEqual([3]);
    expect(await readFile(f!.service.job(job.id).filePath!)).toEqual(submitted[0]);
  },
);

it('keeps all pages by default and applies standalone parity (stubbed CUPS)', async () => {
  const { submitted } = await setup();
  expect((await upload({})).statusCode).toBe(201);
  expect(await pageNumbers(submitted[0])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect((await upload({ pageParity: 'even' })).statusCode).toBe(201);
  expect(await pageNumbers(submitted[1])).toEqual([2, 4, 6]);
});

it('rejects invalid selections on upload and saved-document APIs before retaining or submitting content', async () => {
  const { run } = await setup();
  const source = (await upload({})).json<Job>();
  const files = await readdir(f!.service.filesDir);
  run.mockClear();
  for (const options of [
    { pageRanges: '' },
    { pageRanges: '1,,2' },
    { pageRanges: '8' },
    { pageRanges: '2-1' },
    { pageRanges: '2,4', pageParity: 'odd' },
    { pageRanges: '1-8', pageParity: 'odd' },
    { pageRanges: 2 },
    { pageParity: 'invalid' },
  ]) {
    expect((await upload(options)).statusCode).toBe(400);
    const response = await f!.app.inject({
      method: 'POST',
      url: `/api/jobs/${source.id}/print`,
      headers: f!.headers,
      payload: { deviceId: printer.id, options },
    });
    expect(response.statusCode, response.body).toBe(400);
  }
  expect(run).not.toHaveBeenCalled();
  expect(f!.store.jobs('hardware')).toHaveLength(1);
  expect(await readdir(f!.service.filesDir)).toEqual(files);
});
