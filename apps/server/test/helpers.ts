import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { Provider } from '../src/providers/types.js';
export const secret = 'test-setup-token-at-least-24-characters';
export const credentials = { username: 'admin', password: 'test-password-long-enough' };
export async function fixture(
  options: {
    provider?: Provider;
    mode?: 'demo' | 'hardware';
    dataDir?: string;
    background?: boolean;
  } = {},
) {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'owp-test-')));
  const config = readConfig({
    DATA_DIR: dataDir,
    SETUP_TOKEN: secret,
    MODE: options.mode ?? 'demo',
    APP_ORIGIN: 'http://localhost:5173',
    COOKIE_SECURE: 'true',
  });
  const result = await createApp(config, {
    provider: options.provider,
    background: options.background ?? false,
    staticDir: '/nonexistent/owp-test',
  });
  const setup = await result.app.inject({
    method: 'POST',
    url: '/api/setup',
    headers: { 'x-openwebprint': '1' },
    payload: { ...credentials, token: secret },
  });
  if (![200, 409].includes(setup.statusCode)) throw new Error(setup.body);
  const login =
    setup.statusCode === 409
      ? await result.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { 'x-openwebprint': '1' },
          payload: credentials,
        })
      : setup;
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  return {
    ...result,
    dataDir,
    cookie,
    setup,
    headers: { cookie, 'x-openwebprint': '1' },
    async close(remove = true) {
      await result.app.close();
      if (remove) await rm(dataDir, { recursive: true, force: true });
    },
  };
}
export async function pdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('A real test document');
  return Buffer.from(await pdf.save());
}
export async function multipart(
  data: Buffer,
  type: string,
  deviceId: string,
  options: unknown = {},
  filename = 'document.pdf',
) {
  const form = new FormData();
  form.set('deviceId', deviceId);
  form.set('options', JSON.stringify(options));
  form.set('file', new Blob([new Uint8Array(data)], { type }), filename);
  const request = new Request('http://localhost', { method: 'POST', body: form });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get('content-type')!,
  };
}
