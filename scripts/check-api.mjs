// Run only against a fresh disposable container; this temporarily creates a test account.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (process.env.OWP_TEST_INSTANCE !== '1')
  throw new Error('This check requires OWP_TEST_INSTANCE=1 on a disposable instance.');
const base = 'http://127.0.0.1:3001';
const headers = { 'x-openwebprint': '1', 'Content-Type': 'application/json' };
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    if ((await fetch(base + '/api/health')).ok) break;
  } catch {}
  if (attempt === 29) throw new Error('Container startup timed out.');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const session = await (await fetch(base + '/api/session')).json();
assert.equal(session.authenticationRequired, false);
assert.equal(session.authenticated, false);
assert.equal(session.onboardingRequired, true);
if (process.env.MODE === 'hardware') {
  const start = await fetch(base + '/api/onboarding/start', {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(start.status, 200);
  const devices = await fetch(base + '/api/onboarding/devices', {
    method: 'POST',
    headers,
    body: JSON.stringify({ devices: [] }),
  });
  assert.equal(devices.status, 200);
  const storage = await fetch(base + '/api/onboarding/storage', {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: '/data/scans' }),
  });
  assert.equal(storage.status, 200);
} else {
  assert.equal(
    (await fetch(base + '/api/onboarding/demo', { method: 'POST', headers, body: '{}' })).status,
    200,
  );
}
const snapshot = await (await fetch(base + '/api/snapshot')).json();
assert.equal(snapshot.mode, process.env.MODE === 'hardware' ? 'hardware' : 'demo');
assert.equal(snapshot.devices.length, snapshot.mode === 'demo' ? 3 : 0);
const html = await (await fetch(base + '/settings/users')).text();
assert.ok(html.includes('lang="en"'));
const credentials = { username: 'container-check', password: randomUUID() };
const created = await fetch(base + '/api/users', {
  method: 'POST',
  headers,
  body: JSON.stringify(credentials),
});
assert.equal(created.status, 201);
const user = await created.json();
assert.equal((await fetch(base + '/api/snapshot')).status, 401);
const login = await fetch(base + '/api/login', {
  method: 'POST',
  headers,
  body: JSON.stringify(credentials),
});
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
assert.equal((await fetch(base + '/api/snapshot', { headers: { cookie } })).status, 200);
const removed = await fetch(base + `/api/users/${user.id}`, {
  method: 'DELETE',
  headers: { cookie, 'x-openwebprint': '1' },
});
assert.equal(removed.status, 200);
assert.equal((await fetch(base + '/api/snapshot')).status, 200);
console.log(
  `PASS ${snapshot.mode}: open access, English deep links, optional authentication, login and last-user removal`,
);
