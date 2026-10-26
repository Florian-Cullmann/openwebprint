import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { cp, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { commandLauncher, defaultRoot, openBrowser, runtime, shortcuts } from './platform.mjs';

process.umask(0o077);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string', default: defaultRoot() },
    port: { type: 'string' },
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
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/${action}`, {
      method: action === 'stop' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${state.token}`, Connection: 'close' },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('The private control endpoint rejected the request.');
    const result = await response.json();
    if (result.root !== root)
      throw new Error('The private control endpoint belongs to another installation.');
    return result;
  } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code)) return null;
    throw error;
  }
}

async function stop() {
  if (!(await control())) return;
  await control('stop');
  for (let i = 0; i < 160; i++) {
    if (!(await control())) return;
    await sleep(1000);
  }
  throw new Error('openwebprint did not stop. Close running operations and try again.');
}

async function start() {
  if (await control()) return;
  const c = await config();
  const logDirectory = join(root, 'logs');
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const log = await open(join(logDirectory, 'server.log'), 'a', 0o600);
  // A separate runtime makes the browser launcher and login hook short-lived.
  const child = spawn(
    runtime(app),
    [join(app, 'scripts/install/manage.mjs'), '--root', root, 'serve'],
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
      for (let i = 0; i < 60; i++) {
        if ((await control())?.ready) {
          const response = await fetch(`http://127.0.0.1:${c.port}/api/health`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) return;
        }
        await sleep(500);
      }
      throw new Error(`Startup failed. See ${join(logDirectory, 'server.log')}`);
    })(),
  ]);
}

async function serve() {
  const c = await config();
  // Claim the instance file before opening SQLite. Never signal an unverified PID.
  const token = randomBytes(32).toString('hex');
  let ready = false;
  const controlServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== '/status' && !(req.url === '/stop' && req.method === 'POST')) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ root, port: c.port, ready }), () => {
      if (req.url === '/stop') process.kill(process.pid, 'SIGTERM');
    });
  });
  await new Promise((done, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(0, '127.0.0.1', done);
  });
  const state = { port: controlServer.address().port, token, pid: process.pid };
  try {
    const file = await open(statePath, 'wx', 0o600);
    await file.writeFile(JSON.stringify(state));
    await file.close();
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
  if (c.shortcuts) await shortcuts(root, { autostart: c.autostart });
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
    if (!values['no-shortcuts']) await shortcuts(root, { remove: true });
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
