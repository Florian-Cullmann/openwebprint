import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { runtime } from './install/platform.mjs';

// This exercises the actual release package, private runtime, SQLite, browser
// assets, and sharp. It deliberately does not connect physical devices.
const input = resolve(
  process.argv[2] || `.local/packages/openwebprint-${process.platform}-${process.arch}`,
);
const temporary = await mkdtemp(join(tmpdir(), 'openwebprint install test '));
const archive = `${input}.tar.gz`;
const expected = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s+/)[0];
assert.equal(
  createHash('sha256')
    .update(await readFile(archive))
    .digest('hex'),
  expected,
);
execFileSync('tar', ['-xzf', archive, '-C', temporary]);
const packageDirectory = join(temporary, basename(input));
const root = join(temporary, 'Application Data');
const node = runtime(packageDirectory);
const manager = join(packageDirectory, 'scripts/install/manage.mjs');
const shortcuts = process.env.OWP_TEST_SHORTCUTS === '1';
const common = ['--root', root, '--no-open', ...(!shortcuts ? ['--no-shortcuts'] : [])];
async function run(action, extra = [], success = true) {
  const child = spawn(node, [manager, ...common, action, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  assert.equal(code === 0, success, output);
  return output;
}
const portServer = createServer();
await new Promise((done) => portServer.listen(0, '127.0.0.1', done));
const port = portServer.address().port;
const base = `http://127.0.0.1:${port}`;
try {
  assert.match(await run('install', ['--port', String(port)], false), /in use/);
  await new Promise((done) => portServer.close(done));
  await run('install', ['--port', String(port)]);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.match(await (await fetch(`${base}/settings/general`)).text(), /<html/);
  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.authenticated, false);
  assert.equal(session.onboardingRequired, true);
  const headers = { Origin: base, 'x-openwebprint': '1', 'Content-Type': 'application/json' };
  const demo = await fetch(`${base}/api/onboarding/demo`, { method: 'POST', headers, body: '{}' });
  assert.equal(demo.status, 200, await demo.text());
  const snapshot = await (await fetch(`${base}/api/snapshot`)).json();
  assert.ok(snapshot.devices.length > 0);
  const printer = snapshot.devices.find((device) => device.kind === 'printer');
  assert.ok(printer);
  const scanner = snapshot.devices.find((device) => device.kind === 'scanner');
  assert.ok(scanner);
  // Decode and convert a real image through the native sharp dependency.
  const image = new FormData();
  image.append(
    'file',
    new Blob(
      [
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      ],
      { type: 'image/png' },
    ),
    'sample.png',
  );
  const uploaded = await fetch(`${base}/api/documents/preview`, {
    method: 'POST',
    headers: { Origin: base, 'x-openwebprint': '1' },
    body: image,
  });
  assert.equal(uploaded.status, 200, 'The packaged image-processing dependency must work.');
  assert.equal(
    Buffer.from(await uploaded.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
  const state = JSON.parse(await readFile(join(root, 'running.json')));
  assert.equal(
    (await fetch(`http://127.0.0.1:${state.port}/stop`, { method: 'POST' })).status,
    403,
  );
  assert.match(await run('status'), /running/);
  await writeFile(join(root, 'data', 'keep.txt'), 'preserve documents');
  const savedConfig = await readFile(join(root, 'config.json'), 'utf8');
  await run('stop');
  assert.match(await run('status'), /stopped/);
  // A stale instance file must be recoverable without ever signaling a PID.
  await run('start');
  await run('install');
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), savedConfig);
  assert.equal(await readFile(join(root, 'data', 'keep.txt'), 'utf8'), 'preserve documents');
  const after = await (await fetch(`${base}/api/snapshot`)).json();
  assert.deepEqual(after.devices.map((d) => d.id).sort(), snapshot.devices.map((d) => d.id).sort());
  await run('uninstall');
  await assert.rejects(stat(join(root, 'app')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'data', 'keep.txt'), 'utf8'), 'preserve documents');
  await run('install', ['--no-autostart']);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'))).autostart, false);
  await run('install');
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'))).autostart, false);
  await run('uninstall');
  console.log(
    'Packaged installation, port conflict, production web/assets, native image conversion, control authorization, restart, update/data preservation, reinstall, and uninstall passed.',
  );
} catch (error) {
  console.error(
    await readFile(join(root, 'logs/server.log'), 'utf8')
      .then((log) => log.slice(-6000))
      .catch(() => 'No server log.'),
  );
  throw error;
} finally {
  portServer.close();
  await run('stop').catch(() => {});
  if (shortcuts) await run('uninstall').catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
