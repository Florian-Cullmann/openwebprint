import { readConfig } from './config.js';
import { createApp } from './app.js';
process.umask(0o077);
const config = readConfig();
const { app } = await createApp(config, { logger: true });
await app.listen({ host: config.host, port: config.port });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
