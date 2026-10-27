import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { cp, link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  commandLauncher,
  defaultRoot,
  instanceProcessExists,
  openBrowser,
  runtime,
  shortcuts,
} from './platform.mjs';

process.umask(0o077);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string', default: defaultRoot() },
    port: { type: 'string' },
    instance: { type: 'string' },
    'no-open': { type: 'boolean' },
    'no-autostart': { type: 'boolean' },
    'no-shortcuts': { type: 'boolean' },
  },
});
const root = resolve(values.root);
if (/[\x00-\x1f\x7f]/.test(root))
  throw new Error('The installation path must not contain control characters.');
const app = join(root, 'app');
const statePath = join(root, 'running.json');
const configPath = join(root, 'config.json');
const source = resolve(import.meta.dirname, '../..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const missing = (error) => error.code === 'ENOENT';
const signature = (token, ...parts) =>
  createHmac('sha256', token).update(JSON.stringify(parts)).digest('hex');
const authenticated = (actual, expected) =>
  typeof actual === 'string' &&
  /^[a-f0-9]{64}$/.test(actual) &&
  timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));

async function config() {
  const c = await json(configPath);
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)
    throw new Error('config.json port must be an integer between 1024 and 65535.');
  return c;
}

async function control(action = 'status') {
  let state;
  try {
    state = await json(statePath);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!Number.isInteger(state.port) || typeof state.token !== 'string')
    throw new Error('Invalid running.json; stop openwebprint before removing this file.');
  const nonce = randomBytes(32).toString('hex');
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
      method: action === 'stop' ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${signature(state.token, 'request', action, nonce)}`,
        'X-Openwebprint-Challenge': nonce,
        Connection: 'close',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
    });
    // Ports can be reused after exit. Authenticate the response, not just the
    // request, before treating a listener as this installation's process.
    const proof = response.headers.get('x-openwebprint-proof');
    if (!response.ok || !/^[a-f0-9]{64}$/.test(proof || '')) {
      await response.body?.cancel();
      throw new Error('The listener did not authenticate as this controller.');
    }
    const body = await response.text();
    if (!authenticated(proof, signature(state.token, 'response', action, nonce, body)))
      throw new Error('The listener did not authenticate as this controller.');
    const result = JSON.parse(body);
    if (result.root !== root) throw new Error('The controller belongs to another installation.');
    return result;
  } catch (error) {
    // Protocol errors and timeouts say nothing about process liveness. Only
    // discard state once the OS confirms that this launch no longer exists.
    if (!(await instanceProcessExists(state))) return null;
    throw new Error(
      'The openwebprint process is still running but its controller is unavailable. Try again; state was preserved.',
      { cause: error },
    );
  }
}

async function stop() {
  if (!(await control())) {
    await rm(statePath, { force: true });
    return;
  }
  await control('stop');
  for (let i = 0; i < 160; i++) {
    if (!(await control())) {
      await rm(statePath, { force: true });
      return;
    }
    await sleep(1000);
  }
  throw new Error('openwebprint did not stop. Close running operations and try again.');
}

async function start() {
  if (await control()) return;
  const c = await config();
  await availablePort(c.port);
  const logDirectory = join(root, 'logs');
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const log = await open(join(logDirectory, 'server.log'), 'a', 0o600);
  // A separate runtime makes the browser launcher and login hook short-lived.
  const child = spawn(
    runtime(app),
    [
      join(app, 'scripts/install/manage.mjs'),
      '--root',
      root,
      `--instance=${randomBytes(32).toString('hex')}`,
      'serve',
    ],
    {
      cwd: app,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    },
  );
  const failed = new Promise((_, reject) => child.once('error', reject));
  child.unref();
  await log.close();
  await Promise.race([
    failed,
    (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          if ((await control())?.ready) {
            const response = await fetch(`http://127.0.0.1:${c.port}/api/health`, {
              signal: AbortSignal.timeout(2000),
            });
            if (response.ok) return;
          }
        } catch (error) {
          // A probe can time out while module loading blocks the new process.
          // Keep waiting for readiness; never classify a timeout as stale state.
          if (error.name !== 'TimeoutError' && error.cause?.name !== 'TimeoutError') throw error;
        }
        await sleep(500);
      }
      throw new Error(`Startup failed. See ${join(logDirectory, 'server.log')}`);
    })(),
  ]);
}

async function serve() {
  if (!/^[a-f0-9]{64}$/.test(values.instance || ''))
    throw new Error('Use start to launch the application.');
  const c = await config();
  // Claim the instance file before opening SQLite. Never signal an unverified PID.
  const token = randomBytes(32).toString('hex');
  let ready = false;
  const controlServer = createServer((req, res) => {
    const action = req.url?.slice(1);
    const nonce = req.headers['x-openwebprint-challenge'];
    if (
      typeof nonce !== 'string' ||
      !/^[a-f0-9]{64}$/.test(nonce) ||
      !authenticated(
        req.headers.authorization?.replace(/^Bearer /, ''),
        signature(token, 'request', action, nonce),
      )
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== '/status' && !(req.url === '/stop' && req.method === 'POST')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.stringify({ root, port: c.port, ready });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Openwebprint-Proof', signature(token, 'response', action, nonce, body));
    res.end(body, () => {
      if (req.url === '/stop') process.kill(process.pid, 'SIGTERM');
    });
  });
  await new Promise((done, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(0, '127.0.0.1', done);
  });
  const state = {
    port: controlServer.address().port,
    token,
    pid: process.pid,
    instanceId: values.instance,
  };
  try {
    // Readers must only see complete JSON. A hard link publishes the closed
    // file atomically and, unlike rename, cannot replace another instance's
    // claim. Keep both paths in the same directory/filesystem.
    const pendingState = `${statePath}.${values.instance}.tmp`;
    const file = await open(pendingState, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(state));
      } finally {
        await file.close();
      }
      await link(pendingState, statePath);
    } finally {
      await rm(pendingState, { force: true });
    }
  } catch (error) {
    controlServer.close();
    throw new Error('Another instance is starting. Use the launcher again in a moment.', {
      cause: error,
    });
  }
  // The server closes itself and SQLite on SIGTERM. Keep control state until exit.
  Object.assign(process.env, {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(c.port),
    APP_ORIGIN: `http://127.0.0.1:${c.port}`,
    DATA_DIR: join(root, 'data'),
    COOKIE_SECURE: 'false',
    CUPS_SERVER: c.cupsServer || 'localhost:631',
  });
  if (process.platform === 'darwin') {
    process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`;
  }
  delete process.env.MODE;
  delete process.env.HOST_DISCOVERY_FILE;
  process.chdir(app);
  try {
    await import(pathToFileURL(join(app, 'apps/server/dist/index.js')).href);
    ready = true;
  } catch (error) {
    controlServer.close();
    await rm(statePath, { force: true });
    throw error;
  }
}

async function lock() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'operation.lock');
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(path, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (e) {
            if (e.code === 'ESRCH') await rm(path, { force: true });
          }
        }
      } catch (e) {
        if (!missing(e)) throw e;
      }
      await sleep(500);
    }
  }
  throw new Error(`Another installer or launcher is busy. Try again later. Lock: ${path}`);
}

async function availablePort(port) {
  const busy = await new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', (error) => {
      socket.destroy();
      done(error.code !== 'ECONNREFUSED');
    });
  });
  if (busy)
    throw new Error(
      `Port ${port} is in use. Stop the other application or install with --port NUMBER.`,
    );
}

async function install() {
  if (source === app)
    throw new Error('For updates, run the downloaded installer, not the installed copy.');
  const release = await json(join(source, 'release.json'));
  if (release.platform !== process.platform || release.arch !== process.arch)
    throw new Error('This package does not match your operating system and processor.');
  const inside = relative(source, root);
  if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
    throw new Error('Choose an installation directory outside the extracted package.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let c;
  try {
    c = await config();
  } catch (error) {
    if (!missing(error)) throw error;
  }
  c ??= { port: 3001 };
  c.autostart = values['no-autostart'] ? false : c.autostart !== false;
  c.shortcuts = values['no-shortcuts'] ? false : c.shortcuts !== false;
  if (values.port !== undefined) c.port = Number(values.port);
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)
    throw new Error('--port must be an integer between 1024 and 65535.');
  await managedApplication(app);
  await managedApplication(join(root, 'app.previous'));
  // Stage the whole release before interrupting the installed application.
  const stage = join(root, 'app.staging');
  await rm(stage, { recursive: true, force: true });
  await cp(source, stage, { recursive: true, verbatimSymlinks: true });
  await stop();
  await availablePort(c.port);
  await rm(statePath, { force: true });
  await rm(join(root, 'app.previous'), { recursive: true, force: true });
  try {
    await rename(app, join(root, 'app.previous'));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await rename(stage, app);
  await writeFile(configPath, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await commandLauncher(root);
  await shortcuts(root, { remove: !c.shortcuts, autostart: c.autostart });
  await start();
  await rm(join(root, 'app.previous'), { recursive: true, force: true });
  console.log(
    `openwebprint ${release.version} is ready at http://127.0.0.1:${c.port}\nInstalled in ${root}`,
  );
  console.log(
    'Hardware mode uses the host CUPS and SANE tools. See the installation guide for hardware prerequisites.',
  );
  if (!values['no-open']) await browser(c.port);
}

async function managedApplication(directory) {
  try {
    await stat(directory);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  try {
    const release = await json(join(directory, 'release.json'));
    if (
      typeof release.version !== 'string' ||
      release.platform !== process.platform ||
      release.arch !== process.arch
    )
      throw new Error('Invalid release marker.');
  } catch {
    throw new Error(
      `Refusing to replace or remove an unrecognized application directory: ${directory}`,
    );
  }
}

async function browser(port) {
  const url = `http://127.0.0.1:${port}`;
  try {
    await openBrowser(url);
  } catch {
    console.log(`Could not open the browser automatically. Open ${url} in your browser.`);
  }
}

async function main() {
  if (!['linux', 'darwin'].includes(process.platform))
    throw new Error('Supported operating systems: Linux and macOS.');
  const action = positionals[0] || 'install';
  if (positionals.length > 1)
    throw new Error('Expected one command: install, open, start, stop, status, or uninstall.');
  if (action === 'install') return install();
  if (action === 'serve') return serve();
  if (action === 'stop') {
    await stop();
    return;
  }
  if (action === 'uninstall') {
    if (source === app)
      throw new Error(
        'Run uninstall using the downloaded installer, outside the installed application.',
      );
    await stop();
    await managedApplication(app);
    await managedApplication(join(root, 'app.previous'));
    await shortcuts(root, { remove: true });
    await commandLauncher(root, { remove: true });
    for (const name of ['app', 'app.previous', 'app.staging', 'running.json'])
      await rm(join(root, name), { recursive: true, force: true });
    console.log(`Removed openwebprint. Your configuration, documents, and logs remain in ${root}`);
    return;
  }
  if (action === 'status') {
    console.log((await control()) ? 'openwebprint is running.' : 'openwebprint is stopped.');
    return;
  }
  if (action === 'start' || action === 'open') {
    // A stopped process leaves a state file; only remove it after its endpoint is unreachable.
    if (!(await control())) await rm(statePath, { force: true });
    await start();
    if (action === 'open') await browser((await config()).port);
    return;
  }
  throw new Error('Unknown command. Use install, open, start, stop, status, or uninstall.');
}

let unlock;
try {
  if (process.getuid?.() === 0)
    throw new Error('Run this installer as your normal user, without sudo.');
  if (positionals[0] !== 'serve') unlock = await lock();
  await main();
} catch (error) {
  console.error(`openwebprint: ${error.message}`);
  process.exitCode = 1;
} finally {
  await unlock?.();
}
