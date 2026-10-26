import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Corrupt downloads must be rejected before unpacking or executing a runtime.
// Network commands are stubbed; the production bootstrap/checksum code is real.
const exec = promisify(execFile);
const fixture = await mkdtemp(join(tmpdir(), 'openwebprint download test '));
const payload = join(fixture, 'payload');
const checksum = join(fixture, 'checksum');
const marker = join(fixture, 'unpacked');
await writeFile(payload, 'corrupted package');
await writeFile(checksum, `${'0'.repeat(64)}  package.tar.gz\n`);
const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  let failure;
  const bin = join(fixture, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'curl'),
    `#!/bin/sh\nsource=${shell(payload)}\nfor argument do\n case "$argument" in *.sha256) source=${shell(checksum)} ;; esac\n destination=$argument\ndone\ncp "$source" "$destination"\n`,
    { mode: 0o700 },
  );
  await writeFile(join(bin, 'tar'), `#!/bin/sh\ntouch ${shell(marker)}\nexit 1\n`, {
    mode: 0o700,
  });
  try {
    await exec('sh', [resolve('install.sh')], {
      env: { ...process.env, OPENWEBPRINT_VERSION: 'v0.1.0', PATH: `${bin}:${process.env.PATH}` },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'A corrupt package must fail installation.');
  assert.match(`${failure.stdout}\n${failure.stderr}`, /Checksum mismatch/);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  console.log('Bootstrap rejected a corrupt download before extraction/execution.');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
