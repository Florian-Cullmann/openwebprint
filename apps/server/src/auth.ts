import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { AppError } from './errors.js';
const scrypt = promisify(scryptCallback);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Auth {
  readonly setupToken: string;
  private initializing = false;
  constructor(
    private store: Store,
    private config: Config,
  ) {
    this.setupToken = config.setupToken ?? randomBytes(24).toString('hex');
  }
  initialized() {
    return !!this.store.setting('password');
  }
  authenticated(req: FastifyRequest) {
    const token = req.cookies.owp_session;
    if (!token) return false;
    return !!this.store.db
      .prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?')
      .get(hash(token), Date.now());
  }
  async setup(token: string, username: string, password: string, reply: FastifyReply) {
    if (this.initialized() || this.initializing)
      throw new AppError(409, 'Die Einrichtung wurde bereits gestartet oder abgeschlossen.');
    const left = Buffer.from(hash(token));
    const right = Buffer.from(hash(this.setupToken));
    if (!timingSafeEqual(left, right))
      throw new AppError(403, 'Der Einrichtungsschlüssel ist ungültig.');
    this.initializing = true;
    try {
      const salt = randomBytes(16).toString('hex');
      const key = (await scrypt(password, salt, 64)) as Buffer;
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.set('username', username);
        this.store.set('password', `${salt}:${key.toString('hex')}`);
        this.store.db.exec('COMMIT');
      } catch (e) {
        this.store.db.exec('ROLLBACK');
        throw e;
      }
      this.session(reply);
    } finally {
      this.initializing = false;
    }
  }
  async login(username: string, password: string, reply: FastifyReply) {
    const saved = this.store.setting('password');
    const [salt, expected] = saved?.split(':') ?? ['openwebprint-dummy', '00'.repeat(64)];
    const key = (await scrypt(password, salt, 64)) as Buffer;
    if (
      !saved ||
      !timingSafeEqual(key, Buffer.from(expected, 'hex')) ||
      username !== this.store.setting('username')
    ) {
      throw new AppError(401, 'Benutzername oder Passwort ist falsch.');
    }
    this.session(reply);
  }
  private session(reply: FastifyReply) {
    const token = randomBytes(32).toString('hex');
    this.store.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    this.store.db
      .prepare('INSERT INTO sessions VALUES (?, ?)')
      .run(hash(token), Date.now() + 7 * 86400_000);
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
