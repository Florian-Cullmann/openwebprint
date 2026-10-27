import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../src/providers/command.js';

let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
});
it.each([false, true])(
  'cancels a real child and waits for exit, ignoring SIGTERM=%s (no scanner hardware)',
  async (ignoreTerm) => {
    const directory = await mkdtemp(join(tmpdir(), 'owp-child-'));
    const ready = join(directory, 'ready');
    const controller = new AbortController();
    const pending = command(
      process.execPath,
      [
        '-e',
        `
    const fs = require('node:fs');
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    fs.writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 100);
  `,
        ready,
      ],
      10_000,
      controller.signal,
    );
    const settled = pending.catch((error: Error) => error);
    cleanup = async () => {
      controller.abort();
      await settled;
      await rm(directory, { recursive: true, force: true });
    };
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(ready, 'utf8'));
      expect(pid).toBeGreaterThan(0);
    });
    process.kill(pid, 0);
    controller.abort();
    expect(await settled).toMatchObject({ name: 'AbortError' });
    expect(() => process.kill(pid, 0)).toThrow();
  },
);
it('does not launch an already canceled command', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(command('/nonexistent/owp', [], 1000, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
});
