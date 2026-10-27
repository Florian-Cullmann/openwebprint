import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('The macOS discovery helper requires macOS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.local/discovery');
const binary = resolve(root, '.local/bin/discovery-macos');
await mkdir(directory, { recursive: true, mode: 0o755 });
await mkdir(resolve(root, '.local/bin'), { recursive: true, mode: 0o755 });

async function compile() {
  const compiler = spawn(
    'xcrun',
    ['swiftc', '-O', '-o', binary, resolve(root, 'scripts/macos/Discovery.swift')],
    { stdio: 'inherit' },
  );
  await new Promise((resolve, reject) => {
    compiler.once('error', reject);
    compiler.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error('Install Xcode Command Line Tools (xcode-select --install), then try again.'),
          ),
    );
  });
}
await compile();
if (!process.argv.includes('--build')) {
  const helper = spawn(binary, [resolve(directory, 'devices.json')], { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => helper.kill(signal));
  helper.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  helper.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
