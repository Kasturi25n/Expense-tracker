import { seedStarterData } from './seed.js';

const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#888888'
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    category_id INTEGER REFERENCES categories(id),
    amount REAL NOT NULL,
    description TEXT,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    category_id INTEGER REFERENCES categories(id),
    month TEXT NOT NULL,
    amount REAL NOT NULL
  );
`;

const PART1_SCHEMA = `
  ALTER TABLE categories ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense';

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    opening_balance REAL NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE recurring_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    to_account_id INTEGER REFERENCES accounts(id),
    category_id INTEGER REFERENCES categories(id),
    payee TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    frequency TEXT NOT NULL,
    anchor_day INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    next_date TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'auto',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    occurred_at TEXT NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    to_account_id INTEGER REFERENCES accounts(id),
    category_id INTEGER REFERENCES categories(id),
    payee TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    recurring_id INTEGER REFERENCES recurring_rules(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_transactions_user_time ON transactions(user_id, occurred_at);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    UNIQUE (user_id, name)
  );

  CREATE TABLE transaction_tags (
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (transaction_id, tag_id)
  );

  CREATE TABLE category_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    match_text TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function migrateToPart1(db) {
  db.exec(PART1_SCHEMA);
  const createCash = db.prepare("INSERT INTO accounts (user_id, name, type) VALUES (?, 'Cash', 'cash')");
  const copyExpenses = db.prepare(`
    INSERT INTO transactions (user_id, type, amount, occurred_at, account_id, category_id, note, created_at)
    SELECT user_id, 'expense', amount, date, ?, category_id, COALESCE(description, ''), created_at
    FROM expenses WHERE user_id = ? ORDER BY id`);
  for (const { user_id: userId } of db.prepare('SELECT DISTINCT user_id FROM expenses').all()) {
    const accountId = Number(createCash.run(userId).lastInsertRowid);
    copyExpenses.run(accountId, userId);
  }
  db.exec('DROP TABLE expenses');
}

// Index = version it upgrades from. Databases created before versioning report 0 and already
// have the legacy tables, which the IF NOT EXISTS schema leaves untouched.
function seedExistingUsers(db) {
  for (const { id } of db.prepare('SELECT id FROM users').all()) seedStarterData(db, id);
}

const MIGRATIONS = [(db) => db.exec(LEGACY_SCHEMA), migrateToPart1, seedExistingUsers];

export function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[version](db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
