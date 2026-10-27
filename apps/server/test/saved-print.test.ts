import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import type { Job, PrintOptions } from '@openwebprint/shared';
import { publicJob } from '../src/store.js';
import { fixture, pdf } from './helpers.js';

let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await f?.close();
  f = undefined;
});
const options: PrintOptions = {
  copies: 2,
  color: 'monochrome',
  sides: 'one-sided',
  media: 'iso_a4_210x297mm',
};
function printer() {
  return f!.store.devices('demo').find((d) => d.kind === 'printer')!;
}
async function retained() {
  return f!.service.print(printer().id, await pdf(), 'application/pdf', 'Saved PDF', options);
}
async function scan() {
  const device = f!.store.devices('demo').find((d) => d.kind === 'scanner')!;
  const job = f!.service.scan(device.id, { resolution: 150, color: 'Gray' });
  await f!.service.close();
  return publicJob(f!.service.job(job.id));
}
function submit(source: Job, body: Record<string, unknown> = {}) {
  return f!.app.inject({
    method: 'POST',
    url: `/api/jobs/${source.id}/print`,
    headers: f!.headers,
    payload: { deviceId: printer().id, options, revision: source.scanRevision, ...body },
  });
}

it.each(['scan', 'print'])(
  'prints a saved %s into independent jobs without changing the source (demo provider)',
  async (kind) => {
    f = await fixture({ users: false });
    const source = kind === 'scan' ? await scan() : await retained();
    const original = f.service.job(source.id);
    const document = await readFile(original.filePath!);
    const response = await submit(source);
    expect(response.statusCode, response.body).toBe(201);
    const first = response.json<Job>();
    const second = (await submit(source)).json<Job>();
    expect(new Set([source.id, first.id, second.id]).size).toBe(3);
    expect(first).toMatchObject({ kind: 'print', options, hasFile: true });
    expect(f.service.job(source.id)).toEqual(original);
    if (kind === 'scan') {
      await f.service.editScan(source.id, source.scanRevision!, [
        { ...source.pages![0], rotation: 90 },
      ]);
      expect(await readFile(f.service.job(first.id).filePath!)).toEqual(document);
    } else {
      // The source can be an in-progress print; only the independent data is reused.
      const job = f.service.job(source.id);
      job.status = 'completed';
      f.store.putJob(job);
    }
    await f.service.deleteJob(source.id);
    for (const job of [first, second]) {
      const saved = await readFile(f.service.job(job.id).filePath!);
      expect(saved).toEqual(document);
      expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);
      expect(
        (await f.app.inject({ url: `/api/jobs/${job.id}/pdf`, headers: f.headers })).statusCode,
      ).toBe(200);
    }
  },
);

it.each(['deleted file', 'expired', 'no retained file', 'deleted record'])(
  'rejects %s before contacting the printer',
  async (failure) => {
    f = await fixture({ users: false });
    const source = await retained();
    const job = f.service.job(source.id);
    if (failure === 'deleted file') await unlink(job.filePath!);
    if (failure === 'expired') job.createdAt = new Date(Date.now() - 8 * 86400_000).toISOString();
    if (failure === 'no retained file') job.hasFile = false;
    f.store.putJob(job);
    if (failure === 'deleted record') f.store.deleteJob(source.id, 'demo');
    const inspect = vi.spyOn(f.service.provider, 'inspect');
    const print = vi.spyOn(f.service.provider, 'print');
    const result = await submit(source);
    expect(result.statusCode).toBe(failure === 'deleted record' ? 404 : 410);
    expect(result.json().error).toMatch(/document|Job not found/);
    expect(inspect).not.toHaveBeenCalled();
    expect(print).not.toHaveBeenCalled();
    if (failure === 'deleted file' || failure === 'expired') {
      const preview = await f.app.inject({
        url: `/api/jobs/${source.id}/document`,
        headers: f.headers,
      });
      expect(preview.statusCode).toBe(410);
      expect(preview.json().error).toContain('document');
    }
  },
);

it('prints an internally generated PDF larger than the upload limit without another upload', async () => {
  f = await fixture({ users: false });
  const source = await scan();
  // Padding models a large scan while keeping a small, valid single-page PDF fixture.
  await appendFile(f.service.job(source.id).filePath!, Buffer.alloc(25 * 1024 * 1024, 32));
  const response = await submit(source);
  expect(response.statusCode, response.body).toBe(201);
  const printed = await readFile(f.service.job(response.json<Job>().id).filePath!);
  expect(printed.equals(await readFile(f.service.job(source.id).filePath!))).toBe(true);
});

it('rejects an edited or running scan rather than printing an unreviewed revision', async () => {
  f = await fixture({ users: false });
  const source = await scan();
  await f.service.editScan(source.id, source.scanRevision!, [
    { ...source.pages![0], rotation: 90 },
  ]);
  expect((await submit(source)).statusCode).toBe(409);
  const latest = publicJob(f.service.job(source.id));
  expect((await submit(latest, { revision: undefined })).statusCode).toBe(409);
  const job = f.service.job(source.id);
  job.status = 'processing';
  f.store.putJob(job);
  const print = vi.spyOn(f.service.provider, 'print');
  expect((await submit(latest)).statusCode).toBe(409);
  expect(print).not.toHaveBeenCalled();
});

it.each(['deletion', 'expiration', 'scan edit'])(
  'keeps a private document snapshot when %s races with submission',
  async (race) => {
    f = await fixture({ users: false });
    const source = await scan();
    const data = await readFile(f.service.job(source.id).filePath!);
    const provider = f.service.provider;
    const inspect = provider.inspect.bind(provider);
    vi.spyOn(provider, 'inspect').mockImplementationOnce(async (device) => {
      if (race === 'deletion') await f!.service.deleteJob(source.id);
      if (race === 'expiration') {
        const job = f!.service.job(source.id);
        job.createdAt = new Date(Date.now() - 8 * 86400_000).toISOString();
        f!.store.putJob(job);
        await f!.service.expireFiles();
      }
      if (race === 'scan edit')
        await f!.service.editScan(source.id, source.scanRevision!, [
          { ...source.pages![0], rotation: 90 },
        ]);
      return inspect(device);
    });
    const result = await submit(source);
    expect(result.statusCode, result.body).toBe(201);
    expect(await readFile(f.service.job(result.json<Job>().id).filePath!)).toEqual(data);
    if (race === 'deletion') expect(f.store.job(source.id, 'demo')).toBeUndefined();
    if (race === 'expiration') expect(f.service.job(source.id).hasFile).toBe(false);
    if (race === 'scan edit')
      expect(f.service.job(source.id).scanRevision).not.toBe(source.scanRevision);
  },
);

it.each(['offline', 'unavailable capabilities', 'changed capabilities'])(
  'rechecks the destination and rejects %s without creating a job',
  async (failure) => {
    f = await fixture({ users: false });
    const source = await retained();
    vi.spyOn(f.service.provider, 'inspect').mockResolvedValue({
      ...printer(),
      status: failure === 'offline' ? 'offline' : 'ready',
      capabilities:
        failure === 'unavailable capabilities'
          ? undefined
          : {
              color: false,
              sides: ['one-sided'],
              media: ['iso_a5_148x210mm'],
            },
    });
    const print = vi.spyOn(f.service.provider, 'print');
    expect((await submit(source)).statusCode).toBe(failure === 'changed capabilities' ? 400 : 409);
    expect(print).not.toHaveBeenCalled();
    expect(f.store.jobs('demo')).toHaveLength(1);
  },
);

it('records unknown outcomes once and only reprints on another explicit submission (stubbed printer)', async () => {
  f = await fixture({ users: false });
  const source = await retained();
  const print = vi
    .spyOn(f.service.provider, 'print')
    .mockRejectedValue(new Error('Submission unconfirmed. Check the printer.'));
  const response = await submit(source);
  expect(response.statusCode).toBe(201);
  const unknown = response.json<Job>();
  expect(unknown.status).toBe('unknown');
  await f.service.tick();
  expect(print).toHaveBeenCalledTimes(1);
  const reprint = await submit(unknown);
  expect(reprint.json<Job>().id).not.toBe(unknown.id);
  expect(print).toHaveBeenCalledTimes(2);
});

it('preserves authentication, origin, mode, and input boundaries', async () => {
  f = await fixture();
  const source = await retained();
  const url = `/api/jobs/${source.id}/print`;
  const payload = { deviceId: printer().id, options };
  expect(
    (await f.app.inject({ method: 'POST', url, headers: { 'x-openwebprint': '1' }, payload }))
      .statusCode,
  ).toBe(401);
  expect(
    (await f.app.inject({ method: 'POST', url, headers: { cookie: f.cookie }, payload }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url,
        headers: { ...f.headers, origin: 'https://evil.example' },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  for (const body of [
    { options: { copies: 100 } },
    { deviceId: 'bad-id' },
    { filePath: '/etc/passwd' },
    { deviceId: f.store.devices('demo').find((d) => d.kind === 'scanner')!.id },
  ])
    expect((await submit(source, body)).statusCode).toBe(400);
  const foreignDevice = { ...printer(), id: randomUUID(), mode: 'hardware' as const };
  f.store.putDevice(foreignDevice);
  const unavailablePrinter = await submit(source, { deviceId: foreignDevice.id });
  expect(unavailablePrinter.statusCode).toBe(404);
  expect(unavailablePrinter.json().error).toContain('Select another printer');
  const stored = f.service.job(source.id);
  f.store.putJob({ ...stored, id: randomUUID(), mode: 'hardware' });
  const foreign = f.store.jobs('hardware')[0];
  expect((await submit(publicJob(foreign))).statusCode).toBe(404);
  expect(f.store.jobs('demo')).toHaveLength(1);
});
