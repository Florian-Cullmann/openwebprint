import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@openwebprint/shared';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { AppError } from './errors.js';
const scrypt = promisify(scryptCallback);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Auth {
  constructor(
    private store: Store,
    private config: Config,
  ) {}
  users(): User[] {
    return this.store.db
      .prepare('SELECT id, username, createdAt FROM users ORDER BY createdAt, id')
      .all() as unknown as User[];
  }
  hasUsers() {
    return Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM users').get()!.count) > 0;
  }
  user(req: FastifyRequest): User | undefined {
    const token = req.cookies.owp_session;
    if (!token) return;
    return this.store.db
      .prepare(
        'SELECT u.id, u.username, u.createdAt FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?',
      )
      .get(hash(token), Date.now()) as unknown as User | undefined;
  }
  authenticated(req: FastifyRequest) {
    return !!this.user(req);
  }
  async createUser(username: string, password: string, actor?: User): Promise<User> {
    const salt = randomBytes(16).toString('hex');
    const key = (await scrypt(password, salt, 64)) as Buffer;
    const user: User = { id: randomUUID(), username, createdAt: new Date().toISOString() };
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck after asynchronous hashing: only one anonymous first-user request can win.
      if (
        this.hasUsers() &&
        (!actor || !this.store.db.prepare('SELECT id FROM users WHERE id=?').get(actor.id))
      )
        throw new AppError(401, 'Sign in to manage users.');
      if (
        this.store.db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username)
      )
        throw new AppError(409, 'This username is already in use.');
      this.store.db
        .prepare('INSERT INTO users (id, username, password, createdAt) VALUES (?, ?, ?, ?)')
        .run(user.id, username, `${salt}:${key.toString('hex')}`, user.createdAt);
      this.store.db.exec('COMMIT');
      return user;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  deleteUser(id: string) {
    if (!this.store.db.prepare('DELETE FROM users WHERE id=?').run(id).changes)
      throw new AppError(404, 'User not found.');
  }
  async changePassword(
    req: FastifyRequest,
    reply: FastifyReply,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = this.user(req);
    if (!user) throw new AppError(401, 'Please sign in.');
    const saved = this.store.db.prepare('SELECT password FROM users WHERE id=?').get(user.id) as {
      password: string;
    };
    const [salt, expected] = saved.password.split(':');
    const key = (await scrypt(currentPassword, salt, 64)) as Buffer;
    const expectedKey = Buffer.from(expected, 'hex');
    if (expectedKey.length !== key.length || !timingSafeEqual(key, expectedKey))
      throw new AppError(400, 'Current password is incorrect.');
    const nextSalt = randomBytes(16).toString('hex');
    const nextKey = (await scrypt(newPassword, nextSalt, 64)) as Buffer;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck both credentials and session after asynchronous hashing.
      if (
        this.user(req)?.id !== user.id ||
        !this.store.db
          .prepare('UPDATE users SET password=? WHERE id=? AND password=?')
          .run(`${nextSalt}:${nextKey.toString('hex')}`, user.id, saved.password).changes
      )
        throw new AppError(401, 'Your session changed. Please sign in again.');
      this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      this.session(user.id, reply);
      this.store.db.exec('COMMIT');
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  async login(username: string, password: string, reply: FastifyReply) {
    const saved = this.store.db
      .prepare('SELECT id, password FROM users WHERE username=? COLLATE NOCASE')
      .get(username) as { id: string; password: string } | undefined;
    const [salt, expected] = saved?.password.split(':') ?? ['openwebprint-dummy', '00'.repeat(64)];
    const key = (await scrypt(password, salt, 64)) as Buffer;
    const expectedKey = Buffer.from(expected, 'hex');
    if (!saved || expectedKey.length !== key.length || !timingSafeEqual(key, expectedKey))
      throw new AppError(401, 'Incorrect username or password.');
    // The account or password may have changed while it was being checked.
    if (
      !this.store.db
        .prepare('SELECT id FROM users WHERE id=? AND password=?')
        .get(saved.id, saved.password)
    )
      throw new AppError(401, 'Incorrect username or password.');
    this.session(saved.id, reply);
  }
  private session(userId: string, reply: FastifyReply) {
    const token = randomBytes(32).toString('hex');
    this.store.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    this.store.db
      .prepare('INSERT INTO sessions (hash, expires, user_id) VALUES (?, ?, ?)')
      .run(hash(token), Date.now() + 7 * 86400_000, userId);
    reply.setCookie('owp_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.secureCookie,
      maxAge: 7 * 86400,
    });
  }
  logout(req: FastifyRequest, reply: FastifyReply) {
    if (req.cookies.owp_session)
      this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(req.cookies.owp_session));
    reply.clearCookie('owp_session', { path: '/' });
  }
}
