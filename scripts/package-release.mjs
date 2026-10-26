import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// The release workflow builds on each target OS/architecture. Native sharp/libvips
// dependencies must be installed for that target, never copied from another OS.
export const nodeVersion = '24.22.1';
const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.OWP_PACKAGE_DIR || join(root, '.local', 'packages'));
const version =
  process.env.OWP_RELEASE_VERSION || JSON.parse(await readFile(join(root, 'package.json'))).version;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
  throw new Error('Invalid release version.');
if (
  !['linux', 'darwin', 'win32'].includes(process.platform) ||
  !['x64', 'arm64'].includes(process.arch)
)
  throw new Error('Release packages support Linux, macOS, and Windows on x64/arm64.');
const name = `openwebprint-${process.platform}-${process.arch}`;
const stage = join(output, name);
const temporary = join(output, 'runtime-download');
await mkdir(output, { recursive: true });
await rm(stage, { recursive: true, force: true });
await rm(temporary, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(temporary, { recursive: true });
for (const path of [
  'package.json',
  'package-lock.json',
  'apps/server/package.json',
  'apps/client/package.json',
  'packages/shared/package.json',
  'LICENSE',
  'README.md',
  'docs/installation.md',
]) {
  await mkdir(resolve(stage, path, '..'), { recursive: true });
  await cp(join(root, path), join(stage, path));
}
for (const path of [
  'apps/server/dist',
  'apps/client/dist',
  'scripts/install',
  'scripts/reset-access.mjs',
]) {
  await mkdir(resolve(stage, path, '..'), { recursive: true });
  await cp(join(root, path), join(stage, path), { recursive: true });
}
// Use the committed workspace lockfile, but ship only server runtime dependencies.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this build script through npm run package:release.');
execFileSync(
  process.execPath,
  [
    npm,
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--workspace=@openwebprint/server',
    '--include-workspace-root',
    '--no-audit',
    '--no-fund',
  ],
  { cwd: stage, stdio: 'inherit' },
);
// tsup bundles the shared workspace. Workspace links and dependency CLI shims
// are unnecessary at runtime and must not require Windows symlink privileges.
await rm(join(stage, 'node_modules', '@openwebprint'), { recursive: true, force: true });
await rm(join(stage, 'node_modules', '.bin'), { recursive: true, force: true });
const target = process.platform === 'win32' ? 'win' : process.platform;
const runtimeName = `node-v${nodeVersion}-${target}-${process.arch}`;
const archive = `${runtimeName}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
const base = `https://nodejs.org/dist/v${nodeVersion}`;
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
const [checksums, bytes] = await Promise.all([
  download(`${base}/SHASUMS256.txt`),
  download(`${base}/${archive}`),
]);
const expected = checksums
  .toString()
  .split('\n')
  .find((line) => line.trim().endsWith(`  ${archive}`))
  ?.split(/\s+/)[0];
if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected)
  throw new Error('Node.js checksum verification failed.');
const downloaded = join(temporary, archive);
await writeFile(downloaded, bytes);
if (process.platform === 'win32') {
  // Paths are passed as script parameters, never interpolated into PowerShell source.
  execFileSync('tar.exe', ['-xf', downloaded, '-C', temporary]);
} else execFileSync('tar', ['-xzf', downloaded, '-C', temporary]);
await mkdir(join(stage, 'runtime'));
await cp(
  join(temporary, runtimeName, process.platform === 'win32' ? 'node.exe' : 'bin/node'),
  join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
);
await cp(join(temporary, runtimeName, 'LICENSE'), join(stage, 'runtime', 'LICENSE'));
await writeFile(
  join(stage, 'release.json'),
  `${JSON.stringify({ version, platform: process.platform, arch: process.arch, nodeVersion }, null, 2)}\n`,
);
const packed = join(output, `${name}.tar.gz`);
execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', [
  '-czf',
  packed,
  '-C',
  output,
  name,
]);
const sum = createHash('sha256')
  .update(await readFile(packed))
  .digest('hex');
await writeFile(`${packed}.sha256`, `${sum}  ${name}.tar.gz\n`);
await rm(temporary, { recursive: true, force: true });
console.log(`Packaged ${packed}`);
