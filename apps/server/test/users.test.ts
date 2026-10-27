import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyReply } from 'fastify';
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

it('creates and authenticates short, whitespace-only and long passwords without a complexity policy', async () => {
  f = await fixture({ users: false });
  for (const password of ['a', ' ', 'x'.repeat(512)]) {
    const payload = { username: 'simple-password', password };
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: f.headers,
      payload,
    });
    expect(created.statusCode, created.body).toBe(201);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: f.headers,
      payload,
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/users/${created.json().id}`,
          headers: { cookie, 'x-openwebprint': '1' },
        })
      ).statusCode,
    ).toBe(200);
  }
});

describe('password changes', () => {
  it('rotates the current session, revokes other sessions and preserves other accounts', async () => {
    f = await fixture();
    const login = async (username: string, password: string) =>
      f!.app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { 'x-openwebprint': '1' },
        payload: { username, password },
      });
    const otherSession = await login(credentials.username, credentials.password);
    await f.auth.createUser('other', 'other-password', f.auth.users()[0]);
    const otherUser = await login('other', 'other-password');
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: f.headers,
      payload: { currentPassword: credentials.password, newPassword: ' ' },
    });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    expect(cookie).not.toBe(f.cookie);
    for (const revoked of [f.cookie, String(otherSession.headers['set-cookie']).split(';')[0]])
      expect(
        (await f.app.inject({ url: '/api/snapshot', headers: { cookie: revoked } })).statusCode,
      ).toBe(401);
    for (const valid of [cookie, String(otherUser.headers['set-cookie']).split(';')[0]])
      expect(
        (await f.app.inject({ url: '/api/snapshot', headers: { cookie: valid } })).statusCode,
      ).toBe(200);
    expect((await login(credentials.username, credentials.password)).statusCode).toBe(401);
    expect((await login(credentials.username, ' ')).statusCode).toBe(200);
  });

  it('requires authentication even on an instance without users', async () => {
    f = await fixture({ users: false });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/account/password',
          headers: f.headers,
          payload: { currentPassword: 'a', newPassword: 'b' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('rejects anonymous and cross-origin requests, wrong passwords, empty passwords and account targeting', async () => {
    f = await fixture();
    const payload = { currentPassword: credentials.password, newPassword: 'new' };
    const request = (headers: Record<string, string>, body = payload) =>
      f!.app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers,
        payload: body,
      });
    expect((await request({ 'x-openwebprint': '1' })).statusCode).toBe(401);
    expect((await request({ cookie: f.cookie })).statusCode).toBe(403);
    expect((await request({ ...f.headers, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await request(f.headers, { ...payload, currentPassword: 'wrong' })).statusCode).toBe(
      400,
    );
    expect((await request(f.headers, { ...payload, newPassword: '' })).statusCode).toBe(400);
    expect(
      (await request(f.headers, { ...payload, ...{ userId: 'another-account' } })).statusCode,
    ).toBe(400);
    expect((await f.app.inject({ url: '/api/snapshot', headers: f.headers })).statusCode).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: f.headers,
          payload: credentials,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('rate limits password guessing without changing credentials', async () => {
    f = await fixture();
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: f.headers,
        payload: { currentPassword: 'wrong', newPassword: 'new' },
      });
      expect(response.statusCode).toBe(attempt < 5 ? 400 : 429);
    }
  });

  it('rejects an old-password login if credentials change during verification', async () => {
    f = await fixture();
    const before = f.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count;
    const pending = f.auth.login(credentials.username, credentials.password, {
      setCookie() {
        throw new Error('A stale login must not create a session');
      },
    } as unknown as FastifyReply);
    const result = expect(pending).rejects.toMatchObject({ statusCode: 401 });
    const salt = 'replacement-salt';
    const encoded = `${salt}:${scryptSync('replacement', salt, 64).toString('hex')}`;
    f.store.db
      .prepare('UPDATE users SET password=? WHERE username=?')
      .run(encoded, credentials.username);
    await result;
    expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count).toBe(before);
  });

  it('allows only one concurrent password change using the same session', async () => {
    f = await fixture();
    const responses = await Promise.all(
      ['first', 'second'].map((newPassword) =>
        f!.app.inject({
          method: 'POST',
          url: '/api/account/password',
          headers: f!.headers,
          payload: { currentPassword: credentials.password, newPassword },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    expect(f.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count).toBe(1);
  });
});
