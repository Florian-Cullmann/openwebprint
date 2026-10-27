import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
process.umask(0o077);
if (process.argv[2] !== '--confirm') {
  console.error(
    'Stop openwebprint first. Pass --confirm to remove all users and sessions. Documents and devices are preserved.',
  );
  process.exit(1);
}
const path = join(resolve(process.env.DATA_DIR ?? './data'), 'openwebprint.sqlite');
if (!existsSync(path)) {
  console.error('Database not found. Set DATA_DIR to the existing data directory.');
  process.exit(1);
}
const db = new DatabaseSync(path);
try {
  db.exec('BEGIN IMMEDIATE; DELETE FROM sessions;');
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get())
    db.exec('DELETE FROM users;');
  db.exec("DELETE FROM settings WHERE key IN ('username', 'password'); COMMIT;");
  console.log(
    'All users removed. Restart openwebprint to use it without signing in. Add a user in Settings to enable login.',
  );
} finally {
  db.close();
}
