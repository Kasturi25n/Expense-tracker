import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { migrate } from '../migrations.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

function legacyDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#888888');
    CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, category_id INTEGER, amount REAL NOT NULL, description TEXT, date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE budgets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, category_id INTEGER, month TEXT NOT NULL, amount REAL NOT NULL);
    INSERT INTO users (email, password_hash) VALUES ('a@x.com', 'h'), ('b@x.com', 'h');
    INSERT INTO categories (user_id, name) VALUES (1, 'Food');
    INSERT INTO expenses (user_id, category_id, amount, description, date) VALUES
      (1, 1, 250, 'Lunch', '2026-09-10'),
      (1, NULL, 99.5, 'Chai', '2026-09-11T08:15');
  `);
  return db;
}

describe('migrate', () => {
  it('moves legacy expenses into transactions in a new Cash account', () => {
    const db = legacyDb();
    migrate(db);

    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
    const accounts = db.prepare('SELECT user_id, name, type FROM accounts').all();
    expect(accounts).toEqual([{ user_id: 1, name: 'Cash', type: 'cash' }]);
    const cash = db.prepare('SELECT id FROM accounts').get().id;
    const rows = db.prepare('SELECT type, amount, occurred_at, category_id, payee, note, account_id FROM transactions ORDER BY id').all();
    expect(rows).toEqual([
      { type: 'expense', amount: 250, occurred_at: '2026-09-10', category_id: 1, payee: '', note: 'Lunch', account_id: cash },
      { type: 'expense', amount: 99.5, occurred_at: '2026-09-11T08:15', category_id: null, payee: '', note: 'Chai', account_id: cash },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'expenses'").get()).toBeFalsy();
    expect(db.prepare('SELECT kind FROM categories').get().kind).toBe('expense');
  });

  it('does nothing when run a second time', () => {
    const db = legacyDb();
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n).toBe(2);
  });

  it('builds the full schema on an empty database', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
    expect(tables).toEqual(['accounts', 'budgets', 'categories', 'category_rules', 'recurring_rules', 'tags', 'transaction_tags', 'transactions', 'users']);
  });
});
