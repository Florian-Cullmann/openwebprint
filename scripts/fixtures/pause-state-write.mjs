import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// Loaded only by the disposable installer fixture, including its detached
// server. Pause after exclusive creation, before the first JSON byte is written.
if (process.argv.includes('serve')) {
  const originalOpen = fs.open;
  const statePath = process.env.OWP_TEST_STATE_PATH;
  fs.open = async (path, ...args) => {
    const file = await originalOpen(path, ...args);
    if (path === statePath || String(path).startsWith(`${statePath}.`)) {
      try {
        await fs.writeFile(process.env.OWP_TEST_STATE_PAUSED, '');
        const deadline = Date.now() + 10_000;
        while (!(await fs.stat(process.env.OWP_TEST_STATE_RESUME).catch(() => null))) {
          if (Date.now() >= deadline) throw new Error('Timed out waiting to resume state write.');
          await new Promise((done) => setTimeout(done, 20));
        }
      } catch (error) {
        await file.close();
        throw error;
      }
    }
    return file;
  };
  syncBuiltinESMExports();
}
