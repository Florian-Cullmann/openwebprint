import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkHardware,
  hardwarePlan,
  probe,
  setupHardware,
  confirmHardware,
} from './install/hardware.mjs';

// Controlled OS/command fixtures: no packages, privileges, services or physical
// devices are changed. The production check/consent/repair orchestration is real.
const has = async (tool) => tool !== 'dpkg-query';
const healthy = async (tool, args) =>
  args.includes('-r')
    ? { state: 'ok', stdout: 'scheduler is running\n' }
    : { state: 'ok', stdout: '' };
const check = (extra = {}) => checkHardware({ has, run: healthy, ...extra });
const plan = () => hardwarePlan({ platform: 'linux', has, read: async () => 'ID=ubuntu\n' });
const quiet = () => {};
test('missing printing/scanning tools do not imply a successful empty search', async () => {
  const result = await check({
    has: async () => false,
    run: () => assert.fail('No absent tool may run'),
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.length, 5);
  assert.ok(result.checks.every((item) => item.state === 'missing'));
});
test('present software with empty discovery is usable but does not certify hardware', async () => {
  const result = await check();
  assert.equal(result.ready, true);
  assert.equal(result.checks.find((item) => item.id === 'scanners').state, 'empty');
  assert.equal(result.checks.find((item) => item.id === 'printers').state, 'empty');
  assert.match(result.note, /not device compatibility/);
});
test('present CLI tools do not hide absent Debian print filters and scanner backends', async () => {
  const result = await check({
    platform: 'linux',
    has: async () => true,
    run: async (tool, args) =>
      tool === 'dpkg-query' ? { state: 'unavailable' } : healthy(tool, args),
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((item) => item.id === 'cups-filters').state, 'missing');
  assert.equal(result.checks.find((item) => item.id === 'sane-airscan').state, 'missing');
  const repaired = await check({
    platform: 'linux',
    has: async () => true,
    run: async (tool, args) =>
      tool === 'dpkg-query' ? { state: 'ok', stdout: 'installed' } : healthy(tool, args),
  });
  assert.equal(repaired.ready, true);
});
test('stopped scheduler, permission failure, timeout and recovery remain distinct', async () => {
  for (const state of ['unavailable', 'permission', 'timeout']) {
    const result = await check({ run: async () => ({ state }) });
    assert.equal(result.ready, false);
    assert.equal(result.checks.find((item) => item.id === 'cups').state, state);
    assert.equal(result.checks.find((item) => item.id === 'scanners').state, state);
    assert.ok(!result.checks.some((item) => item.id === 'printers'));
  }
  const stopped = await check({
    run: async () => ({ state: 'ok', stdout: 'scheduler is not running' }),
  });
  assert.equal(stopped.checks.find((item) => item.id === 'cups').state, 'unavailable');
  assert.equal((await check()).ready, true);
});
test('service startup rechecks CUPS until reachable, with a bounded retry budget', async () => {
  let attempts = 0;
  const pauses = [];
  const result = await check({
    serviceAttempts: 3,
    pause: async (ms) => pauses.push(ms),
    run: async (tool, args) =>
      args.includes('-r') && ++attempts < 3
        ? { state: 'ok', stdout: 'scheduler is not running' }
        : healthy(tool, args),
  });
  assert.equal(result.ready, true);
  assert.equal(attempts, 3);
  assert.deepEqual(pauses, [500, 500]);
  attempts = 0;
  const failed = await check({
    serviceAttempts: 3,
    pause: async () => {},
    run: async () => {
      attempts++;
      return { state: 'unavailable' };
    },
  });
  assert.equal(failed.ready, false);
  assert.equal(attempts, 4); // three scheduler probes plus one scanner listing
});
test('native and container recovery guidance respects installation boundaries', async () => {
  const native = await check({
    platform: 'darwin',
    method: 'native',
    setupCommand: "'/some app/openwebprint' hardware",
  });
  assert.ok(!native.guidance.includes('Docker'));
  assert.match(native.guidance, /Printers & Scanners/);
  assert.match(native.setupCommand, /hardware$/);
  assert.match((await check({ method: 'container' })).guidance, /container/);
});
test('Debian/Ubuntu plan includes filters, discovery backends and service setup; unsupported distros remain explicit', async () => {
  for (const id of ['debian', 'ubuntu']) {
    const steps = await hardwarePlan({ platform: 'linux', has, read: async () => `ID="${id}"\n` });
    assert.ok(steps.commands[1].includes('cups-filters'));
    assert.ok(steps.commands[1].includes('sane-airscan'));
    assert.deepEqual(steps.service[0], [
      'sudo',
      'systemctl',
      'enable',
      '--now',
      'cups',
      'avahi-daemon',
    ]);
  }
  const unsupported = await hardwarePlan({
    platform: 'linux',
    has,
    read: async () => 'ID=fedora\n',
  });
  assert.deepEqual(unsupported.commands, []);
  assert.deepEqual(unsupported.service, []);
  assert.match(unsupported.guidance, /software manager/);
});
test('macOS uses existing Homebrew without installing a package manager or requiring root for brew', async () => {
  const steps = await hardwarePlan({ platform: 'darwin', has: async (tool) => tool === 'brew' });
  assert.deepEqual(steps.commands, [['brew', 'install', 'sane-backends']]);
  const absent = await hardwarePlan({ platform: 'darwin', has: async () => false });
  assert.deepEqual(absent.commands, []);
  assert.match(absent.guidance, /https:\/\/brew.sh/);
  const present = await hardwarePlan({ platform: 'darwin', has });
  assert.deepEqual(present.commands, []);
});
test('declining packages and services never elevates privileges; noninteractive input never grants consent', async () => {
  const result = await setupHardware({
    check: () => check({ run: async () => ({ state: 'unavailable' }) }),
    plan,
    confirm: async () => false,
    execute: () => assert.fail('OS changes require consent'),
    log: quiet,
  });
  assert.equal(result.ready, false);
  if (!process.stdin.isTTY) assert.equal(await confirmHardware('No noninteractive consent'), false);
});
test('consented install and service startup recheck prerequisites and recover', async () => {
  let installed = false;
  let started = false;
  const commands = [];
  const result = await setupHardware({
    check: (options) =>
      check({
        ...options,
        has: async (tool) => installed && tool !== 'dpkg-query',
        run: async (tool, args) => (started ? healthy(tool, args) : { state: 'unavailable' }),
      }),
    plan,
    confirm: async () => true,
    execute: async (args) => {
      commands.push(args);
      if (args.includes('install')) installed = true;
      if (args.includes('systemctl')) started = true;
    },
    log: quiet,
  });
  assert.equal(result.ready, true);
  assert.equal(commands.length, 3);
  assert.ok(started);
});
test('failed package command stops package changes and remains recoverable', async () => {
  const logs = [];
  let count = 0;
  const result = await setupHardware({
    check: () => check({ has: async () => false }),
    plan,
    confirm: async () => true,
    execute: async () => {
      count++;
      throw new Error('private backend failure');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(count, 1);
  assert.equal(result.ready, false);
  assert.match(logs.join('\n'), /setup failed or was canceled/);
  assert.ok(!logs.join('\n').includes('private backend failure'));
  assert.equal(
    (
      await setupHardware({
        check,
        plan: async () => ({ commands: [], service: [], guidance: '' }),
        log: quiet,
      })
    ).ready,
    true,
  );
});
test('service failure stays explicit and never promotes unavailable CUPS to ready', async () => {
  const logs = [];
  const result = await setupHardware({
    check: () => check({ run: async () => ({ state: 'unavailable' }) }),
    plan: async () => ({
      commands: [],
      service: [['sudo', 'systemctl', 'enable', '--now', 'cups']],
      guidance: '',
    }),
    confirm: async () => true,
    execute: async () => {
      throw new Error('private service failure');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.ready, false);
  assert.match(logs.join('\n'), /Service setup failed or was canceled/);
  assert.ok(!logs.join('\n').includes('private service failure'));
});
test('production process probe bounds execution and redacts command failures', async () => {
  assert.deepEqual(await probe('openwebprint-does-not-exist', []), { state: 'missing' });
  assert.deepEqual(await probe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 30), {
    state: 'timeout',
  });
  const directory = await mkdtemp(join(tmpdir(), 'owp-prerequisites-'));
  try {
    await writeFile(
      join(directory, 'lpstat'),
      '#!/bin/sh\necho "lpstat: No destinations added." >&2\nexit 1\n',
      { mode: 0o700 },
    );
    assert.deepEqual(await probe(join(directory, 'lpstat'), ['-v']), { state: 'empty' });
    await writeFile(
      join(directory, 'scanimage'),
      '#!/bin/sh\necho "Permission denied: private-device" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    assert.deepEqual(await probe(join(directory, 'scanimage'), []), { state: 'permission' });
    await writeFile(
      join(directory, 'scanimage'),
      '#!/bin/sh\necho "private-device unavailable" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    assert.deepEqual(await probe(join(directory, 'scanimage'), []), { state: 'unavailable' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
