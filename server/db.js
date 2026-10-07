import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { migrate } from './migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export function createDb(filename = path.join(__dirname, 'data.db')) {
  const db = new DatabaseSync(filename);
  migrate(db);
  return db;
}

export function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
