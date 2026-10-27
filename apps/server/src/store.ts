import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Device, Job, JobFilter, Mode, ScanPage } from '@openwebprint/shared';

export interface JobPageOptions {
  limit: number;
  kind?: Job['kind'];
  filter?: JobFilter;
  before?: { createdAt: string; id: string };
}

export interface StoredScanPage extends ScanPage {
  path: string;
  // Acquisition DPI belongs to this page, not the most recent job options.
  resolution?: number;
}
export interface StoredJob extends Job {
  scanPages?: StoredScanPage[];
  scanDirectory?: string;
  scanWorkPath?: string;
  externalId?: string;
  filePath?: string;
  previewPath?: string;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'openwebprint.sqlite'));
    chmodSync(join(directory, 'openwebprint.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, mode TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_history ON jobs (mode, created DESC, id DESC);
      CREATE INDEX IF NOT EXISTS jobs_kind_history ON jobs (mode, json_extract(data, '$.kind'), created DESC, id DESC);
      `);
    this.migrateUsers();
  }
  private migrateUsers() {
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 2) throw new Error('This database requires a newer version of openwebprint.');
    if (version === 2) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password TEXT NOT NULL, createdAt TEXT NOT NULL);`,
      );
      const legacyPassword = this.setting('password');
      if (legacyPassword) {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO users (id, username, password, createdAt) VALUES (?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            this.setting('username') ?? 'admin',
            legacyPassword,
            new Date().toISOString(),
          );
      }
      // Existing passwords are preserved. Legacy sessions cannot identify a user and expire here.
      this.db.exec(`DROP TABLE IF EXISTS sessions;
        CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
        DELETE FROM settings WHERE key IN ('username', 'password');
        PRAGMA user_version=2; COMMIT;`);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setting(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  set(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, value);
  }
  deleteSetting(key: string) {
    this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
  }
  devices(mode: Mode): Device[] {
    return this.db
      .prepare('SELECT data FROM devices WHERE mode=?')
      .all(mode)
      .map((r) => JSON.parse(String(r.data)));
  }
  device(id: string, mode: Mode): Device | undefined {
    return this.devices(mode).find((d) => d.id === id);
  }
  putDevice(device: Device) {
    this.db
      .prepare('INSERT OR REPLACE INTO devices VALUES (?, ?, ?)')
      .run(device.id, device.mode, JSON.stringify(device));
  }
  deleteDevice(id: string, mode: Mode) {
    this.db.prepare('DELETE FROM devices WHERE id=? AND mode=?').run(id, mode);
  }
  jobs(mode: Mode): StoredJob[] {
    return this.db
      .prepare('SELECT data FROM jobs WHERE mode=? ORDER BY created DESC')
      .all(mode)
      .map((r) => JSON.parse(String(r.data)));
  }
  private jobWhere(mode: Mode, { kind, filter }: Pick<JobPageOptions, 'kind' | 'filter'>) {
    const where = ['mode=?'];
    const params: (string | number)[] = [mode];
    if (kind) {
      where.push("json_extract(data, '$.kind')=?");
      params.push(kind);
    }
    if (filter === 'active')
      where.push("json_extract(data, '$.status') NOT IN ('completed', 'canceled', 'failed')");
    if (filter === 'completed') where.push("json_extract(data, '$.status')='completed'");
    return { where, params };
  }
  jobStats(mode: Mode, { before, ...options }: Omit<JobPageOptions, 'limit'>) {
    const { where, params } = this.jobWhere(mode, options);
    const position = before ? 'COUNT(*) FILTER (WHERE (created, id) >= (?, ?))' : '0';
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, ${position} AS offset FROM jobs WHERE ${where.join(' AND ')}`,
      )
      .get(...(before ? [before.createdAt, before.id, ...params] : params))!;
    return { total: Number(row.total), offset: Number(row.offset) };
  }
  jobPage(mode: Mode, { limit, kind, filter, before }: JobPageOptions): StoredJob[] {
    const { where, params } = this.jobWhere(mode, { kind, filter });
    if (before) {
      where.push('(created, id) < (?, ?)');
      params.push(before.createdAt, before.id);
    }
    return this.db
      .prepare(
        `SELECT data FROM jobs WHERE ${where.join(' AND ')} ORDER BY created DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((row) => JSON.parse(String(row.data)));
  }
  job(id: string, mode: Mode): StoredJob | undefined {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=? AND mode=?').get(id, mode);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  putJob(job: StoredJob) {
    this.db
      .prepare('INSERT OR REPLACE INTO jobs VALUES (?, ?, ?, ?)')
      .run(job.id, job.mode, job.createdAt, JSON.stringify(job));
  }
  deleteJob(id: string, mode: Mode) {
    this.db.prepare('DELETE FROM jobs WHERE id=? AND mode=?').run(id, mode);
  }
  close() {
    this.db.close();
  }
}
export function publicJob({
  externalId: _externalId,
  filePath: _filePath,
  previewPath: _previewPath,
  scanPages: _scanPages,
  scanDirectory: _scanDirectory,
  scanWorkPath: _scanWorkPath,
  ...job
}: StoredJob): Job {
  if (job.kind === 'scan' && job.hasFile) {
    job.pages = storedScanPages({ ...job, scanPages: _scanPages, previewPath: _previewPath }).map(
      ({ id, rotation, crop }) => ({ id, rotation, ...(crop ? { crop } : {}) }),
    );
    job.scanRevision ??= job.updatedAt;
  }
  return job;
}

export function storedScanPages(job: StoredJob): StoredScanPage[] {
  return (
    job.scanPages ??
    (job.hasFile && job.previewPath
      ? [{ id: job.id, rotation: 0 as const, path: job.previewPath }]
      : [])
  );
}
