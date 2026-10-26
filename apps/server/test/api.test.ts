import { afterEach, describe, expect, it } from 'vitest';
import { access, readdir } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFString, PDFDict } from 'pdf-lib';
import sharp from 'sharp';
import { fixture, multipart, pdf, credentials } from './helpers.js';
import { normalizeDocument, MAX_UPLOAD } from '../src/documents.js';
import { DemoProvider } from '../src/providers/demo.js';
import type { Device, Job } from '@openwebprint/shared';
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
async function upload(data: Buffer, mime = 'application/pdf', options: unknown = {}) {
  const device = f!.store.devices('demo').find((d) => d.kind === 'printer')!;
  const body = await multipart(data, mime, device.id, options);
  return f!.app.inject({
    method: 'POST',
    url: '/api/print',
    headers: { ...f!.headers, 'content-type': body.contentType },
    payload: body.payload,
  });
}
describe('authenticated API and ownership', () => {
  it('protects device, document and mutation endpoints and rejects cross-origin writes', async () => {
    f = await fixture();
    for (const url of ['/api/snapshot', '/api/jobs/00000000-0000-4000-8000-000000000000/pdf'])
      expect((await f.app.inject(url)).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: '/api/devices/discover' })).statusCode).toBe(
      403,
    );
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/devices/discover',
          headers: { 'x-openwebprint': '1' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/devices/discover',
          headers: { ...f.headers, origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/devices/discover',
          headers: { ...f.headers, origin: 'http://localhost:5173' },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('hashes sessions, sets defensive cookies, invalidates logout', async () => {
    f = await fixture();
    const cookieHeader = String(f.login!.headers['set-cookie']);
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('SameSite=Strict');
    expect(cookieHeader).toContain('Secure');
    const stored = f.store.db.prepare('SELECT hash FROM sessions').get()!;
    expect(f.cookie).not.toContain(stored.hash);
    expect(String(f.store.db.prepare('SELECT password FROM users').get()!.password)).not.toContain(
      credentials.password,
    );
    await f.app.inject({ method: 'POST', url: '/api/logout', headers: f.headers });
    expect((await f.app.inject({ url: '/api/snapshot', headers: f.headers })).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: f.headers,
          payload: { ...credentials, password: 'incorrect-password' },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('rate limits credential guessing', async () => {
    f = await fixture();
    for (let i = 0; i < 4; i++)
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/login',
            headers: f.headers,
            payload: { ...credentials, password: 'incorrect-password' },
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: f.headers,
          payload: credentials,
        })
      ).statusCode,
    ).toBe(429);
  });
});
describe('devices and print pipeline', () => {
  it('keeps demo isolated and discovers, deduplicates and removes devices', async () => {
    f = await fixture();
    expect(f.store.devices('demo')).toHaveLength(3);
    const discovered = (
      await f.app.inject({ method: 'POST', url: '/api/devices/discover', headers: f.headers })
    ).json();
    const input = discovered.devices[0];
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/devices',
          headers: f.headers,
          payload: input,
        })
      ).statusCode,
    ).toBe(201);
    expect(f.store.devices('demo')).toHaveLength(3);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/devices',
          headers: f.headers,
          payload: { ...input, address: 'ipp://printer.local/ipp/print' },
        })
      ).statusCode,
    ).toBe(400);
    const device = f.store.devices('demo')[0];
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/devices/${device.id}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(f.store.devices('demo')).toHaveLength(2);
  });
  it('submits a real PDF, removes upload bytes, polls and cancels jobs', async () => {
    f = await fixture();
    const response = await upload(await pdf());
    expect(response.statusCode, response.body).toBe(201);
    const job = response.json<Job>();
    expect(job.status).toBe('queued');
    expect(job).not.toHaveProperty('externalId');
    expect(job).not.toHaveProperty('filePath');
    expect(await readdir(f.service.filesDir)).toEqual([]);
    await f.service.tick();
    expect(f.service.job(job.id).status).toBe('queued');
    const cancel = await f.app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/cancel`,
      headers: f.headers,
    });
    expect(cancel.statusCode).toBe(200);
    await f.service.tick();
    expect(f.service.job(job.id).status).toBe('canceled');
    const second = (await upload(await pdf())).json<Job>();
    const stored = f.service.job(second.id);
    stored.createdAt = new Date(Date.now() - 10_000).toISOString();
    f.store.putJob(stored);
    await f.service.tick();
    expect(f.service.job(second.id).status).toBe('completed');
  });
  it('rejects invalid uploads and unsupported options before creating a job', async () => {
    f = await fixture();
    expect((await upload(Buffer.from('<script>evil</script>'))).statusCode).toBe(415);
    expect((await upload(Buffer.from('%PDF-corrupt'))).statusCode).toBe(422);
    expect((await upload(await pdf(), 'image/png')).statusCode).toBe(415);
    expect((await upload(await pdf(), 'application/pdf', { copies: -1 })).statusCode).toBe(400);
    expect((await upload(await pdf(), 'application/pdf', { color: 'color' })).statusCode).toBe(400);
    expect(f.store.jobs('demo')).toHaveLength(0);
  });
  it('enforces the 25 MB multipart limit without leaving files', async () => {
    f = await fixture();
    const response = await upload(Buffer.alloc(MAX_UPLOAD + 1));
    expect(response.statusCode).toBe(413);
    expect(await readdir(f.service.filesDir)).toEqual([]);
    expect(f.store.jobs('demo')).toHaveLength(0);
  });
  it('converts and validates PNG pixels, rejects spoofed content and strips PDF actions', async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const converted = await normalizeDocument(png, 'image/png');
    expect((await PDFDocument.load(converted)).getPageCount()).toBe(1);
    await expect(normalizeDocument(png, 'application/pdf')).rejects.toThrow('Only valid');
    const source = await PDFDocument.create();
    source.addPage();
    source.catalog.set(
      PDFName.of('OpenAction'),
      source.context.obj({ S: 'JavaScript', JS: PDFString.of('alert(1)') }),
    );
    source.getPage(0).node.set(PDFName.of('Annots'), source.context.obj([]));
    const clean = await PDFDocument.load(
      await normalizeDocument(Buffer.from(await source.save()), 'application/pdf'),
    );
    expect(clean.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    expect(clean.getPage(0).node.has(PDFName.of('Annots'))).toBe(false);
  });
  it('keeps filled form appearances visible when stripping interactive annotations', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    const field = source.getForm().createTextField('name');
    field.setText('Print this value');
    field.addToPage(page);
    const normalized = await PDFDocument.load(
      await normalizeDocument(Buffer.from(await source.save()), 'application/pdf'),
    );
    expect(normalized.getForm().getFields()).toHaveLength(0);
    const appearances = normalized
      .getPage(0)
      .node.Resources()!
      .lookup(PDFName.of('XObject'), PDFDict);
    expect(appearances.keys().length).toBeGreaterThan(0);
  });
  it('preserves uncertain submissions and prevents accidental device removal or retry', async () => {
    class Uncertain extends DemoProvider {
      override async print(): Promise<string> {
        throw new Error('Transport interrupted');
      }
    }
    f = await fixture({ provider: new Uncertain() });
    const response = await upload(await pdf());
    const job = response.json<Job>();
    expect(job.status).toBe('unknown');
    expect(await readdir(f.service.filesDir)).toEqual([]);
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/devices/${job.deviceId}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/jobs/${job.id}/cancel`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(409);
    await f.service.tick();
    expect(f.service.job(job.id).status).toBe('unknown');
  });
});
describe('scan lifecycle', () => {
  it('produces a real preview and PDF, protects downloads, deletes bytes and expires files', async () => {
    f = await fixture();
    const device = f.store.devices('demo').find((d) => d.kind === 'scanner')!;
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/scans',
      headers: f.headers,
      payload: { deviceId: device.id, options: {} },
    });
    expect(response.statusCode).toBe(202);
    const id = response.json<Job>().id;
    await f.service.close();
    const job = f.service.job(id);
    expect(job.status, job.error).toBe('completed');
    const download = await f.app.inject({ url: `/api/jobs/${id}/pdf`, headers: f.headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers['cache-control']).toBe('no-store');
    expect((await PDFDocument.load(download.rawPayload)).getPageCount()).toBe(1);
    const preview = await f.app.inject({ url: `/api/jobs/${id}/preview`, headers: f.headers });
    expect((await sharp(preview.rawPayload).metadata()).format).toBe('png');
    job.createdAt = new Date(Date.now() - 8 * 86400_000).toISOString();
    f.store.putJob(job);
    await f.service.expireFiles();
    expect(
      (await f.app.inject({ url: `/api/jobs/${id}/pdf`, headers: f.headers })).statusCode,
    ).toBe(404);
    expect(await readdir(f.service.filesDir)).toEqual([]);
    await f.app.inject({ method: 'DELETE', url: `/api/jobs/${id}`, headers: f.headers });
    expect(f.store.jobs('demo')).toHaveLength(0);
  });
  it('prevents concurrent scans on the same scanner and records real backend failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowScanner extends DemoProvider {
      override async scan(): Promise<void> {
        await gate;
        throw new Error('Scanner disconnected');
      }
    }
    f = await fixture({ provider: new SlowScanner() });
    const device = f.store.devices('demo').find((d) => d.kind === 'scanner')!;
    try {
      const input = {
        method: 'POST' as const,
        url: '/api/scans',
        headers: f.headers,
        payload: { deviceId: device.id, options: {} },
      };
      const first = await f.app.inject(input);
      expect(first.statusCode).toBe(202);
      expect((await f.app.inject(input)).statusCode).toBe(409);
      release();
      await f.service.close();
      const job = f.service.job(first.json<Job>().id);
      expect(job.status).toBe('failed');
      expect(job.error).toContain('disconnected');
      expect(job.hasFile).toBe(false);
    } finally {
      release();
    }
  });
});
