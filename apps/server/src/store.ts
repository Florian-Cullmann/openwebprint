import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Device, Job, Mode } from '@openwebprint/shared';

export interface StoredJob extends Job {
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
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, mode TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
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
  ...job
}: StoredJob): Job {
  return job;
}
