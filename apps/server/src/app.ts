import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { deviceInputSchema, printOptionsSchema, scanOptionsSchema } from '@openwebprint/shared';
import type { Config } from './config.js';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Service } from './service.js';
import { DemoProvider } from './providers/demo.js';
import { HardwareProvider } from './providers/hardware.js';
import type { Provider } from './providers/types.js';
import { AppError } from './errors.js';
import { MAX_UPLOAD } from './documents.js';

const credentials = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(256),
});
const idParam = z.object({ id: z.uuid() });
export async function createApp(
  config: Config,
  options: { provider?: Provider; logger?: boolean; background?: boolean; staticDir?: string } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    requestTimeout: 150_000,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const store = new Store(config.dataDir);
  const auth = new Auth(store, config);
  const service = new Service(
    store,
    config.mode,
    options.provider ??
      (config.mode === 'demo' ? new DemoProvider() : new HardwareProvider(config.cupsServer)),
  );
  await service.initialize();
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD, files: 1, fields: 2, parts: 3, fieldSize: 4096 },
    throwFileSizeLimit: true,
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'Please check your input.',
        details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    if (error instanceof AppError)
      return reply.code(error.statusCode).send({ error: error.message });
    const e = error as { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({
        error:
          e.statusCode === 413
            ? 'File too large. Maximum size: 25 MB.'
            : 'Invalid request or too many requests. Please try again.',
      });
    app.log.error({ code: e.code }, 'Request failed');
    return reply.code(500).send({ error: 'The operation failed. Check the server logs.' });
  });
  const publicPaths = new Set(['/api/health', '/api/session', '/api/login']);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (
        req.headers['x-openwebprint'] !== '1' ||
        (req.headers.origin && req.headers.origin !== config.origin)
      )
        throw new AppError(403, 'Requests from this origin are not allowed. Check APP_ORIGIN.');
    }
    if (!publicPaths.has(req.url.split('?')[0]) && auth.hasUsers() && !auth.authenticated(req))
      throw new AppError(401, 'Please sign in.');
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/session', async (req) => {
    const user = auth.user(req);
    return {
      authenticationRequired: auth.hasUsers(),
      authenticated: !!user,
      user,
      mode: config.mode,
    };
  });
  const authLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };
  app.get('/api/users', async () => auth.users());
  app.post('/api/users', authLimit, async (req, reply) => {
    const input = credentials.parse(req.body);
    return reply
      .code(201)
      .send(await auth.createUser(input.username, input.password, auth.user(req)));
  });
  app.delete('/api/users/:id', async (req, reply) => {
    const id = idParam.parse(req.params).id;
    const ownAccount = auth.user(req)?.id === id;
    auth.deleteUser(id);
    if (ownAccount) auth.logout(req, reply);
    return { ok: true };
  });
  app.post('/api/login', authLimit, async (req, reply) => {
    const input = credentials.parse(req.body);
    await auth.login(input.username, input.password, reply);
    return { ok: true };
  });
  app.post('/api/logout', async (req, reply) => {
    auth.logout(req, reply);
    return { ok: true };
  });
  app.get('/api/snapshot', async () => service.snapshot());
  let discovery: ReturnType<Provider['discover']> | undefined;
  app.post(
    '/api/devices/discover',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async () => {
      discovery ??= service.provider.discover().finally(() => {
        discovery = undefined;
      });
      return discovery;
    },
  );
  app.post('/api/devices', async (req, reply) => {
    const result = await service.addDevice(deviceInputSchema.parse(req.body));
    return reply.code(201).send(result);
  });
  app.delete('/api/devices/:id', async (req) => {
    service.deleteDevice(idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/print', async (req, reply) => {
    const fields: Record<string, string> = {};
    let file: { data: Buffer; mime: string; name: string } | undefined;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') throw new AppError(400, 'Unknown upload field.');
        file = { data: await part.toBuffer(), mime: part.mimetype, name: part.filename };
        if (part.file.truncated) throw new AppError(413, 'The file exceeds 25 MB.');
      } else {
        if (!['deviceId', 'options'].includes(part.fieldname) || typeof part.value !== 'string')
          throw new AppError(400, 'Invalid print parameters.');
        fields[part.fieldname] = part.value;
      }
    }
    if (!file) throw new AppError(400, 'Choose a file.');
    let input: unknown;
    try {
      input = JSON.parse(fields.options ?? '{}');
    } catch {
      throw new AppError(400, 'Invalid print options.');
    }
    const job = await service.print(
      z.uuid().parse(fields.deviceId),
      file.data,
      file.mime,
      file.name,
      printOptionsSchema.parse(input),
    );
    return reply.code(201).send(job);
  });
  app.post('/api/scans', async (req, reply) => {
    const input = z.object({ deviceId: z.uuid(), options: scanOptionsSchema }).parse(req.body);
    return reply.code(202).send(service.scan(input.deviceId, input.options));
  });
  app.post('/api/jobs/:id/cancel', async (req) => service.cancel(idParam.parse(req.params).id));
  app.delete('/api/jobs/:id', async (req) => {
    await service.deleteJob(idParam.parse(req.params).id);
    return { ok: true };
  });
  app.get('/api/jobs/:id/:format', async (req, reply) => {
    const { id, format } = idParam.extend({ format: z.enum(['pdf', 'preview']) }).parse(req.params);
    const job = service.job(id);
    if (job.kind !== 'scan' || !job.hasFile || job.status !== 'completed')
      throw new AppError(404, 'No scan available. Scan files expire after 7 days.');
    const path = format === 'pdf' ? job.filePath : job.previewPath;
    if (!path) throw new AppError(404, 'File unavailable.');
    reply.type(format === 'pdf' ? 'application/pdf' : 'image/png');
    reply.header(
      'Content-Disposition',
      `${format === 'pdf' ? 'attachment' : 'inline'}; filename="scan-${id}.${format === 'pdf' ? 'pdf' : 'png'}"`,
    );
    return reply.send(await readFile(path));
  });
  const staticDir = options.staticDir ?? resolve('apps/client/dist');
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler(async (req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Endpoint not found.' })
        : reply.sendFile('index.html'),
    );
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let retention: ReturnType<typeof setInterval> | undefined;
  if (options.background !== false) {
    timer = setInterval(() => {
      void service.tick().catch(() => app.log.error('Job polling failed'));
    }, 2000);
    timer.unref();
    retention = setInterval(() => {
      void service.expireFiles().catch(() => app.log.error('Retention cleanup failed'));
    }, 3600_000);
    retention.unref();
  }
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(retention);
    await service.close();
    store.close();
  });
  return { app, service, auth, store };
}
