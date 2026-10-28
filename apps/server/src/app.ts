import { publicErrorBody } from '@openwebprint/shared';
import { checkHardware } from '../../../scripts/install/hardware.mjs';
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
import {
  deviceInputSchema,
  printOptionsSchema,
  scanOptionsSchema,
  scanChoiceSchema,
  scanPagesSchema,
  scanExportSchema,
  retentionSchema,
} from '@openwebprint/shared';
import type { Config } from './config.js';
import { Store, storedScanPages } from './store.js';
import { Auth } from './auth.js';
import { Workspace } from './workspace.js';
import type { Provider } from './providers/types.js';
import { AppError } from './errors.js';
import { retentionPolicy } from './retention.js';
import { MAX_UPLOAD, normalizeDocument, renderScanPage } from './documents.js';

const credentials = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1),
});
const idParam = z.object({ id: z.uuid() });
export async function createApp(
  config: Config,
  options: {
    provider?: Provider;
    demoProvider?: Provider;
    hardwareProvider?: Provider;
    logger?: boolean;
    background?: boolean;
    staticDir?: string;
  } = {},
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
  const workspace = new Workspace(store, config, {
    demo: options.demoProvider ?? (config.mode === 'demo' ? options.provider : undefined),
    hardware:
      options.hardwareProvider ?? (config.mode === 'hardware' ? options.provider : undefined),
  });
  await workspace.initialize();
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'"],
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
        ...publicErrorBody('Please check your input.'),
        details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    if (error instanceof AppError)
      return reply.code(error.statusCode).send(publicErrorBody(error.message));
    const e = error as { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({
        ...publicErrorBody(
          e.statusCode === 413
            ? 'File too large. Maximum size: 25 MB.'
            : 'Invalid request or too many requests. Please try again.',
        ),
      });
    app.log.error({ code: e.code }, 'Request failed');
    return reply.code(500).send(publicErrorBody('The operation failed. Check the server logs.'));
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
      mode: workspace.mode,
      onboardingRequired: workspace.required,
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
  app.post('/api/account/password', authLimit, async (req, reply) => {
    const input = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(1),
      })
      .strict()
      .parse(req.body);
    await auth.changePassword(req, reply, input.currentPassword, input.newPassword);
    return { ok: true };
  });
  app.post('/api/logout', async (req, reply) => {
    auth.logout(req, reply);
    return { ok: true };
  });
  let hardwareCheck: ReturnType<typeof checkHardware> | undefined;
  app.post('/api/hardware/prerequisites', async () => {
    if (workspace.mode === 'demo')
      throw new AppError(
        409,
        'Hardware diagnostics are disabled in demo mode. Start hardware setup first.',
      );
    hardwareCheck ??= checkHardware({
      server: config.cupsServer,
      method: config.installRoot ? 'native' : existsSync('/.dockerenv') ? 'container' : 'source',
      ...(config.installRoot
        ? {
            setupCommand: `'${resolve(config.installRoot, 'openwebprint').replaceAll("'", "'\\''")}' hardware`,
          }
        : {}),
    }).finally(() => {
      hardwareCheck = undefined;
    });
    return hardwareCheck;
  });
  app.get('/api/onboarding', async () => workspace.state());
  app.post('/api/onboarding/demo', async () => workspace.tryDemo());
  app.post('/api/onboarding/start', async () => workspace.startHardware());
  app.post('/api/onboarding/remove-demo', async () => workspace.removeDemo());
  app.post('/api/onboarding/devices', async (req) => {
    const { devices } = z.object({ devices: z.array(deviceInputSchema).max(50) }).parse(req.body);
    return workspace.selectDevices(devices);
  });
  app.post('/api/onboarding/storage', async (req) => {
    const { path } = z.object({ path: z.string().trim().min(1).max(1024) }).parse(req.body);
    return workspace.saveStorage(path, true);
  });
  app.get('/api/storage', async () => ({ path: workspace.scanRoot }));
  app.put('/api/storage', async (req) => {
    const { path } = z.object({ path: z.string().trim().min(1).max(1024) }).parse(req.body);
    return workspace.saveStorage(path);
  });
  app.get('/api/retention', async () => retentionPolicy(store));
  app.post('/api/retention/preview', async (req) =>
    workspace.retentionImpact(retentionSchema.parse(req.body)),
  );
  app.put('/api/retention', async (req) => {
    const { confirm, ...policy } = retentionSchema
      .extend({ confirm: z.boolean().default(false) })
      .parse(req.body);
    return workspace.saveRetention(policy, confirm);
  });
  app.get('/api/snapshot', async () => workspace.snapshot());
  app.get('/api/jobs', async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        kind: z.enum(['print', 'scan']).optional(),
        filter: z.enum(['all', 'active', 'completed']).default('all'),
        search: z.string().trim().max(200).default(''),
        cursor: z.string().min(1).max(2048).optional(),
      })
      .strict()
      .parse(req.query);
    let before: { createdAt: string; id: string } | undefined;
    if (query.cursor) {
      try {
        const cursor = z
          .object({
            createdAt: z.iso.datetime(),
            id: z.uuid(),
            mode: z.enum(['demo', 'hardware']),
            kind: z.enum(['print', 'scan']).optional(),
            filter: z.enum(['all', 'active', 'completed']),
            search: z.string().trim().max(200).default(''),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
        if (
          cursor.mode !== workspace.mode ||
          cursor.kind !== query.kind ||
          cursor.filter !== query.filter ||
          cursor.search !== query.search
        )
          throw new Error('Cursor belongs to another listing');
        before = cursor;
      } catch {
        throw new AppError(400, 'Invalid history cursor. Refresh the list and try again.');
      }
    }
    return workspace.run((service) => service.listJobs({ ...query, before }));
  });
  app.get('/api/jobs/:id', async (req) =>
    workspace.run((service) => service.publicJob(service.job(idParam.parse(req.params).id))),
  );
  let discovery: Promise<Awaited<ReturnType<Provider['discover']>>> | undefined;
  app.post(
    '/api/devices/discover',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async () => {
      discovery ??= workspace.discover().finally(() => {
        discovery = undefined;
      });
      return discovery;
    },
  );
  app.post('/api/devices', async (req, reply) => {
    const result = await workspace.addDevice(deviceInputSchema.parse(req.body));
    return reply.code(201).send(result);
  });
  app.delete('/api/devices/:id', async (req) => {
    await workspace.run((service) => service.deleteDevice(idParam.parse(req.params).id));
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
    const job = await workspace.run((service) =>
      service.print(
        z.uuid().parse(fields.deviceId),
        file.data,
        file.mime,
        file.name,
        printOptionsSchema.parse(input),
      ),
    );
    return reply.code(201).send(job);
  });
  app.post('/api/jobs/:id/print', async (req, reply) => {
    const input = z
      .object({
        deviceId: z.uuid(),
        options: printOptionsSchema,
        revision: z.string().min(1).max(80).optional(),
      })
      .strict()
      .parse(req.body);
    const job = await workspace.run((service) =>
      service.printSaved(
        idParam.parse(req.params).id,
        input.deviceId,
        input.options,
        input.revision,
      ),
    );
    return reply.code(201).send(job);
  });
  app.post('/api/documents/preview', async (req, reply) => {
    let file: { data: Buffer; mime: string } | undefined;
    for await (const part of req.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'file')
        throw new AppError(400, 'Only a document upload is accepted.');
      file = { data: await part.toBuffer(), mime: part.mimetype };
      if (part.file.truncated) throw new AppError(413, 'The file exceeds 25 MB.');
    }
    if (!file) throw new AppError(400, 'Choose a file.');
    const document = await workspace.run(() => normalizeDocument(file.data, file.mime));
    return reply.type('application/pdf').send(document);
  });
  app.post('/api/scans/export', async (req, reply) => {
    const { scans } = scanExportSchema.parse(req.body);
    const controller = new AbortController();
    const abort = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    req.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    const detach = () => {
      req.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    };
    try {
      const archive = await workspace.run((service) =>
        service.scanExports.create(scans, controller.signal),
      );
      archive.once('close', detach);
      return reply
        .type('application/zip')
        .header('Content-Disposition', 'attachment; filename="openwebprint-scans.zip"')
        .send(archive);
    } catch (error) {
      detach();
      controller.abort();
      throw error;
    }
  });
  app.post('/api/scans', async (req, reply) => {
    const input = z
      .object({ deviceId: z.uuid(), options: scanOptionsSchema, jobId: z.uuid().optional() })
      .parse(req.body);
    return reply
      .code(202)
      .send(
        await workspace.run((service) => service.scan(input.deviceId, input.options, input.jobId)),
      );
  });
  app.get('/api/devices/:id/scan-sources', async (req) => {
    const { source, refresh } = z
      .object({ source: scanChoiceSchema.optional(), refresh: z.literal('true').optional() })
      .parse(req.query);
    return workspace.run((service) =>
      service.scanSources(idParam.parse(req.params).id, source, refresh === 'true'),
    );
  });
  app.post('/api/scans/:id/pages', async (req) => {
    const input = scanPagesSchema.parse(req.body);
    return workspace.run((service) =>
      service.editScan(idParam.parse(req.params).id, input.revision, input.pages),
    );
  });
  app.post('/api/scans/:id/recovery', async (req) => {
    const input = z
      .object({
        revision: z.string().min(1).max(80),
        action: z.enum(['keep', 'discard']),
      })
      .parse(req.body);
    return workspace.run((service) =>
      service.resolveRecovery(idParam.parse(req.params).id, input.revision, input.action),
    );
  });
  app.get('/api/scans/:id/pages/:pageId', async (req, reply) => {
    const { id, pageId } = idParam.extend({ pageId: z.uuid() }).parse(req.params);
    const { rendered, thumbnail } = z
      .object({ rendered: z.literal('1').optional(), thumbnail: z.literal('1').optional() })
      .parse(req.query);
    if (thumbnail)
      return reply.type('image/png').send(await workspace.service.scanThumbnail(id, pageId));
    const job = workspace.service.job(id);
    if (job.kind !== 'scan' || !job.hasFile) throw new AppError(404, 'Page unavailable.');
    workspace.service.availableJob(id);
    const page = storedScanPages(job).find((page) => page.id === pageId);
    if (!page) throw new AppError(404, 'Page unavailable.');
    return reply
      .type('image/png')
      .send(rendered ? (await renderScanPage(page)).image : await readFile(page.path));
  });
  app.post('/api/jobs/:id/cancel', async (req) =>
    workspace.run((service) => service.cancel(idParam.parse(req.params).id)),
  );
  app.delete('/api/jobs/:id', async (req) => {
    await workspace.run((service) => service.deleteJob(idParam.parse(req.params).id));
    return { ok: true };
  });
  app.get('/api/jobs/:id/:format', async (req, reply) => {
    const { id, format } = idParam
      .extend({ format: z.enum(['pdf', 'preview', 'document']) })
      .parse(req.params);
    const job = workspace.service.job(id);
    if (!job.hasFile || (format === 'preview' && job.kind !== 'scan'))
      throw new AppError(
        404,
        'No document available. Files follow the instance retention policy; older print jobs may have no retained preview.',
      );
    workspace.service.availableJob(id);
    const path = format === 'preview' ? job.previewPath : job.filePath;
    if (!path) throw new AppError(404, 'File unavailable.');
    const { revision } = z
      .object({ revision: z.string().min(1).max(80).optional() })
      .parse(req.query);
    const data =
      format === 'preview'
        ? await workspace.service.scanThumbnail(id)
        : await workspace.service.document(id, revision);
    reply.type(format === 'preview' ? 'image/png' : 'application/pdf');
    reply.header(
      'Content-Disposition',
      `${format === 'pdf' ? 'attachment' : 'inline'}; filename="${job.kind === 'scan' ? 'scan' : 'document'}-${id}.${format === 'preview' ? 'png' : 'pdf'}"`,
    );
    return reply.send(data);
  });
  const staticDir = options.staticDir ?? resolve('apps/client/dist');
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler(async (req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send(publicErrorBody('Endpoint not found.'))
        : reply.sendFile('index.html'),
    );
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let retention: ReturnType<typeof setInterval> | undefined;
  if (options.background !== false) {
    timer = setInterval(() => {
      void workspace.tick().catch(() => app.log.error('Job polling failed'));
    }, 2000);
    timer.unref();
    retention = setInterval(() => {
      void workspace.expireFiles().catch(() => app.log.error('Retention cleanup failed'));
    }, 3600_000);
    retention.unref();
  }
  app.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(retention);
    await hardwareCheck;
    await workspace.close();
    store.close();
  });
  return {
    app,
    get service() {
      return workspace.service;
    },
    workspace,
    auth,
    store,
  };
}
