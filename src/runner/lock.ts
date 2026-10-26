import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/protocol.js';

/** OS-backed SQLite locks disappear on process death; no stale PID deletion or PID-reuse guesswork. */
export class RunnerLock {
  private db?: DatabaseSync;
  constructor(directory: string) {
    const filename = path.join(directory, 'runner-lock.sqlite');
    const db = new DatabaseSync(filename);
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      if (process.platform !== 'win32') chmodSync(filename, 0o600);
      this.db = db;
    } catch {
      db.close();
      throw new AppError('runner_already_running', 'Another Runner or pairing process owns this stateDir. Stop it before starting another instance.');
    }
  }
  close() { if (this.db) { this.db.exec('ROLLBACK'); this.db.close(); this.db = undefined; } }
}
