import assert from 'node:assert/strict';
import { checkHardware, setupHardware } from './install/hardware.mjs';

// This test deliberately changes ONLY a disposable CI runner. It is separate
// from npm test/test:install and is never shipped in an end-user release.
if (process.env.CI !== 'true' || process.env.OWP_TEST_ALLOW_OS_CHANGES !== '1')
  throw new Error(
    'Real hardware dependency setup requires a disposable CI runner and OWP_TEST_ALLOW_OS_CHANGES=1.',
  );
if (process.getuid?.() === 0) throw new Error('Run as the runner user, not root.');
const before = await checkHardware();
console.log(
  `Initial software state: ${before.ready ? 'available' : 'requirements missing'} (${process.platform}/${process.arch})`,
);
const result = await setupHardware({
  confirm: async (message) => {
    console.log(`${message}\nExplicit CI-only OS-change consent: OWP_TEST_ALLOW_OS_CHANGES=1.`);
    return true;
  },
});
assert.equal(
  result.ready,
  true,
  'Real package/service setup must leave tool/service checks usable.',
);
assert.equal(result.checks.find((item) => item.id === 'cups')?.state, 'ok');
assert.equal(result.checks.find((item) => item.id === 'scanimage')?.state, 'ok');
const repeated = await checkHardware();
assert.equal(repeated.ready, true, 'Prerequisites must remain usable on a repeated check.');
console.log(
  'Real dependency setup and repeat checks passed; no physical print/scan was performed.',
);
