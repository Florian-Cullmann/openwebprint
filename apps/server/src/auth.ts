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
  async login(username: string, password: string, reply: FastifyReply) {
    const saved = this.store.db
      .prepare('SELECT id, password FROM users WHERE username=? COLLATE NOCASE')
      .get(username) as { id: string; password: string } | undefined;
    const [salt, expected] = saved?.password.split(':') ?? ['openwebprint-dummy', '00'.repeat(64)];
    const key = (await scrypt(password, salt, 64)) as Buffer;
    const expectedKey = Buffer.from(expected, 'hex');
    if (!saved || expectedKey.length !== key.length || !timingSafeEqual(key, expectedKey))
      throw new AppError(401, 'Incorrect username or password.');
    // The account may have been removed while the password was being checked.
    if (!this.store.db.prepare('SELECT id FROM users WHERE id=?').get(saved.id))
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
