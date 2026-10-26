import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { runtime, shortcuts as synchronizeShortcuts } from './install/platform.mjs';

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
const serverEntry = join(packageDirectory, 'apps/server/dist/index.js');
const originalServer = await readFile(serverEntry);
// Module loading can block the controller's event loop after its socket opens.
// Exercise a startup pause longer than one control probe, without consuming CPU.
await writeFile(
  serverEntry,
  Buffer.concat([
    Buffer.from('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);\n'),
    originalServer,
  ]),
);
const node = runtime(packageDirectory);
const manager = join(packageDirectory, 'scripts/install/manage.mjs');
const shortcuts = process.env.OWP_TEST_SHORTCUTS === '1';
const common = ['--root', root, '--no-open', ...(!shortcuts ? ['--no-shortcuts'] : [])];
const loginEntry =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'LaunchAgents', 'org.openwebprint.plist')
    : join(
        process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
        'autostart',
        'openwebprint.desktop',
      );
const menuEntry =
  process.platform === 'darwin'
    ? join(homedir(), 'Applications', 'openwebprint.app')
    : join(
        process.env.XDG_DATA_HOME || join(homedir(), '.local/share'),
        'applications',
        'openwebprint.desktop',
      );
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

async function reusedControlPort(action, kind) {
  const statePath = join(root, 'running.json');
  const stale = JSON.parse(await readFile(statePath));
  await run('stop');
  await assert.rejects(stat(statePath), { code: 'ENOENT' });
  const requests = [];
  const nonHttp = kind === 'silent' || kind === 'ssh';
  const sockets = new Set();
  let connections = 0;
  const foreign = nonHttp
    ? createServer((socket) => {
        let bytes = '';
        let recorded = false;
        socket.on('data', (chunk) => {
          bytes += chunk.toString();
          if (!recorded && bytes.includes('\r\n\r\n')) {
            recorded = true;
            requests.push({
              method: bytes.split(' ')[0],
              authorization: /^authorization:\s*(.*)$/im.exec(bytes)?.[1].trim(),
            });
          }
        });
        if (kind === 'ssh') socket.write('SSH-2.0-unrelated-service\r\n');
      })
    : createHttpServer((req, res) => {
        requests.push({ method: req.method, authorization: req.headers.authorization });
        if (kind === 'forbidden') res.writeHead(403).end('Forbidden');
        else if (kind === 'html') res.end('<html>Unrelated service</html>');
        else {
          // Even matching metadata is insufficient without proof of the instance secret.
          res.setHeader('X-Openwebprint-Proof', '0'.repeat(64));
          res.end(JSON.stringify({ root, port, ready: true }));
        }
      });
  foreign.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((done, reject) => {
    foreign.once('error', reject);
    foreign.listen(stale.port, '127.0.0.1', done);
  });
  try {
    // PID reuse must not turn a stale control file into authority to signal a process.
    await writeFile(statePath, JSON.stringify({ ...stale, pid: process.pid }));
    assert.match(await run('status'), /stopped/);
    await run(action);
    assert.ok(foreign.listening);
    assert.ok(connections > 0);
    if (!nonHttp) assert.ok(requests.length > 0);
    assert.ok(
      requests.every((request) => request.method === 'GET'),
      'Never send stop to a foreign listener.',
    );
    assert.ok(
      requests.every((request) => request.authorization !== `Bearer ${stale.token}`),
      'Never disclose the instance secret to a reused port.',
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => foreign.close(done));
  }
}

async function pausedInstance() {
  const statePath = join(root, 'running.json');
  const before = await readFile(statePath, 'utf8');
  const state = JSON.parse(before);
  // Fault injection targets only the disposable server launched by this test.
  process.kill(state.pid, 'SIGSTOP');
  try {
    for (const action of ['start', 'install', 'uninstall']) {
      assert.match(await run(action, [], false), /process is still running/);
      assert.equal(await readFile(statePath, 'utf8'), before);
      await stat(join(root, 'app'));
    }
  } finally {
    process.kill(state.pid, 'SIGCONT');
  }
  await run('start');
  assert.equal(JSON.parse(await readFile(statePath)).pid, state.pid);
}
const portServer = createServer();
await new Promise((done) => portServer.listen(0, '127.0.0.1', done));
const port = portServer.address().port;
const base = `http://127.0.0.1:${port}`;
try {
  assert.match(await run('install', ['--port', String(port)], false), /in use/);
  await new Promise((done) => portServer.close(done));
  await run('install', ['--port', String(port)]);
  await writeFile(serverEntry, originalServer);
  await writeFile(join(root, 'app/apps/server/dist/index.js'), originalServer);
  if (shortcuts) {
    await synchronizeShortcuts(join(temporary, 'Another installation'), { remove: true });
    await stat(loginEntry);
    await stat(menuEntry);
  }
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
  await pausedInstance();
  await reusedControlPort('start', 'forbidden');
  await reusedControlPort('start', 'silent');
  await reusedControlPort('start', 'ssh');
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  // Also exercise a normal update while the authenticated instance is still running.
  await run('install');
  await reusedControlPort('install', 'html');
  await reusedControlPort('install', 'silent');
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), savedConfig);
  assert.equal(await readFile(join(root, 'data', 'keep.txt'), 'utf8'), 'preserve documents');
  const after = await (await fetch(`${base}/api/snapshot`)).json();
  assert.deepEqual(after.devices.map((d) => d.id).sort(), snapshot.devices.map((d) => d.id).sort());
  await run('install', ['--no-shortcuts', '--no-autostart']);
  const disabled = JSON.parse(await readFile(join(root, 'config.json')));
  assert.equal(disabled.shortcuts, false);
  assert.equal(disabled.autostart, false);
  if (shortcuts) {
    await assert.rejects(stat(loginEntry), { code: 'ENOENT' });
    await assert.rejects(stat(menuEntry), { code: 'ENOENT' });
    // Repair entries left behind by an earlier update that saved false settings
    // without deleting them; cleanup must not depend on a true -> false transition.
    await synchronizeShortcuts(root);
    await stat(loginEntry);
    await stat(menuEntry);
  }
  await run('install');
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'))).shortcuts, false);
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'))).autostart, false);
  if (shortcuts) {
    await assert.rejects(stat(loginEntry), { code: 'ENOENT' });
    await assert.rejects(stat(menuEntry), { code: 'ENOENT' });
  }
  await reusedControlPort('uninstall', 'forged');
  await assert.rejects(stat(join(root, 'app')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'data', 'keep.txt'), 'utf8'), 'preserve documents');
  await run('install', ['--no-autostart']);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'))).autostart, false);
  await run('install');
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'))).autostart, false);
  await reusedControlPort('uninstall', 'ssh');
  console.log(
    'Packaged installation, HTTP/TCP/SSH port reuse, paused-instance preservation, production web/assets, native image conversion, control authentication, restart, update/data preservation, shortcut opt-out, reinstall, and uninstall passed.',
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
