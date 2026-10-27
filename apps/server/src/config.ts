import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  MODE: z.enum(['demo', 'hardware']).optional(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATA_DIR: z.string().default('./data'),
  HOST_DISCOVERY_FILE: z
    .string()
    .refine(isAbsolute, 'HOST_DISCOVERY_FILE must be an absolute server path')
    .optional(),
  APP_ORIGIN: z
    .url()
    .refine(
      (v) => ['http:', 'https:'].includes(new URL(v).protocol),
      'APP_ORIGIN must use HTTP or HTTPS',
    )
    .default('http://localhost:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  CUPS_SERVER: z
    .string()
    .regex(/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/)
    .default('localhost:631'),
});
export function readConfig(env = process.env) {
  const e = envSchema.parse(env);
  return {
    mode: e.MODE,
    host: e.HOST,
    port: e.PORT,
    dataDir: resolve(e.DATA_DIR),
    hostDiscoveryFile: e.HOST_DISCOVERY_FILE,
    origin: new URL(e.APP_ORIGIN).origin,
    secureCookie: e.COOKIE_SECURE === 'true',
    cupsServer: e.CUPS_SERVER,
  };
}
export type Config = ReturnType<typeof readConfig>;
