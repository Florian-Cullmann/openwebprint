import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const xml = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const desktop = (value) =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%')}"`;

export function defaultRoot() {
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'openwebprint');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'openwebprint');
}

export function runtime(app) {
  return join(app, 'runtime', 'node');
}

export async function openBrowser(url) {
  await exec(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

// Login hooks start the same private runtime on every platform. No privileged
// service, extra process supervisor, or container engine is installed.
export async function shortcuts(root, { remove = false, autostart = true } = {}) {
  const node = runtime(join(root, 'app'));
  const manager = join(root, 'app', 'scripts', 'install', 'manage.mjs');
  const args = [manager, '--root', root];
  // Multiple installation roots share one menu/login slot. A headless install
  // must not remove another installation's entries (including during tests).
  const removeOwned = async (path, marker, target = path) => {
    let contents;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (contents.includes(marker)) await rm(target, { recursive: target !== path, force: true });
  };
  const write = async (path, text, mode = 0o600) => {
    if (remove) return removeOwned(path, desktop(manager));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { mode });
  };
  if (process.platform === 'darwin') {
    const agent = join(homedir(), 'Library', 'LaunchAgents', 'org.openwebprint.plist');
    if (remove || !autostart) await removeOwned(agent, `<string>${xml(manager)}</string>`);
    else
      await write(
        agent,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>org.openwebprint</string>
<key>ProgramArguments</key><array>${[node, ...args, 'start'].map((v) => `<string>${xml(v)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/></dict></plist>\n`,
      );
    const bundle = join(homedir(), 'Applications', 'openwebprint.app');
    if (remove)
      await removeOwned(join(bundle, 'Contents', 'MacOS', 'openwebprint'), shell(manager), bundle);
    else {
      await write(
        join(bundle, 'Contents', 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.openwebprint.launcher</string><key>CFBundleName</key><string>openwebprint</string><key>CFBundleExecutable</key><string>openwebprint</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>\n`,
      );
      await write(
        join(bundle, 'Contents', 'MacOS', 'openwebprint'),
        `#!/bin/sh\nexec ${[node, ...args, 'open'].map(shell).join(' ')}\n`,
        0o700,
      );
    }
    return;
  }
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const entry = (command) =>
    `[Desktop Entry]\nType=Application\nName=openwebprint\nComment=Print and scan in your browser\nExec=${[node, ...args, command].map(desktop).join(' ')}\nTerminal=false\nCategories=Office;\n`;
  const login = join(config, 'autostart', 'openwebprint.desktop');
  if (remove || !autostart) await removeOwned(login, desktop(manager));
  else await write(login, entry('start'));
  await write(join(data, 'applications', 'openwebprint.desktop'), entry('open'));
}

export async function commandLauncher(root, { remove = false } = {}) {
  const node = runtime(join(root, 'app'));
  const manager = join(root, 'app', 'scripts/install/manage.mjs');
  const file = join(root, 'openwebprint');
  if (remove) return rm(file, { force: true });
  const text = `#!/bin/sh\nexec ${[node, manager, '--root', root].map(shell).join(' ')} "$@"\n`;
  await writeFile(file, text, { mode: 0o700 });
}
