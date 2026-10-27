import { execFile, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';

const exec = promisify(execFile);
export function hardwarePath(platform = process.platform, path = process.env.PATH || '') {
  return platform === 'darwin'
    ? `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${path}`
    : path;
}
export async function available(executable, path = hardwarePath()) {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, executable), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}
// Only fixed commands reach this boundary. Raw output is classified locally and
// never returned to the web client or printed in installer diagnostics.
export async function probe(executable, args, timeout = 10_000) {
  const tool = basename(executable);
  try {
    const { stdout } = await exec(executable, args, {
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
      shell: false,
      env: {
        ...process.env,
        PATH: hardwarePath(),
        SOFTWARE: 'openwebprint',
        LANG: 'C',
        LC_ALL: 'C',
        LANGUAGE: 'C',
      },
    });
    return { state: 'ok', stdout };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing' };
    if (error.killed) return { state: 'timeout' };
    if (
      error.code === 'EACCES' ||
      /\b(forbidden|not authorized|permission denied|access denied)\b/i.test(error.stderr || '')
    )
      return { state: 'permission' };
    if (
      tool === 'lpstat' &&
      args.includes('-v') &&
      error.code === 1 &&
      error.stderr?.trim() === 'lpstat: No destinations added.'
    )
      return { state: 'empty' };
    if (tool === 'scanimage' && error.code === 11) return { state: 'permission' };
    return { state: 'unavailable' };
  }
}

export async function checkHardware({
  platform = process.platform,
  method = 'native',
  server = 'localhost:631',
  setupCommand,
  run = probe,
  has = available,
} = {}) {
  const checks = [];
  for (const tool of ['lp', 'lpadmin', 'lpstat', 'cancel', 'scanimage']) {
    checks.push({
      id: tool,
      label: tool === 'scanimage' ? 'Scanning software (SANE)' : `Printing tool: ${tool}`,
      state: (await has(tool)) ? 'ok' : 'missing',
    });
  }
  if (checks.find((check) => check.id === 'lpstat').state === 'ok') {
    const scheduler = await run('lpstat', ['-h', server, '-r']);
    // lpstat -r can exit successfully while reporting a stopped scheduler.
    const running = scheduler.state === 'ok' && scheduler.stdout?.trim() === 'scheduler is running';
    checks.push({
      id: 'cups',
      label: 'CUPS printing service',
      state: running ? 'ok' : scheduler.state === 'ok' ? 'unavailable' : scheduler.state,
    });
    if (running) {
      const queues = await run('lpstat', ['-h', server, '-v']);
      checks.push({
        id: 'printers',
        label: 'Configured printer search',
        state: queues.state === 'ok' && !queues.stdout?.trim() ? 'empty' : queues.state,
      });
    }
  }
  if (checks.find((check) => check.id === 'scanimage').state === 'ok') {
    const scanners = await run('scanimage', ['--formatted-device-list=%d%n'], 35_000);
    checks.push({
      id: 'scanners',
      label: 'Scanner search',
      state: scanners.state === 'ok' && !scanners.stdout?.trim() ? 'empty' : scanners.state,
    });
  }
  // On Debian-family systems these are independent prerequisites: finding the
  // CLI tools does not establish that filters or network scanner backends exist.
  if (platform === 'linux' && (await has('dpkg-query'))) {
    for (const [name, label] of [
      ['cups-filters', 'CUPS print filters'],
      ['sane-airscan', 'AirScan/WSD scanner backend'],
      ['avahi-daemon', 'Multicast discovery software'],
    ]) {
      const result = await run('dpkg-query', ['-W', '-f=${db:Status-Status}', name]);
      checks.push({
        id: name,
        label,
        state:
          result.state === 'ok'
            ? result.stdout?.trim() === 'installed'
              ? 'ok'
              : 'missing'
            : result.state === 'unavailable'
              ? 'missing'
              : result.state,
      });
    }
  }
  const ready = checks.every((check) => ['ok', 'empty'].includes(check.state));
  let guidance =
    method === 'container'
      ? 'Checks describe this container. Rebuild the hardware image with CUPS/SANE and start its CUPS service. Check container network and USB access; Docker Desktop may require Local Network permission.'
      : platform === 'darwin'
        ? 'Printing uses macOS CUPS. Use System Settings → Printers & Scanners to add printers or resolve queue permissions. Allow openwebprint/its runtime Local Network access when macOS requests it. Scanner compatibility depends on the installed SANE backend; vendor-only macOS scanner drivers are not SANE drivers.'
        : 'Printing uses the local CUPS service. Add printers or resolve queue permissions in your OS printer settings. For USB scanners, install the device backend and grant your normal account access using your distribution’s scanner/udev rules; do not run openwebprint as root.';
  if (
    method === 'native' &&
    platform === 'darwin' &&
    checks.find((item) => item.id === 'scanimage').state === 'missing' &&
    !(await has('brew'))
  )
    guidance +=
      ' Homebrew is also missing. Install it explicitly from https://brew.sh, then rerun the integrated setup to install SANE. A package manager will never be installed automatically.';
  return {
    checkedAt: new Date().toISOString(),
    platform,
    method,
    ready,
    checks,
    guidance,
    ...(setupCommand ? { setupCommand } : {}),
    note: 'Successful checks verify software access, not device compatibility. An empty search means no devices were found; no page was printed or scanned.',
  };
}

export async function hardwarePlan({
  platform = process.platform,
  read = readFile,
  has = available,
} = {}) {
  if (platform === 'darwin') {
    const commands = [];
    const needsSane = !(await has('scanimage'));
    const brew = await has('brew');
    if (needsSane && brew) commands.push(['brew', 'install', 'sane-backends']);
    return {
      commands,
      service: [
        ['sudo', 'launchctl', 'enable', 'system/org.cups.cupsd'],
        ['sudo', 'launchctl', 'kickstart', 'system/org.cups.cupsd'],
      ],
      guidance: !needsSane
        ? 'SANE is already available. No scanner package change is needed; device backend compatibility is checked when connecting a scanner.'
        : brew
          ? 'Uses existing Homebrew for SANE. Scanner protocol support depends on the installed backends. This does not install sane-airscan/WSD support or vendor drivers.'
          : 'SANE is required for scanning. Install Homebrew explicitly from https://brew.sh, then rerun hardware setup to install sane-backends. No package manager will be installed automatically. macOS CUPS is supplied by the OS.',
    };
  }
  const release = await read('/etc/os-release', 'utf8').catch(() => '');
  const id = /^ID=["']?([^\n"']+)/m.exec(release)?.[1];
  if (['debian', 'ubuntu'].includes(id) && (await has('apt-get')) && (await has('systemctl'))) {
    return {
      commands: [
        ['sudo', 'apt-get', 'update'],
        [
          'sudo',
          'apt-get',
          'install',
          '-y',
          'cups',
          'cups-client',
          'cups-filters',
          'sane-utils',
          'sane-airscan',
          'avahi-daemon',
        ],
      ],
      service: [['sudo', 'systemctl', 'enable', '--now', 'cups', 'avahi-daemon']],
      guidance:
        'Installs CUPS, print filters, SANE and AirScan/WSD discovery from your configured OS repositories. Enables CUPS and Avahi at boot. Package dependencies may also be installed. Device-specific drivers are separate.',
    };
  }
  return {
    commands: [],
    service: [],
    guidance:
      'Automatic OS changes support Debian/Ubuntu with apt-get/systemd and macOS with existing Homebrew. On this Linux distribution, use its software manager to install CUPS client/server, print filters, SANE utilities and sane-airscan, then enable CUPS and multicast discovery. Rerun hardware setup afterward.',
  };
}

const stateText = {
  ok: 'Available',
  empty: 'Search succeeded; no devices found',
  missing: 'Software missing',
  unavailable: 'Service or backend unavailable',
  permission: 'Permission denied',
  timeout: 'Check timed out',
};
export function printHardware(report, log = console.log) {
  log('\nPrinting and scanning prerequisites:');
  for (const check of report.checks) log(`  ${check.label}: ${stateText[check.state]}`);
  log(
    report.ready
      ? 'Software checks passed. Device setup still requires a compatible device.'
      : 'Hardware setup is incomplete. Resolve the requirements below before using the affected function.',
  );
  log(report.guidance);
  if (report.setupCommand) log(`Retry integrated setup: ${report.setupCommand}`);
  log(report.note);
}
export async function confirmHardware(message) {
  // Noninteractive installs never imply consent and never invoke sudo.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${message} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}
export async function runHardwareCommand([executable, ...args]) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, PATH: hardwarePath() },
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('OS setup command failed or was canceled.')),
    );
  });
}
export async function setupHardware({
  check = checkHardware,
  plan = hardwarePlan,
  confirm = confirmHardware,
  execute = runHardwareCommand,
  log = console.log,
} = {}) {
  let report = await check();
  printHardware(report, log);
  const steps = await plan();
  log(steps.guidance);
  // Offer the supported package set even with tools present: filters and scanner
  // discovery backends are separate packages, not implied by scanimage/lpstat.
  let packagesChanged = false;
  if (steps.commands.length) {
    log(`OS package changes:\n${steps.commands.map((args) => `  ${args.join(' ')}`).join('\n')}`);
    if (
      await confirm(
        'Install/verify these hardware packages? Administrative commands may request your OS password.',
      )
    ) {
      try {
        for (const args of steps.commands) await execute(args);
        packagesChanged = true;
      } catch {
        log(
          'Package setup failed or was canceled. Check the package manager output above and retry hardware setup.',
        );
      }
    } else log('Package changes skipped. No consent received.');
    if (packagesChanged) report = await check();
  }
  if (
    (packagesChanged ||
      report.checks.some((item) => item.id === 'cups' && item.state === 'unavailable')) &&
    steps.service.length
  ) {
    log(`OS service changes:\n${steps.service.map((args) => `  ${args.join(' ')}`).join('\n')}`);
    if (await confirm('Enable/start these OS services? sudo may request your OS password.')) {
      try {
        for (const args of steps.service) await execute(args);
      } catch {
        log(
          'Service setup failed or was canceled. Use your OS service/printer settings, then retry.',
        );
      }
    } else log('Service changes skipped. No consent received.');
  }
  report = await check();
  printHardware(report, log);
  return report;
}
