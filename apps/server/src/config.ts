import { resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  MODE: z.enum(['demo', 'hardware']).default('demo'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATA_DIR: z.string().default('./data'),
  APP_ORIGIN: z
    .url()
    .refine(
      (v) => ['http:', 'https:'].includes(new URL(v).protocol),
      'APP_ORIGIN must use HTTP or HTTPS',
    )
    .default('http://localhost:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  SETUP_TOKEN: z.string().min(24).optional(),
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
    origin: new URL(e.APP_ORIGIN).origin,
    secureCookie: e.COOKIE_SECURE === 'true',
    setupToken: e.SETUP_TOKEN,
    cupsServer: e.CUPS_SERVER,
  };
}
export type Config = ReturnType<typeof readConfig>;
