import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
process.umask(0o077);
if (process.argv[2] !== '--confirm') {
  console.error(
    'Stop openwebprint first. Pass --confirm to clear admin credentials and sessions. Documents and devices are preserved.',
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
  db.exec(
    "BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM settings WHERE key IN ('username', 'password'); COMMIT;",
  );
  console.log('Administrator access reset. Restart openwebprint and use the new setup token.');
} finally {
  db.close();
}
