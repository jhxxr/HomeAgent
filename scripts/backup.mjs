import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
const source = process.argv[2] ?? process.env.HOMEAGENT_DB ?? './data/server.sqlite';
const destination = process.argv[3];
if (!destination) throw new Error('Usage: node scripts/backup.mjs <source.sqlite> <backup.sqlite>');
await mkdir(path.dirname(path.resolve(destination)), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, destination); if (process.platform !== 'win32') await chmod(destination, 0o600); console.log('SQLite backup completed.'); }
finally { db.close(); }
