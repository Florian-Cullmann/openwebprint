import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, credentials } from './helpers.js';
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
describe('optional authentication and user management', () => {
  it('opens new installations without accounts and protects mutations against cross-origin requests', async () => {
    f = await fixture({ users: false });
    expect(f.auth.users()).toEqual([]);
    expect((await f.app.inject('/api/session')).json()).toMatchObject({
      authenticationRequired: false,
      authenticated: false,
    });
    expect((await f.app.inject('/api/snapshot')).statusCode).toBe(200);
    expect((await f.app.inject('/api/users')).json()).toEqual([]);
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/users', payload: credentials })).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/users',
          headers: { 'x-openwebprint': '1', origin: 'https://evil.example' },
          payload: credentials,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/setup', headers: f.headers, payload: {} }))
        .statusCode,
    ).toBe(404);
  });
  it('enables login immediately after the first user and blocks anonymous account changes', async () => {
    f = await fixture({ users: false });
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: f.headers,
      payload: credentials,
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['set-cookie']).toBeUndefined();
    expect(created.json()).not.toHaveProperty('password');
    expect((await f.app.inject('/api/session')).json()).toMatchObject({
      authenticationRequired: true,
      authenticated: false,
    });
    for (const url of ['/api/snapshot', '/api/users'])
      expect((await f.app.inject(url)).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/users',
          headers: f.headers,
          payload: { ...credentials, username: 'intruder' },
        })
      ).statusCode,
    ).toBe(401);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: f.headers,
      payload: credentials,
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect((await f.app.inject({ url: '/api/snapshot', headers: { cookie } })).statusCode).toBe(
      200,
    );
  });
  it('supports multiple accounts, rejects duplicate names and revokes deleted accounts sessions', async () => {
    f = await fixture();
    const first = f.auth.users()[0];
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: f.headers,
      payload: { ...credentials, username: 'second-user' },
    });
    expect(created.statusCode).toBe(201);
    const second = created.json();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/users',
          headers: f.headers,
          payload: { ...credentials, username: 'SECOND-USER' },
        })
      ).statusCode,
    ).toBe(409);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: f.headers,
      payload: { ...credentials, username: second.username },
    });
    const secondCookie = String(login.headers['set-cookie']).split(';')[0];
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/api/users/${second.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (await f.app.inject({ url: '/api/snapshot', headers: { cookie: secondCookie } })).statusCode,
    ).toBe(401);
    expect((await f.app.inject({ url: '/api/snapshot', headers: f.headers })).statusCode).toBe(200);
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/api/users/${first.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(200);
    expect((await f.app.inject('/api/session')).json()).toMatchObject({
      authenticationRequired: false,
      authenticated: false,
    });
    expect((await f.app.inject('/api/snapshot')).statusCode).toBe(200);
    expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count).toBe(0);
  });
  it('preserves existing passwords while migrating the legacy single-user database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owp-migration-'));
    const db = new DatabaseSync(join(directory, 'openwebprint.sqlite'));
    const salt = 'legacy-password-salt';
    const encoded = `${salt}:${scryptSync(credentials.password, salt, 64).toString('hex')}`;
    const oldSession = createHash('sha256').update('old-cookie').digest('hex');
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL); PRAGMA user_version=1;',
    );
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('username', credentials.username);
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('password', encoded);
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(oldSession, Date.now() + 100_000);
    db.close();
    try {
      f = await fixture({ dataDir: directory });
      expect(f.auth.users()).toHaveLength(1);
      expect(f.auth.users()[0].username).toBe(credentials.username);
      expect(f.store.setting('password')).toBeUndefined();
      expect(f.store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
      expect(
        (
          await f.app.inject({
            url: '/api/snapshot',
            headers: { cookie: 'owp_session=old-cookie' },
          })
        ).statusCode,
      ).toBe(401);
      expect((await f.app.inject({ url: '/api/snapshot', headers: f.headers })).statusCode).toBe(
        200,
      );
      const id = f.auth.users()[0].id;
      await f.close(false);
      f = undefined;
      f = await fixture({ dataDir: directory });
      expect(f.auth.users()).toHaveLength(1);
      expect(f.auth.users()[0].id).toBe(id);
    } finally {
      if (!f) await rm(directory, { recursive: true, force: true });
    }
  });
});
