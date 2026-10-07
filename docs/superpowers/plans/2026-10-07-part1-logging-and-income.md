# Part 1 — Fast Logging & Money In/Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the expenses-only model with income/expense/transfer transactions across accounts, with auto-categorisation, tags, recurring items and a one-tap quick-add form.

**Architecture:** Express + `node:sqlite` backend gains a versioned migration (`PRAGMA user_version`), small shared validation helpers, two pure-ish services (`categorize`, `recurring`) and resource routers. Recurring items are materialised lazily by a middleware before reads. The React client gets one global Quick Add modal (opened from the nav) and new Transactions, Accounts and Recurring pages.

**Tech Stack:** Node ≥ 22.5 (`node:sqlite`), Express 4, bcryptjs, jsonwebtoken, vitest + supertest; React 19 + Vite, react-router-dom, recharts.

**Spec:** `docs/superpowers/specs/2026-10-07-part1-logging-and-income-design.md`

**Branch:** do all work on `part1-logging` (`git checkout -b part1-logging` from `main`).

## Global Constraints

- No new npm dependencies (server or client).
- ESM everywhere (`"type": "module"` on the server); `node:sqlite` is loaded via `createRequire` (Vitest cannot resolve it as an ESM import).
- Amounts are positive rupees (`REAL`), max `1_000_000_000`; direction comes from `type ∈ expense | income | transfer`.
- `occurred_at` is `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (local time as entered).
- Request bodies use camelCase (`accountId`); responses return DB rows (snake_case: `account_id`) — the existing convention.
- Every referenced `accountId`, `toAccountId`, `categoryId` must belong to the requesting user, else **400** `"… not found"`; a resource id in the URL owned by someone else is **404**.
- UI copy uses plain words; money is shown with `formatMoney` (₹, en-IN grouping).
- Never over-engineer: add no abstractions, options or files beyond those named in this plan.
- Server test command: `cd server && npx vitest run` (all suites). Client check: `cd client && npx vite build`.

## Review Focus

1. **Floating-point money** — sums like 0.1 + 0.2 must show as ₹0.30, not ₹0.30000000000000004, in balances, summaries and budgets. Pinned in Task 4 (balances) and Task 8 (summary).
2. **Special characters in payees/rule words** (`C++`, `(Amazon)`, `50%`) must not crash or mis-match the rule engine. Pinned in Task 3.
3. **Editing an old transaction on an archived account** must still work, while new transactions on that account are refused. Pinned in Task 5.
4. **Deleting a category** used by rules or recurring items must leave no dangling references. Pinned in Task 3 (rules) and Task 7 (recurring).
5. **Malformed JSON bodies** must get a 400 with a readable message, not a 500. Pinned in Task 1.

---

### Task 1: v2 schema migration and moving existing features onto `transactions`

**Files:**
- Create: `server/migrations.js`
- Modify: `server/db.js` (whole file)
- Modify: `server/app.js` (remove expenses router, JSON-error handling)
- Modify: `server/routes/budgets.js` (status query)
- Modify: `server/routes/export.js` (whole file)
- Modify: `server/routes/categories.js` (delete handler)
- Delete: `server/routes/expenses.js`, `server/tests/api.test.js`
- Create tests: `server/tests/helpers.js`, `server/tests/migrations.test.js`, `server/tests/auth.test.js`, `server/tests/categories.test.js`, `server/tests/budgets.test.js`, `server/tests/export.test.js`

**Interfaces:**
- Produces: `migrate(db)` (migrations.js); `createDb(filename)`, `inTransaction(db, fn) → fn's return` (db.js); test helpers `freshApp() → { app, db }`, `signup(app, email?, password?) → { token, userId }`, `client(app, token) → { get, post, put, del }`, `addTx(db, userId, fields) → id`, `catId(db, userId, name) → id`, `cashId(db, userId) → id`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/kasturi/Desktop/project1 && git checkout -b part1-logging
```

- [ ] **Step 2: Write the test helpers**

`server/tests/helpers.js`:

```js
import request from 'supertest';
import { createDb } from '../db.js';
import { createApp } from '../app.js';

export function freshApp() {
  const db = createDb(':memory:');
  return { app: createApp(db, 'test-secret'), db };
}

export async function signup(app, email = 'user@example.com', password = 'password123') {
  const res = await request(app).post('/api/auth/register').send({ email, password });
  return { token: res.body.token, userId: res.body.user.id };
}

export function client(app, token) {
  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  return {
    get: (url) => auth(request(app).get(url)),
    post: (url, body) => auth(request(app).post(url)).send(body),
    put: (url, body) => auth(request(app).put(url)).send(body),
    del: (url) => auth(request(app).delete(url)),
  };
}

// Test fixture: inserts a transaction directly, creating a Cash account if the user has none.
export function addTx(db, userId, { type = 'expense', amount, occurredAt = '2026-09-15T10:00', accountId, toAccountId = null, categoryId = null, payee = '', note = '' }) {
  let account = accountId;
  if (!account) {
    const existing = db.prepare('SELECT id FROM accounts WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
    account = existing
      ? existing.id
      : Number(db.prepare("INSERT INTO accounts (user_id, name, type) VALUES (?, 'Cash', 'cash')").run(userId).lastInsertRowid);
  }
  const info = db
    .prepare(
      `INSERT INTO transactions (user_id, type, amount, occurred_at, account_id, to_account_id, category_id, payee, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, type, amount, occurredAt, account, toAccountId, categoryId, payee, note);
  return Number(info.lastInsertRowid);
}

export const catId = (db, userId, name) =>
  db.prepare('SELECT id FROM categories WHERE user_id = ? AND name = ?').get(userId, name).id;

export const cashId = (db, userId) =>
  db.prepare("SELECT id FROM accounts WHERE user_id = ? AND name = 'Cash'").get(userId).id;
```

- [ ] **Step 3: Write the migration tests**

`server/tests/migrations.test.js`:

```js
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
```

- [ ] **Step 4: Port the existing auth, category, budget and export tests to the new helpers**

`server/tests/auth.test.js`:

```js
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { freshApp } from './helpers.js';

const creds = { email: 'a@b.com', password: 'password123' };

describe('auth', () => {
  it('registers a new user and returns a token', async () => {
    const { app } = freshApp();
    const res = await request(app).post('/api/auth/register').send(creds);
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe('a@b.com');
  });

  it('rejects duplicate email registration', async () => {
    const { app } = freshApp();
    await request(app).post('/api/auth/register').send(creds);
    expect((await request(app).post('/api/auth/register').send(creds)).status).toBe(409);
  });

  it('logs in with correct credentials and rejects a wrong password', async () => {
    const { app } = freshApp();
    await request(app).post('/api/auth/register').send(creds);
    const ok = await request(app).post('/api/auth/login').send(creds);
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect((await request(app).post('/api/auth/login').send({ ...creds, password: 'wrong' })).status).toBe(401);
  });

  it('rejects protected routes without a token', async () => {
    const { app } = freshApp();
    expect((await request(app).get('/api/categories')).status).toBe(401);
  });

  it('answers malformed JSON with 400, not a crash', async () => {
    const { app } = freshApp();
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid JSON/);
  });
});
```

`server/tests/categories.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, addTx } from './helpers.js';

describe('categories', () => {
  let app, db, userId, api;
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
  });

  it('creates and lists categories', async () => {
    expect((await api.post('/api/categories', { name: 'Pets', color: '#ff0000' })).status).toBe(201);
    expect((await api.get('/api/categories')).body.map((c) => c.name)).toContain('Pets');
  });

  it('renames a category', async () => {
    const { id } = (await api.post('/api/categories', { name: 'Pets' })).body;
    const res = await api.put(`/api/categories/${id}`, { name: 'Pet care', color: '#00ff00' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Pet care');
  });

  it('deletes a category and leaves its transactions uncategorised', async () => {
    const { id } = (await api.post('/api/categories', { name: 'Pets' })).body;
    const txId = addTx(db, userId, { amount: 10, categoryId: id });
    expect((await api.del(`/api/categories/${id}`)).status).toBe(204);
    expect((await api.get('/api/categories')).body.map((c) => c.id)).not.toContain(id);
    expect(db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(txId).category_id).toBeNull();
  });

  it("does not show one user's categories to another", async () => {
    await api.post('/api/categories', { name: 'Pets' });
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.get('/api/categories')).body.map((c) => c.name)).not.toContain('Pets');
  });
});
```

`server/tests/budgets.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, addTx } from './helpers.js';

describe('budgets', () => {
  let app, db, userId, api;
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
  });

  it('reports over-budget using expense transactions only', async () => {
    const food = (await api.post('/api/categories', { name: 'Food' })).body.id;
    await api.post('/api/budgets', { categoryId: food, month: '2026-09', amount: 50 });
    await api.post('/api/budgets', { month: '2026-09', amount: 100 });
    addTx(db, userId, { amount: 60, occurredAt: '2026-09-05T12:00', categoryId: food });
    addTx(db, userId, { amount: 0.1, occurredAt: '2026-09-06', categoryId: food });
    addTx(db, userId, { amount: 0.2, occurredAt: '2026-09-06', categoryId: food });
    addTx(db, userId, { type: 'income', amount: 500, occurredAt: '2026-09-06T12:00' });
    const second = Number(db.prepare("INSERT INTO accounts (user_id, name, type) VALUES (?, 'Bank', 'bank')").run(userId).lastInsertRowid);
    addTx(db, userId, { type: 'transfer', amount: 400, occurredAt: '2026-09-07T12:00', toAccountId: second });

    const status = (await api.get('/api/budgets/status/2026-09')).body;
    expect(status.find((b) => b.category_id === food)).toMatchObject({ spent: 60.3, overBudget: true });
    expect(status.find((b) => b.category_id === null)).toMatchObject({ spent: 60.3, overBudget: false });
  });

  it('rejects an invalid month format', async () => {
    expect((await api.post('/api/budgets', { month: 'not-a-month', amount: 50 })).status).toBe(400);
  });
});
```

`server/tests/export.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { freshApp, signup, client, addTx } from './helpers.js';

describe('csv export', () => {
  it('exports transactions with account, category, tags and spreadsheet-safe text', async () => {
    const { app, db } = freshApp();
    const { token, userId } = await signup(app);
    const api = client(app, token);
    const food = (await api.post('/api/categories', { name: 'Food' })).body.id;
    const txId = addTx(db, userId, { amount: 15, occurredAt: '2026-09-10T09:30', categoryId: food, payee: 'Chai, Point', note: '=HYPERLINK("x")' });
    db.prepare("INSERT INTO tags (user_id, name) VALUES (?, 'office')").run(userId);
    db.prepare("INSERT INTO transaction_tags (transaction_id, tag_id) SELECT ?, id FROM tags WHERE name = 'office'").run(txId);

    const res = await api.get('/api/export/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('occurred_at,type,amount,account,to_account,category,payee,note,tags');
    expect(lines[1]).toBe(`2026-09-10T09:30,expense,15,Cash,,Food,"Chai, Point","'=HYPERLINK(""x"")",office`);
  });
});
```

Delete the old suite: `rm server/tests/api.test.js`.

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd server && npx vitest run`
Expected: FAIL — `migrations.test.js` cannot import `../migrations.js`; other suites fail with `no such table: accounts` / `transactions`.

- [ ] **Step 6: Write the migrations**

`server/migrations.js`:

```js
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
const MIGRATIONS = [(db) => db.exec(LEGACY_SCHEMA), migrateToPart1];

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
```

`server/db.js` (replace whole file):

```js
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
```

- [ ] **Step 7: Point existing routes at `transactions`**

Delete `server/routes/expenses.js`. In `server/app.js` remove the line `import { createExpensesRouter } from './routes/expenses.js';` and the line `app.use('/api/expenses', requireAuth, createExpensesRouter(db));`, and replace the error handler with:

```js
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
```

In `server/routes/categories.js`, in the delete handler, replace
`db.prepare('UPDATE expenses SET category_id = NULL WHERE category_id = ?').run(req.params.id);`
with
`db.prepare('UPDATE transactions SET category_id = NULL WHERE category_id = ?').run(req.params.id);`

In `server/routes/budgets.js`, inside the `/status/:month` handler, replace the `spendByCategory` query and the `results` mapping with:

```js
    const spendByCategory = db
      .prepare(
        `SELECT category_id, SUM(amount) AS total FROM transactions
         WHERE user_id = ? AND type = 'expense' AND occurred_at LIKE ? GROUP BY category_id`
      )
      .all(req.userId, `${month}%`);
    const spendMap = new Map(spendByCategory.map((r) => [r.category_id, r.total]));
    const overallSpend = spendByCategory.reduce((sum, r) => sum + r.total, 0);
    const round = (n) => Math.round(n * 100) / 100;

    const results = budgets.map((b) => {
      const spent = round(b.category_id === null ? overallSpend : spendMap.get(b.category_id) || 0);
      return { ...b, spent, overBudget: spent > b.amount };
    });
```

(and delete the following `results.forEach(...)` block that set `overBudget`).

`server/routes/export.js` (replace whole file):

```js
import { Router } from 'express';

const COLUMNS = ['occurred_at', 'type', 'amount', 'account', 'to_account', 'category', 'payee', 'note', 'tags'];

function csvEscape(value) {
  let str = String(value ?? '');
  // Stop spreadsheets from running text that starts like a formula.
  if (/^[=+\-@]/.test(str)) str = `'${str}`;
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function createExportRouter(db) {
  const router = Router();

  router.get('/csv', (req, res) => {
    const rows = db
      .prepare(
        `SELECT t.occurred_at, t.type, t.amount, a.name AS account, ta.name AS to_account,
                c.name AS category, t.payee, t.note,
                (SELECT group_concat(g.name, ';') FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
                 WHERE tt.transaction_id = t.id) AS tags
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN accounts ta ON ta.id = t.to_account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = ?
         ORDER BY t.occurred_at DESC, t.id DESC`
      )
      .all(req.userId);

    const lines = rows.map((r) => COLUMNS.map((col) => csvEscape(r[col])).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send([COLUMNS.join(','), ...lines].join('\n'));
  });

  return router;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && npx vitest run`
Expected: PASS — 6 files, 15 tests.

- [ ] **Step 9: Commit**

```bash
git add -A server
git commit -m "$(printf 'Migrate expenses to transactions with versioned schema\n\nKasturi25n')"
```

---

### Task 2: Starter data for new users and category kinds

**Files:**
- Create: `server/seed.js`
- Modify: `server/routes/auth.js` (register handler)
- Modify: `server/routes/categories.js` (replace whole file)
- Test: `server/tests/auth.test.js`, `server/tests/categories.test.js`

**Interfaces:**
- Consumes: `inTransaction(db, fn)` from `server/db.js`.
- Produces: `seedNewUser(db, userId)`; categories responses now include `kind` (`'expense' | 'income'`); `POST /api/categories` accepts `kind` (default `'expense'`).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('auth', …)` block of `server/tests/auth.test.js` (add `signup, client` to the helpers import):

```js
  it('gives a new user a Cash account, starter categories and merchant rules', async () => {
    const { app, db } = freshApp();
    const { token, userId } = await signup(app);
    const cats = (await client(app, token).get('/api/categories')).body;
    expect(cats.find((c) => c.name === 'Food & Dining')).toMatchObject({ kind: 'expense' });
    expect(cats.find((c) => c.name === 'Salary')).toMatchObject({ kind: 'income' });
    expect(cats).toHaveLength(17);
    expect(db.prepare('SELECT name, type FROM accounts WHERE user_id = ?').all(userId)).toEqual([{ name: 'Cash', type: 'cash' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM category_rules WHERE user_id = ?').get(userId).n).toBe(26);
  });
```

Append inside `describe('categories', …)` of `server/tests/categories.test.js`:

```js
  it('creates income categories and reports each kind', async () => {
    const res = await api.post('/api/categories', { name: 'Rental income', kind: 'income' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Rental income', kind: 'income' });
    expect((await api.post('/api/categories', { name: 'Pets' })).body.kind).toBe('expense');
  });

  it('rejects an unknown kind', async () => {
    expect((await api.post('/api/categories', { name: 'X', kind: 'savings' })).status).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/auth.test.js tests/categories.test.js`
Expected: FAIL — `Food & Dining` not found; `kind` undefined in responses.

- [ ] **Step 3: Write the seed**

`server/seed.js`:

```js
const EXPENSE_CATEGORIES = [
  ['Food & Dining', '#f97316'],
  ['Groceries', '#84cc16'],
  ['Transport', '#0ea5e9'],
  ['Shopping', '#ec4899'],
  ['Bills & Utilities', '#eab308'],
  ['Rent', '#8b5cf6'],
  ['Entertainment', '#f43f5e'],
  ['Health', '#14b8a6'],
  ['Education', '#6366f1'],
  ['Travel', '#06b6d4'],
  ['Personal Care', '#d946ef'],
  ['Other', '#94a3b8'],
];

const INCOME_CATEGORIES = [
  ['Salary', '#16a34a'],
  ['Freelance', '#22c55e'],
  ['Interest', '#4ade80'],
  ['Refunds', '#65a30d'],
  ['Other Income', '#15803d'],
];

const STARTER_RULES = {
  'Food & Dining': ['swiggy', 'zomato'],
  Groceries: ['blinkit', 'zepto', 'bigbasket', 'instamart'],
  Transport: ['uber', 'ola', 'rapido', 'irctc'],
  Shopping: ['amazon', 'flipkart', 'myntra', 'ajio'],
  Entertainment: ['netflix', 'hotstar', 'spotify', 'prime video', 'bookmyshow'],
  'Bills & Utilities': ['airtel', 'jio', 'bescom', 'electricity'],
  Health: ['apollo', 'pharmeasy', '1mg'],
};

export function seedNewUser(db, userId) {
  db.prepare("INSERT INTO accounts (user_id, name, type) VALUES (?, 'Cash', 'cash')").run(userId);

  const insertCategory = db.prepare('INSERT INTO categories (user_id, name, color, kind) VALUES (?, ?, ?, ?)');
  const ids = {};
  for (const [name, color] of EXPENSE_CATEGORIES) {
    ids[name] = Number(insertCategory.run(userId, name, color, 'expense').lastInsertRowid);
  }
  for (const [name, color] of INCOME_CATEGORIES) {
    insertCategory.run(userId, name, color, 'income');
  }

  const insertRule = db.prepare('INSERT INTO category_rules (user_id, match_text, category_id) VALUES (?, ?, ?)');
  for (const [category, words] of Object.entries(STARTER_RULES)) {
    for (const word of words) insertRule.run(userId, word, ids[category]);
  }
}
```

- [ ] **Step 4: Seed on register**

In `server/routes/auth.js` add imports:

```js
import { inTransaction } from '../db.js';
import { seedNewUser } from '../seed.js';
```

and replace

```js
    const info = db
      .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run(email, passwordHash);

    const userId = Number(info.lastInsertRowid);
```

with

```js
    const userId = inTransaction(db, () => {
      const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, passwordHash);
      const id = Number(info.lastInsertRowid);
      seedNewUser(db, id);
      return id;
    });
```

- [ ] **Step 5: Add category kinds**

`server/routes/categories.js` (replace whole file):

```js
import { Router } from 'express';
import { inTransaction } from '../db.js';

const KINDS = ['expense', 'income'];

export function createCategoriesRouter(db) {
  const router = Router();
  const getOne = (userId, id) =>
    db.prepare('SELECT id, name, color, kind FROM categories WHERE id = ? AND user_id = ?').get(id, userId);

  router.get('/', (req, res) => {
    res.json(db.prepare('SELECT id, name, color, kind FROM categories WHERE user_id = ? ORDER BY kind, name').all(req.userId));
  });

  router.post('/', (req, res) => {
    const { name, color } = req.body ?? {};
    const kind = req.body?.kind ?? 'expense';
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required' });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Kind must be expense or income' });
    const info = db
      .prepare('INSERT INTO categories (user_id, name, color, kind) VALUES (?, ?, ?, ?)')
      .run(req.userId, String(name).trim(), color || '#888888', kind);
    res.status(201).json(getOne(req.userId, Number(info.lastInsertRowid)));
  });

  router.put('/:id', (req, res) => {
    if (!getOne(req.userId, req.params.id)) return res.status(404).json({ error: 'Category not found' });
    const { name, color } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required' });
    db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(String(name).trim(), color || '#888888', req.params.id);
    res.json(getOne(req.userId, req.params.id));
  });

  router.delete('/:id', (req, res) => {
    if (!getOne(req.userId, req.params.id)) return res.status(404).json({ error: 'Category not found' });
    inTransaction(db, () => {
      db.prepare('UPDATE transactions SET category_id = NULL WHERE category_id = ?').run(req.params.id);
      db.prepare('DELETE FROM budgets WHERE category_id = ?').run(req.params.id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    });
    res.status(204).end();
  });

  return router;
}
```

(Kind is fixed after creation: existing transactions depend on it.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run`
Expected: PASS — all suites (18 tests).

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "$(printf 'Seed new users with Cash account, categories and merchant rules\n\nKasturi25n')"
```

---

### Task 3: Validation helpers, auto-categorisation and rules API

**Files:**
- Create: `server/validate.js`, `server/services/categorize.js`, `server/routes/rules.js`
- Modify: `server/app.js` (mount rules, ValidationError → 400)
- Modify: `server/routes/categories.js` (delete also removes rules)
- Test: `server/tests/categorize.test.js`, `server/tests/rules.test.js`

**Interfaces:**
- Consumes: `seedNewUser` data (Task 2), test helpers (Task 1).
- Produces (validate.js): `class ValidationError extends Error`; `TX_TYPES`; `requireAmount(n)`; `requireDateTime(s)`; `requireDate(s, label='Date')`; `requireOneOf(value, options, label)`; `ownedAccount(db, userId, id, label='Account', allowArchivedIds=[]) → row`; `ownedCategory(db, userId, id, txType?) → row`; `validateMovement(db, userId, body, allowArchivedIds=[]) → { type, amount, accountId, toAccountId, categoryId, payee, note }` (categoryId is `null` when not given; transfers always `null`).
- Produces (categorize.js): `matchesWord(text, phrase) → boolean`; `suggestCategory(db, userId, { payee, note, type }) → categoryId | null`.
- Produces (API): `GET /api/rules` → rows `{ id, match_text, category_id, category_name }`; `POST /api/rules { matchText, categoryId }` → 201 new row / 200 when the word already existed; `DELETE /api/rules/:id` → 204.

- [ ] **Step 1: Write the failing tests**

`server/tests/categorize.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, catId, addTx } from './helpers.js';
import { suggestCategory, matchesWord } from '../services/categorize.js';

describe('matchesWord', () => {
  it('matches whole words only, ignoring case', () => {
    expect(matchesWord('UPI/OLA CABS/8812', 'ola')).toBe(true);
    expect(matchesWord('Motorola Store', 'ola')).toBe(false);
  });

  it('treats special characters in the word literally', () => {
    expect(matchesWord('C++ Books (Amazon)', 'c++')).toBe(true);
    expect(matchesWord('C++ Books (Amazon)', 'amazon')).toBe(true);
    expect(matchesWord('50% off sale', '50%')).toBe(true);
  });
});

describe('suggestCategory', () => {
  let db, userId;
  const id = (name) => catId(db, userId, name);
  beforeEach(async () => {
    const env = freshApp();
    db = env.db;
    ({ userId } = await signup(env.app));
  });

  it('uses the starter merchant rules', () => {
    expect(suggestCategory(db, userId, { payee: 'Swiggy', type: 'expense' })).toBe(id('Food & Dining'));
  });

  it('prefers the longest matching word', () => {
    expect(suggestCategory(db, userId, { payee: 'Swiggy Instamart', type: 'expense' })).toBe(id('Groceries'));
  });

  it('falls back to the note when the payee does not match', () => {
    expect(suggestCategory(db, userId, { payee: 'Ramesh', note: 'uber to airport', type: 'expense' })).toBe(id('Transport'));
  });

  it('only suggests categories of the right kind', () => {
    expect(suggestCategory(db, userId, { payee: 'Amazon', type: 'income' })).toBeNull();
  });

  it('learns from payee history when no rule matches', () => {
    addTx(db, userId, { payee: 'Sharma Kirana', amount: 300, categoryId: id('Groceries') });
    expect(suggestCategory(db, userId, { payee: 'sharma kirana', type: 'expense' })).toBe(id('Groceries'));
  });

  it('lets rules win over history', () => {
    addTx(db, userId, { payee: 'Swiggy', amount: 300, categoryId: id('Shopping') });
    expect(suggestCategory(db, userId, { payee: 'Swiggy', type: 'expense' })).toBe(id('Food & Dining'));
  });

  it('returns null for transfers and unknown payees', () => {
    expect(suggestCategory(db, userId, { payee: 'Swiggy', type: 'transfer' })).toBeNull();
    expect(suggestCategory(db, userId, { payee: 'Someone new', type: 'expense' })).toBeNull();
  });
});
```

`server/tests/rules.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, catId } from './helpers.js';

describe('rules API', () => {
  let app, db, userId, api;
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
  });

  it('lists starter rules with category names', async () => {
    const res = await api.get('/api/rules');
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual(expect.objectContaining({ match_text: 'swiggy', category_name: 'Food & Dining' }));
  });

  it('adds a rule, trimming and lower-casing the word', async () => {
    const res = await api.post('/api/rules', { matchText: '  Chaayos ', categoryId: catId(db, userId, 'Food & Dining') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ match_text: 'chaayos', category_name: 'Food & Dining' });
  });

  it('re-points an existing word instead of duplicating it', async () => {
    const res = await api.post('/api/rules', { matchText: 'Swiggy', categoryId: catId(db, userId, 'Groceries') });
    expect(res.status).toBe(200);
    const swiggy = (await api.get('/api/rules')).body.filter((r) => r.match_text === 'swiggy');
    expect(swiggy).toHaveLength(1);
    expect(swiggy[0].category_name).toBe('Groceries');
  });

  it("rejects empty words and other users' categories", async () => {
    expect((await api.post('/api/rules', { matchText: ' ', categoryId: catId(db, userId, 'Groceries') })).status).toBe(400);
    const other = await signup(app, 'other@example.com');
    expect((await api.post('/api/rules', { matchText: 'x', categoryId: catId(db, other.userId, 'Groceries') })).status).toBe(400);
  });

  it('deletes only your own rules', async () => {
    const rule = (await api.get('/api/rules')).body[0];
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.del(`/api/rules/${rule.id}`)).status).toBe(404);
    expect((await api.del(`/api/rules/${rule.id}`)).status).toBe(204);
  });

  it("removes a category's rules when the category is deleted", async () => {
    const food = catId(db, userId, 'Food & Dining');
    expect((await api.del(`/api/categories/${food}`)).status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM category_rules WHERE category_id = ?').get(food).n).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/categorize.test.js tests/rules.test.js`
Expected: FAIL — cannot import `../services/categorize.js`; `/api/rules` returns 404.

- [ ] **Step 3: Write the validation helpers**

`server/validate.js`:

```js
export class ValidationError extends Error {}

export const TX_TYPES = ['expense', 'income', 'transfer'];
const MAX_AMOUNT = 1_000_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

export function requireAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new ValidationError('Amount must be a number greater than 0');
  }
}

export function requireDateTime(value) {
  if (typeof value !== 'string' || !DATE_TIME_RE.test(value)) {
    throw new ValidationError('Date must look like 2026-10-05 or 2026-10-05T13:30');
  }
}

export function requireDate(value, label = 'Date') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ValidationError(`${label} must look like 2026-10-05`);
  }
}

export function requireOneOf(value, options, label) {
  if (!options.includes(value)) throw new ValidationError(`${label} must be one of: ${options.join(', ')}`);
}

export function ownedAccount(db, userId, id, label = 'Account', allowArchivedIds = []) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(id ?? null, userId);
  if (!row) throw new ValidationError(`${label} not found`);
  if (row.archived && !allowArchivedIds.includes(row.id)) throw new ValidationError(`${label} "${row.name}" is archived`);
  return row;
}

export function ownedCategory(db, userId, id, txType) {
  const row = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id ?? null, userId);
  if (!row) throw new ValidationError('Category not found');
  if (txType && row.kind !== txType) {
    throw new ValidationError(`Category "${row.name}" is for ${row.kind}, not ${txType}`);
  }
  return row;
}

// Shared by transactions and recurring rules: the "who paid whom from where" part of a money movement.
export function validateMovement(db, userId, body, allowArchivedIds = []) {
  const { type, amount, accountId, toAccountId, categoryId, payee = '', note = '' } = body ?? {};
  requireOneOf(type, TX_TYPES, 'Type');
  requireAmount(amount);
  ownedAccount(db, userId, accountId, 'Account', allowArchivedIds);

  let to = null;
  let category = null;
  if (type === 'transfer') {
    ownedAccount(db, userId, toAccountId, 'Destination account', allowArchivedIds);
    if (Number(toAccountId) === Number(accountId)) throw new ValidationError('Choose two different accounts for a transfer');
    to = toAccountId;
  } else if (categoryId !== undefined && categoryId !== null) {
    ownedCategory(db, userId, categoryId, type);
    category = categoryId;
  }

  return { type, amount, accountId, toAccountId: to, categoryId: category, payee: String(payee).trim(), note: String(note).trim() };
}
```

- [ ] **Step 4: Write the categoriser**

`server/services/categorize.js`:

```js
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchesWord(text, phrase) {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase.toLowerCase())}($|[^a-z0-9])`);
  return pattern.test(text.toLowerCase());
}

export function suggestCategory(db, userId, { payee = '', note = '', type }) {
  if (type === 'transfer') return null;

  const rules = db
    .prepare(
      `SELECT r.match_text, r.category_id FROM category_rules r
       JOIN categories c ON c.id = r.category_id
       WHERE r.user_id = ? AND c.kind = ?`
    )
    .all(userId, type);
  for (const text of [payee, note]) {
    if (!text) continue;
    const hits = rules.filter((r) => matchesWord(text, r.match_text));
    if (hits.length) return hits.sort((a, b) => b.match_text.length - a.match_text.length)[0].category_id;
  }

  if (!payee) return null;
  const last = db
    .prepare(
      `SELECT t.category_id FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = ? AND lower(t.payee) = lower(?) AND c.kind = ?
       ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1`
    )
    .get(userId, payee, type);
  return last ? last.category_id : null;
}
```

- [ ] **Step 5: Write the rules router and wire it up**

`server/routes/rules.js`:

```js
import { Router } from 'express';
import { ValidationError, ownedCategory } from '../validate.js';

const SELECT_RULE = `SELECT r.id, r.match_text, r.category_id, c.name AS category_name
  FROM category_rules r JOIN categories c ON c.id = r.category_id`;

export function createRulesRouter(db) {
  const router = Router();
  const getOne = (id) => db.prepare(`${SELECT_RULE} WHERE r.id = ?`).get(id);

  router.get('/', (req, res) => {
    res.json(db.prepare(`${SELECT_RULE} WHERE r.user_id = ? ORDER BY c.name, r.match_text`).all(req.userId));
  });

  router.post('/', (req, res) => {
    const matchText = String(req.body?.matchText ?? '').trim().toLowerCase();
    if (!matchText) throw new ValidationError('Enter the word to match, e.g. "swiggy"');
    ownedCategory(db, req.userId, req.body.categoryId);

    const existing = db.prepare('SELECT id FROM category_rules WHERE user_id = ? AND match_text = ?').get(req.userId, matchText);
    if (existing) {
      db.prepare('UPDATE category_rules SET category_id = ? WHERE id = ?').run(req.body.categoryId, existing.id);
      return res.json(getOne(existing.id));
    }
    const info = db
      .prepare('INSERT INTO category_rules (user_id, match_text, category_id) VALUES (?, ?, ?)')
      .run(req.userId, matchText, req.body.categoryId);
    res.status(201).json(getOne(Number(info.lastInsertRowid)));
  });

  router.delete('/:id', (req, res) => {
    const rule = db.prepare('SELECT id FROM category_rules WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    db.prepare('DELETE FROM category_rules WHERE id = ?').run(rule.id);
    res.status(204).end();
  });

  return router;
}
```

In `server/app.js` add imports:

```js
import { ValidationError } from './validate.js';
import { createRulesRouter } from './routes/rules.js';
```

mount after categories: `app.use('/api/rules', requireAuth, createRulesRouter(db));`

and add as the first line inside the error handler:

```js
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
```

In `server/routes/categories.js` delete handler, add inside `inTransaction` before deleting the category:

```js
      db.prepare('DELETE FROM category_rules WHERE category_id = ?').run(req.params.id);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run`
Expected: PASS — all suites (33 tests).

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "$(printf 'Add auto-categorisation rules with whole-word matching\n\nKasturi25n')"
```

---

### Task 4: Accounts with running balances

**Files:**
- Create: `server/routes/accounts.js`
- Modify: `server/app.js` (mount)
- Test: `server/tests/accounts.test.js`

**Interfaces:**
- Consumes: `ValidationError`, `requireOneOf` (Task 3).
- Produces: `ACCOUNT_TYPES = ['cash','bank','credit_card','wallet']`; `accountBalances(db, userId) → [{ id, name, type, opening_balance, archived, balance }]` (balance rounded to 2 dp, archived last); API `GET/POST/PUT/DELETE /api/accounts` with body `{ name, type, openingBalance, archived }`; DELETE → 409 when the account is referenced.

- [ ] **Step 1: Write the failing tests**

`server/tests/accounts.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, addTx } from './helpers.js';

describe('accounts', () => {
  let app, db, userId, api;
  const byName = async (name) => (await api.get('/api/accounts')).body.find((a) => a.name === name);
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
  });

  it('starts with a Cash account at zero', async () => {
    expect(await byName('Cash')).toMatchObject({ type: 'cash', balance: 0, archived: 0 });
  });

  it('creates an account with an opening balance', async () => {
    const res = await api.post('/api/accounts', { name: 'HDFC', type: 'bank', openingBalance: 10000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'HDFC', type: 'bank', balance: 10000 });
  });

  it('computes balances from income, expenses and transfers', async () => {
    const hdfc = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank', openingBalance: 10000 })).body.id;
    const cash = (await byName('Cash')).id;
    addTx(db, userId, { type: 'income', amount: 50000, accountId: hdfc });
    addTx(db, userId, { type: 'expense', amount: 1200, accountId: hdfc });
    addTx(db, userId, { type: 'transfer', amount: 5000, accountId: hdfc, toAccountId: cash });
    expect((await byName('HDFC')).balance).toBe(53800);
    expect((await byName('Cash')).balance).toBe(5000);
  });

  it('rounds balances to paise', async () => {
    const wallet = (await api.post('/api/accounts', { name: 'Paytm', type: 'wallet', openingBalance: 100 })).body.id;
    addTx(db, userId, { amount: 0.1, accountId: wallet });
    addTx(db, userId, { amount: 0.2, accountId: wallet });
    expect((await byName('Paytm')).balance).toBe(99.7);
  });

  it('allows a negative opening balance for a credit card', async () => {
    const res = await api.post('/api/accounts', { name: 'ICICI Card', type: 'credit_card', openingBalance: -12000 });
    expect(res.body.balance).toBe(-12000);
  });

  it('validates name, type and opening balance', async () => {
    expect((await api.post('/api/accounts', { name: '', type: 'bank' })).status).toBe(400);
    expect((await api.post('/api/accounts', { name: 'X', type: 'savings' })).status).toBe(400);
    expect((await api.post('/api/accounts', { name: 'X', type: 'bank', openingBalance: 'lots' })).status).toBe(400);
  });

  it('renames and archives, keeping the account listed', async () => {
    const cash = await byName('Cash');
    const res = await api.put(`/api/accounts/${cash.id}`, { name: 'Wallet cash', type: 'cash', openingBalance: 0, archived: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Wallet cash', archived: 1 });
  });

  it('refuses to delete an account with transactions, but deletes an unused one', async () => {
    const cash = await byName('Cash');
    addTx(db, userId, { amount: 10, accountId: cash.id });
    const del = await api.del(`/api/accounts/${cash.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/Archive/);
    const spare = (await api.post('/api/accounts', { name: 'Spare', type: 'wallet' })).body.id;
    expect((await api.del(`/api/accounts/${spare}`)).status).toBe(204);
  });

  it('keeps accounts private to their owner', async () => {
    const cash = await byName('Cash');
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.get('/api/accounts')).body.map((a) => a.id)).not.toContain(cash.id);
    expect((await other.put(`/api/accounts/${cash.id}`, { name: 'Mine', type: 'cash' })).status).toBe(404);
    expect((await other.del(`/api/accounts/${cash.id}`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/accounts.test.js`
Expected: FAIL — `/api/accounts` returns 404.

- [ ] **Step 3: Write the accounts router**

`server/routes/accounts.js`:

```js
import { Router } from 'express';
import { ValidationError, requireOneOf } from '../validate.js';

export const ACCOUNT_TYPES = ['cash', 'bank', 'credit_card', 'wallet'];

export function accountBalances(db, userId) {
  return db
    .prepare(
      `SELECT a.id, a.name, a.type, a.opening_balance, a.archived,
         ROUND(a.opening_balance
           + COALESCE((SELECT SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE -t.amount END)
                       FROM transactions t WHERE t.account_id = a.id), 0)
           + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.to_account_id = a.id), 0), 2) AS balance
       FROM accounts a WHERE a.user_id = ? ORDER BY a.archived, a.id`
    )
    .all(userId);
}

function parseAccount(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new ValidationError('Account name is required');
  requireOneOf(body.type, ACCOUNT_TYPES, 'Account type');
  const openingBalance = body.openingBalance ?? 0;
  if (typeof openingBalance !== 'number' || !Number.isFinite(openingBalance)) {
    throw new ValidationError('Balance must be a number');
  }
  return { name, type: body.type, openingBalance };
}

export function createAccountsRouter(db) {
  const router = Router();
  const owned = (userId, id) => db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(id, userId);
  const withBalance = (userId, id) => accountBalances(db, userId).find((a) => a.id === Number(id));

  router.get('/', (req, res) => res.json(accountBalances(db, req.userId)));

  router.post('/', (req, res) => {
    const a = parseAccount(req.body);
    const info = db
      .prepare('INSERT INTO accounts (user_id, name, type, opening_balance) VALUES (?, ?, ?, ?)')
      .run(req.userId, a.name, a.type, a.openingBalance);
    res.status(201).json(withBalance(req.userId, info.lastInsertRowid));
  });

  router.put('/:id', (req, res) => {
    if (!owned(req.userId, req.params.id)) return res.status(404).json({ error: 'Account not found' });
    const a = parseAccount(req.body);
    db.prepare('UPDATE accounts SET name = ?, type = ?, opening_balance = ?, archived = ? WHERE id = ?')
      .run(a.name, a.type, a.openingBalance, req.body.archived ? 1 : 0, req.params.id);
    res.json(withBalance(req.userId, req.params.id));
  });

  router.delete('/:id', (req, res) => {
    const id = req.params.id;
    if (!owned(req.userId, id)) return res.status(404).json({ error: 'Account not found' });
    const { n } = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM transactions WHERE account_id = ? OR to_account_id = ?)
              + (SELECT COUNT(*) FROM recurring_rules WHERE account_id = ? OR to_account_id = ?) AS n`
      )
      .get(id, id, id, id);
    if (n) return res.status(409).json({ error: 'This account has transactions. Archive it instead to hide it.' });
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}
```

In `server/app.js` add `import { createAccountsRouter } from './routes/accounts.js';` and mount `app.use('/api/accounts', requireAuth, createAccountsRouter(db));`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run`
Expected: PASS — all suites (42 tests).

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "$(printf 'Add accounts with running balances\n\nKasturi25n')"
```

---

### Task 5: Transactions API (income, expense, transfer, tags, filters, quick-add helpers)

**Files:**
- Create: `server/routes/transactions.js`
- Modify: `server/app.js` (mount)
- Test: `server/tests/transactions.test.js`

**Interfaces:**
- Consumes: `validateMovement`, `requireDateTime`, `ValidationError` (Task 3); `suggestCategory` (Task 3); `inTransaction` (Task 1); `POST /api/accounts` (Task 4, in tests).
- Produces: `GET /api/transactions?from&to&type&accountId&categoryId&tag&q&limit&offset` → `{ items: [row + tags: string[]], total }`; `POST /api/transactions` body `{ type, amount, occurredAt, accountId, toAccountId?, categoryId?, payee?, note?, tags? }` (omitting `categoryId` auto-categorises; `null` means none); `PUT /:id` (same body, full replace; `tags` omitted keeps tags); `DELETE /:id`; `GET /api/transactions/defaults` → `{ accountId }`; `GET /api/transactions/payees?q&type` → `{ payees: string[], suggestedCategoryId }`; `GET /api/transactions/tags` → `[{ name, uses }]`.

- [ ] **Step 1: Write the failing tests**

`server/tests/transactions.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, catId, cashId } from './helpers.js';

describe('transactions', () => {
  let app, db, userId, api, cash, food;
  const expense = (extra = {}) => ({ type: 'expense', amount: 250, occurredAt: '2026-10-05T13:10', accountId: cash, payee: 'Swiggy', ...extra });
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
    cash = cashId(db, userId);
    food = catId(db, userId, 'Food & Dining');
  });

  it('creates an expense, auto-categorising from the payee', async () => {
    const res = await api.post('/api/transactions', expense());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'expense', amount: 250, occurred_at: '2026-10-05T13:10', account_id: cash, category_id: food, payee: 'Swiggy', tags: [] });
  });

  it('keeps an explicit "no category"', async () => {
    expect((await api.post('/api/transactions', expense({ categoryId: null }))).body.category_id).toBeNull();
  });

  it('normalises tags', async () => {
    const res = await api.post('/api/transactions', expense({ tags: ['Goa-Trip ', 'goa-trip', 'Food'] }));
    expect(res.body.tags).toEqual(['food', 'goa-trip']);
  });

  it('validates amount, date and type', async () => {
    for (const bad of [{ amount: 0 }, { amount: 'abc' }, { amount: 2e9 }, { occurredAt: '05/10/2026' }, { type: 'gift' }]) {
      expect((await api.post('/api/transactions', expense(bad))).status).toBe(400);
    }
  });

  it('rejects accounts and categories that belong to someone else', async () => {
    const other = await signup(app, 'other@example.com');
    expect((await api.post('/api/transactions', expense({ accountId: cashId(db, other.userId) }))).status).toBe(400);
    expect((await api.post('/api/transactions', expense({ categoryId: catId(db, other.userId, 'Groceries') }))).status).toBe(400);
  });

  it('rejects a category of the wrong kind', async () => {
    const res = await api.post('/api/transactions', expense({ type: 'income', categoryId: food }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expense/);
  });

  it('records transfers between two different accounts without a category', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    expect((await api.post('/api/transactions', expense({ type: 'transfer', toAccountId: cash }))).status).toBe(400);
    const res = await api.post('/api/transactions', expense({ type: 'transfer', accountId: bank, toAccountId: cash, categoryId: food }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'transfer', account_id: bank, to_account_id: cash, category_id: null });
  });

  it('updates fields and tags, and 404s for other users', async () => {
    const groceries = catId(db, userId, 'Groceries');
    const { id } = (await api.post('/api/transactions', expense({ tags: ['a'] }))).body;
    const res = await api.put(`/api/transactions/${id}`, expense({ amount: 300, categoryId: groceries, tags: ['b'] }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: 300, category_id: groceries, tags: ['b'] });
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.put(`/api/transactions/${id}`, expense())).status).toBe(404);
  });

  it('still allows editing a transaction whose account was archived, but not new ones', async () => {
    const { id } = (await api.post('/api/transactions', expense())).body;
    await api.put(`/api/accounts/${cash}`, { name: 'Cash', type: 'cash', openingBalance: 0, archived: true });
    expect((await api.put(`/api/transactions/${id}`, expense({ amount: 99 }))).status).toBe(200);
    expect((await api.post('/api/transactions', expense())).status).toBe(400);
  });

  it('deletes a transaction', async () => {
    const { id } = (await api.post('/api/transactions', expense({ tags: ['x'] }))).body;
    expect((await api.del(`/api/transactions/${id}`)).status).toBe(204);
    expect((await api.get('/api/transactions')).body.total).toBe(0);
  });

  it('filters by type, account, category, tag, text and date', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    await api.post('/api/transactions', expense({ occurredAt: '2026-09-01T09:00', payee: 'Swiggy', tags: ['office'] }));
    await api.post('/api/transactions', expense({ occurredAt: '2026-09-20T21:30', payee: 'Uber', note: 'airport' }));
    await api.post('/api/transactions', { type: 'income', amount: 50000, occurredAt: '2026-09-30', accountId: bank, payee: 'Acme Corp' });
    await api.post('/api/transactions', { type: 'transfer', amount: 2000, occurredAt: '2026-09-25T10:00', accountId: bank, toAccountId: cash });
    const list = async (params) =>
      (await api.get(`/api/transactions?${new URLSearchParams(params)}`)).body.items.map((t) => t.payee || t.type);

    expect(await list({ type: 'income' })).toEqual(['Acme Corp']);
    expect(await list({ accountId: bank })).toEqual(['Acme Corp', 'transfer']);
    expect(await list({ categoryId: food })).toEqual(['Swiggy']);
    expect(await list({ tag: 'Office' })).toEqual(['Swiggy']);
    expect(await list({ q: 'airport' })).toEqual(['Uber']);
    expect(await list({ from: '2026-09-20', to: '2026-09-20' })).toEqual(['Uber']);
  });

  it('paginates newest first with a total', async () => {
    for (const day of ['01', '02', '03']) await api.post('/api/transactions', expense({ occurredAt: `2026-09-${day}T10:00` }));
    const first = (await api.get('/api/transactions?limit=2')).body;
    expect(first.total).toBe(3);
    expect(first.items.map((t) => t.occurred_at)).toEqual(['2026-09-03T10:00', '2026-09-02T10:00']);
    expect((await api.get('/api/transactions?limit=2&offset=2')).body.items).toHaveLength(1);
  });

  it('remembers the last account used', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    expect((await api.get('/api/transactions/defaults')).body.accountId).toBe(cash);
    await api.post('/api/transactions', expense({ accountId: bank }));
    expect((await api.get('/api/transactions/defaults')).body.accountId).toBe(bank);
  });

  it('suggests payees by frequency, and a category for the typed text', async () => {
    await api.post('/api/transactions', expense({ payee: 'Swiggy' }));
    await api.post('/api/transactions', expense({ payee: 'Swiggy' }));
    await api.post('/api/transactions', expense({ payee: 'Swagath Hotel', categoryId: null }));
    expect((await api.get('/api/transactions/payees?q=sw&type=expense')).body.payees).toEqual(['Swiggy', 'Swagath Hotel']);
    expect((await api.get('/api/transactions/payees?q=zomato&type=expense')).body.suggestedCategoryId).toBe(food);
  });

  it('lists tags with usage counts', async () => {
    await api.post('/api/transactions', expense({ tags: ['goa-trip'] }));
    await api.post('/api/transactions', expense({ tags: ['goa-trip', 'office'] }));
    expect((await api.get('/api/transactions/tags')).body).toEqual([{ name: 'goa-trip', uses: 2 }, { name: 'office', uses: 1 }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/transactions.test.js`
Expected: FAIL — `/api/transactions` returns 404.

- [ ] **Step 3: Write the transactions router**

`server/routes/transactions.js`:

```js
import { Router } from 'express';
import { inTransaction } from '../db.js';
import { ValidationError, requireDateTime, validateMovement } from '../validate.js';
import { suggestCategory } from '../services/categorize.js';

function normalizeTags(tags) {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags)) throw new ValidationError('Tags must be a list');
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();
}

export function createTransactionsRouter(db) {
  const router = Router();

  const setTags = (userId, txId, tags) => {
    db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(txId);
    for (const name of tags) {
      db.prepare('INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)').run(userId, name);
      const tag = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, name);
      db.prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(txId, tag.id);
    }
  };

  const withTags = (rows) => {
    if (!rows.length) return rows;
    const placeholders = rows.map(() => '?').join(',');
    const tagRows = db
      .prepare(
        `SELECT tt.transaction_id, g.name FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
         WHERE tt.transaction_id IN (${placeholders}) ORDER BY g.name`
      )
      .all(...rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, tags: tagRows.filter((t) => t.transaction_id === r.id).map((t) => t.name) }));
  };

  const getOne = (userId, id) => {
    const row = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, userId);
    return row ? withTags([row])[0] : null;
  };

  router.get('/defaults', (req, res) => {
    const recent = db
      .prepare(
        `SELECT t.account_id FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = ? AND a.archived = 0 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`
      )
      .get(req.userId);
    const first = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND archived = 0 ORDER BY id LIMIT 1').get(req.userId);
    res.json({ accountId: recent?.account_id ?? first?.id ?? null });
  });

  router.get('/payees', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const type = req.query.type === 'income' ? 'income' : 'expense';
    const rows = db
      .prepare(
        `SELECT payee, COUNT(*) AS uses FROM transactions
         WHERE user_id = ? AND type = ? AND payee != '' AND payee LIKE ?
         GROUP BY lower(payee) ORDER BY uses DESC, MAX(occurred_at) DESC LIMIT 10`
      )
      .all(req.userId, type, `%${q}%`);
    res.json({
      payees: rows.map((r) => r.payee),
      suggestedCategoryId: q ? suggestCategory(db, req.userId, { payee: q, type }) : null,
    });
  });

  router.get('/tags', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT g.name, COUNT(tt.transaction_id) AS uses FROM tags g
           LEFT JOIN transaction_tags tt ON tt.tag_id = g.id
           WHERE g.user_id = ? GROUP BY g.id ORDER BY uses DESC, g.name`
        )
        .all(req.userId)
    );
  });

  router.get('/', (req, res) => {
    const { from, to, type, accountId, categoryId, tag, q } = req.query;
    const where = ['t.user_id = ?'];
    const params = [req.userId];
    if (from) { where.push('substr(t.occurred_at, 1, 10) >= ?'); params.push(from); }
    if (to) { where.push('substr(t.occurred_at, 1, 10) <= ?'); params.push(to); }
    if (type) { where.push('t.type = ?'); params.push(type); }
    if (accountId) { where.push('(t.account_id = ? OR t.to_account_id = ?)'); params.push(accountId, accountId); }
    if (categoryId) { where.push('t.category_id = ?'); params.push(categoryId); }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = t.id AND g.name = ?)');
      params.push(String(tag).toLowerCase());
    }
    if (q) { where.push('(t.payee LIKE ? OR t.note LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const whereSql = where.join(' AND ');
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM transactions t WHERE ${whereSql}`).get(...params);
    const items = db
      .prepare(`SELECT t.* FROM transactions t WHERE ${whereSql} ORDER BY t.occurred_at DESC, t.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    res.json({ items: withTags(items), total });
  });

  router.post('/', (req, res) => {
    const m = validateMovement(db, req.userId, req.body);
    requireDateTime(req.body.occurredAt);
    const tags = normalizeTags(req.body.tags) ?? [];
    if (req.body.categoryId === undefined && m.type !== 'transfer') {
      m.categoryId = suggestCategory(db, req.userId, { payee: m.payee, note: m.note, type: m.type });
    }
    const id = inTransaction(db, () => {
      const info = db
        .prepare(
          `INSERT INTO transactions (user_id, type, amount, occurred_at, account_id, to_account_id, category_id, payee, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.userId, m.type, m.amount, req.body.occurredAt, m.accountId, m.toAccountId, m.categoryId, m.payee, m.note);
      const txId = Number(info.lastInsertRowid);
      setTags(req.userId, txId, tags);
      return txId;
    });
    res.status(201).json(getOne(req.userId, id));
  });

  router.put('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });
    const m = validateMovement(db, req.userId, req.body, [existing.account_id, existing.to_account_id]);
    requireDateTime(req.body.occurredAt);
    const tags = normalizeTags(req.body.tags);
    inTransaction(db, () => {
      db.prepare(
        `UPDATE transactions SET type = ?, amount = ?, occurred_at = ?, account_id = ?, to_account_id = ?,
           category_id = ?, payee = ?, note = ? WHERE id = ?`
      ).run(m.type, m.amount, req.body.occurredAt, m.accountId, m.toAccountId, m.categoryId, m.payee, m.note, existing.id);
      if (tags !== undefined) setTags(req.userId, existing.id, tags);
    });
    res.json(getOne(req.userId, existing.id));
  });

  router.delete('/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM transactions WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });
    inTransaction(db, () => {
      db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(existing.id);
      db.prepare('DELETE FROM transactions WHERE id = ?').run(existing.id);
    });
    res.status(204).end();
  });

  return router;
}
```

In `server/app.js` add `import { createTransactionsRouter } from './routes/transactions.js';` and mount `app.use('/api/transactions', requireAuth, createTransactionsRouter(db));`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run`
Expected: PASS — all suites (57 tests).

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "$(printf 'Add transactions API with transfers, tags, filters and quick-add helpers\n\nKasturi25n')"
```

---

### Task 6: Recurring date maths

**Files:**
- Create: `server/services/recurring.js`
- Test: `server/tests/recurring-dates.test.js`

**Interfaces:**
- Produces: `FREQUENCIES = ['weekly','monthly','quarterly','yearly']`; `addDays(dateStr, n) → dateStr`; `addPeriod(dateStr, frequency, anchorDay) → dateStr`; `occurrencesBetween(rule, until) → { dates: string[], nextDate }` where `rule` has `next_date, frequency, anchor_day, end_date`; `todayLocal() → 'YYYY-MM-DD'` (server's local date). All dates are `'YYYY-MM-DD'` strings.

- [ ] **Step 1: Write the failing tests**

`server/tests/recurring-dates.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { addPeriod, addDays, occurrencesBetween } from '../services/recurring.js';

describe('addPeriod', () => {
  it('keeps the 31st sticky across short months', () => {
    expect(addPeriod('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(addPeriod('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
  });

  it('handles leap years for yearly items', () => {
    expect(addPeriod('2028-02-29', 'yearly', 29)).toBe('2029-02-28');
    expect(addPeriod('2031-02-28', 'yearly', 29)).toBe('2032-02-29');
  });

  it('adds three months for quarterly, crossing the year', () => {
    expect(addPeriod('2026-11-30', 'quarterly', 30)).toBe('2027-02-28');
  });

  it('adds seven days for weekly, crossing the month', () => {
    expect(addPeriod('2026-09-28', 'weekly', 28)).toBe('2026-10-05');
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-30', 7)).toBe('2027-01-06');
  });
});

describe('occurrencesBetween', () => {
  const rule = { next_date: '2026-07-05', frequency: 'monthly', anchor_day: 5, end_date: null };

  it('lists every due date up to and including the limit', () => {
    expect(occurrencesBetween(rule, '2026-10-05')).toEqual({
      dates: ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'],
      nextDate: '2026-11-05',
    });
  });

  it('stops at the end date', () => {
    expect(occurrencesBetween({ ...rule, end_date: '2026-08-31' }, '2026-10-07')).toEqual({
      dates: ['2026-07-05', '2026-08-05'],
      nextDate: '2026-09-05',
    });
  });

  it('returns nothing when not yet due', () => {
    expect(occurrencesBetween({ ...rule, next_date: '2026-10-10' }, '2026-10-07')).toEqual({ dates: [], nextDate: '2026-10-10' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/recurring-dates.test.js`
Expected: FAIL — cannot import `../services/recurring.js`.

- [ ] **Step 3: Write the date maths**

`server/services/recurring.js`:

```js
export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const MONTHS_PER_PERIOD = { monthly: 1, quarterly: 3, yearly: 12 };

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return toDateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// anchorDay is the day-of-month the item was set up on, so "31st" survives a 28-day February.
export function addPeriod(dateStr, frequency, anchorDay) {
  if (frequency === 'weekly') return addDays(dateStr, 7);
  const [y, m] = dateStr.split('-').map(Number);
  const monthIndex = m - 1 + MONTHS_PER_PERIOD[frequency];
  const year = y + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return toDateStr(year, month, Math.min(anchorDay, daysInMonth(year, month)));
}

export function occurrencesBetween(rule, until) {
  const dates = [];
  let date = rule.next_date;
  while (date <= until && (!rule.end_date || date <= rule.end_date)) {
    dates.push(date);
    date = addPeriod(date, rule.frequency, rule.anchor_day);
  }
  return { dates, nextDate: date };
}

export function todayLocal() {
  const now = new Date();
  return toDateStr(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run`
Expected: PASS — all suites (65 tests).

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "$(printf 'Add recurring date maths\n\nKasturi25n')"
```

---

### Task 7: Recurring items API with lazy posting

**Files:**
- Modify: `server/services/recurring.js` (append DB functions)
- Create: `server/routes/recurring.js`
- Modify: `server/app.js` (replace whole file: injectable clock, materialise middleware)
- Modify: `server/routes/categories.js` (delete clears recurring category)
- Modify: `server/tests/helpers.js` (`freshApp(options)`)
- Test: `server/tests/recurring.test.js`

**Interfaces:**
- Consumes: Task 6 date functions; `validateMovement`, `requireDate`, `requireDateTime`, `requireAmount`, `requireOneOf`, `ValidationError` (Task 3); `inTransaction` (Task 1).
- Produces: `postOccurrence(db, rule, occurredAt, amount) → txId`; `advance(db, rule, nextDate)`; `materializeDue(db, userId, today)`; `createApp(db, jwtSecret, { today } = {})` where `today: () => 'YYYY-MM-DD'`; `freshApp(options) → { app, db }`.
- API: `GET /api/recurring` → `{ rules: rows, pending: occurrence[] }`; `GET /api/recurring/upcoming?days=7` → `occurrence[]` (dates after today); occurrence = `{ ruleId, date, amount, type, payee, mode, category_id, account_id, to_account_id }`; `POST /api/recurring` body = movement fields + `{ frequency, nextDate, endDate?, mode? }`; `PUT /:id` same + `active`; `DELETE /:id`; `POST /:id/confirm { amount? }` → 201 transaction; `POST /:id/skip` → rule.

- [ ] **Step 1: Make the test app's clock injectable**

In `server/tests/helpers.js` replace `freshApp` with:

```js
export function freshApp(options = {}) {
  const db = createDb(':memory:');
  return { app: createApp(db, 'test-secret', options), db };
}
```

- [ ] **Step 2: Write the failing tests**

`server/tests/recurring.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, catId, cashId } from './helpers.js';

describe('recurring items', () => {
  let app, db, userId, api, cash, today;
  const rule = (extra = {}) => ({
    type: 'expense', amount: 15000, accountId: cash, payee: 'Landlord', categoryId: catId(db, userId, 'Rent'),
    frequency: 'monthly', nextDate: '2026-08-05', mode: 'auto', ...extra,
  });
  const txs = async () => (await api.get('/api/transactions')).body.items;
  beforeEach(async () => {
    today = '2026-10-07';
    ({ app, db } = freshApp({ today: () => today }));
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
    cash = cashId(db, userId);
  });

  it('posts every missed occurrence of an automatic item exactly once', async () => {
    const created = await api.post('/api/recurring', rule());
    expect(created.status).toBe(201);
    const posted = await txs();
    expect(posted.map((t) => t.occurred_at)).toEqual(['2026-10-05', '2026-09-05', '2026-08-05']);
    expect(posted.every((t) => t.recurring_id === created.body.id)).toBe(true);
    expect(await txs()).toHaveLength(3);
    expect((await api.get('/api/recurring')).body.rules[0].next_date).toBe('2026-11-05');
  });

  it('waits for confirmation on "confirm" items, then posts the edited amount', async () => {
    const bills = catId(db, userId, 'Bills & Utilities');
    const { id } = (await api.post('/api/recurring', rule({ payee: 'BESCOM', amount: 1200, categoryId: bills, nextDate: '2026-10-01', mode: 'confirm' }))).body;
    expect(await txs()).toHaveLength(0);
    expect((await api.get('/api/recurring')).body.pending).toEqual([expect.objectContaining({ ruleId: id, date: '2026-10-01', amount: 1200 })]);

    const res = await api.post(`/api/recurring/${id}/confirm`, { amount: 1340 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: 1340, occurred_at: '2026-10-01', recurring_id: id, category_id: bills });
    const after = (await api.get('/api/recurring')).body;
    expect(after.pending).toEqual([]);
    expect(after.rules[0].next_date).toBe('2026-11-01');
  });

  it('skips an occurrence without posting', async () => {
    const { id } = (await api.post('/api/recurring', rule({ nextDate: '2026-10-01', mode: 'confirm' }))).body;
    expect((await api.post(`/api/recurring/${id}/skip`)).status).toBe(200);
    expect(await txs()).toHaveLength(0);
    expect((await api.get('/api/recurring')).body.rules[0].next_date).toBe('2026-11-01');
  });

  it('refuses to confirm something not yet due', async () => {
    const { id } = (await api.post('/api/recurring', rule({ nextDate: '2026-10-20', mode: 'confirm' }))).body;
    expect((await api.post(`/api/recurring/${id}/confirm`, {})).status).toBe(400);
  });

  it('stops at the end date and marks the item inactive', async () => {
    await api.post('/api/recurring', rule({ endDate: '2026-09-30' }));
    expect((await txs()).map((t) => t.occurred_at)).toEqual(['2026-09-05', '2026-08-05']);
    expect((await api.get('/api/recurring')).body.rules[0].active).toBe(0);
  });

  it('does not backfill the time an item was paused', async () => {
    const created = (await api.post('/api/recurring', rule({ nextDate: '2026-10-20' }))).body;
    const body = rule({ nextDate: created.next_date });
    await api.put(`/api/recurring/${created.id}`, { ...body, active: false });
    today = '2026-12-10';
    const resumed = await api.put(`/api/recurring/${created.id}`, { ...body, active: true });
    expect(resumed.body.next_date).toBe('2026-12-20');
    expect(await txs()).toHaveLength(0);
  });

  it('lists what is coming up in the window', async () => {
    await api.post('/api/recurring', rule({ nextDate: '2026-10-20' }));
    expect((await api.get('/api/recurring/upcoming?days=7')).body).toEqual([]);
    expect((await api.get('/api/recurring/upcoming?days=30')).body).toEqual([
      expect.objectContaining({ date: '2026-10-20', amount: 15000, payee: 'Landlord', mode: 'auto' }),
    ]);
  });

  it('changes only future occurrences when an item is edited', async () => {
    const created = (await api.post('/api/recurring', rule())).body;
    await txs();
    await api.put(`/api/recurring/${created.id}`, rule({ amount: 16000, nextDate: '2026-11-05' }));
    expect((await txs()).map((t) => t.amount)).toEqual([15000, 15000, 15000]);
  });

  it('keeps posted transactions when an item is deleted', async () => {
    const created = (await api.post('/api/recurring', rule())).body;
    await txs();
    expect((await api.del(`/api/recurring/${created.id}`)).status).toBe(204);
    const left = await txs();
    expect(left).toHaveLength(3);
    expect(left.every((t) => t.recurring_id === null)).toBe(true);
  });

  it('validates input and protects other users\' items', async () => {
    expect((await api.post('/api/recurring', rule({ frequency: 'daily' }))).status).toBe(400);
    expect((await api.post('/api/recurring', rule({ nextDate: '5 Oct' }))).status).toBe(400);
    expect((await api.post('/api/recurring', rule({ endDate: '2026-01-01' }))).status).toBe(400);
    const created = (await api.post('/api/recurring', rule({ nextDate: '2026-10-20' }))).body;
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.put(`/api/recurring/${created.id}`, rule())).status).toBe(404);
    expect((await other.del(`/api/recurring/${created.id}`)).status).toBe(404);
  });

  it('clears the category from items when the category is deleted', async () => {
    const rent = catId(db, userId, 'Rent');
    const created = (await api.post('/api/recurring', rule({ nextDate: '2026-10-20' }))).body;
    await api.del(`/api/categories/${rent}`);
    expect((await api.get('/api/recurring')).body.rules.find((r) => r.id === created.id).category_id).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/recurring.test.js`
Expected: FAIL — `/api/recurring` returns 404.

- [ ] **Step 4: Add posting functions to the service**

At the top of `server/services/recurring.js` add `import { inTransaction } from '../db.js';` and append to the file:

```js
export function postOccurrence(db, rule, occurredAt, amount) {
  const info = db
    .prepare(
      `INSERT INTO transactions (user_id, type, amount, occurred_at, account_id, to_account_id, category_id, payee, note, recurring_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(rule.user_id, rule.type, amount, occurredAt, rule.account_id, rule.to_account_id, rule.category_id, rule.payee, rule.note, rule.id);
  return Number(info.lastInsertRowid);
}

export function advance(db, rule, nextDate) {
  const ended = Boolean(rule.end_date) && nextDate > rule.end_date;
  db.prepare('UPDATE recurring_rules SET next_date = ?, active = ? WHERE id = ?').run(nextDate, ended ? 0 : 1, rule.id);
}

export function materializeDue(db, userId, today) {
  const due = db
    .prepare("SELECT * FROM recurring_rules WHERE user_id = ? AND active = 1 AND mode = 'auto' AND next_date <= ?")
    .all(userId, today);
  if (!due.length) return;
  inTransaction(db, () => {
    for (const rule of due) {
      const { dates, nextDate } = occurrencesBetween(rule, today);
      for (const date of dates) postOccurrence(db, rule, date, rule.amount);
      advance(db, rule, nextDate);
    }
  });
}
```

- [ ] **Step 5: Write the recurring router**

`server/routes/recurring.js`:

```js
import { Router } from 'express';
import { inTransaction } from '../db.js';
import { ValidationError, requireAmount, requireDate, requireDateTime, requireOneOf, validateMovement } from '../validate.js';
import { FREQUENCIES, addDays, addPeriod, advance, occurrencesBetween, postOccurrence } from '../services/recurring.js';

const MODES = ['auto', 'confirm'];

const occurrence = (r, date) => ({
  ruleId: r.id, date, amount: r.amount, type: r.type, payee: r.payee, mode: r.mode,
  category_id: r.category_id, account_id: r.account_id, to_account_id: r.to_account_id,
});

export function createRecurringRouter(db, today) {
  const router = Router();
  const owned = (userId, id) => db.prepare('SELECT * FROM recurring_rules WHERE id = ? AND user_id = ?').get(id, userId);

  const parseRule = (userId, body, allowArchivedIds) => {
    const m = validateMovement(db, userId, body, allowArchivedIds);
    requireOneOf(body.frequency, FREQUENCIES, 'Frequency');
    requireDate(body.nextDate, 'Next date');
    const endDate = body.endDate || null;
    if (endDate) {
      requireDate(endDate, 'End date');
      if (endDate < body.nextDate) throw new ValidationError('End date must be after the next date');
    }
    const mode = body.mode ?? 'auto';
    requireOneOf(mode, MODES, 'Mode');
    return { ...m, frequency: body.frequency, nextDate: body.nextDate, endDate, mode };
  };

  const dueRule = (req) => {
    const rule = owned(req.userId, req.params.id);
    if (!rule) return null;
    if (!rule.active || rule.next_date > today()) throw new ValidationError('Nothing is due for this item yet');
    return rule;
  };

  router.get('/', (req, res) => {
    const rules = db.prepare('SELECT * FROM recurring_rules WHERE user_id = ? ORDER BY active DESC, next_date').all(req.userId);
    const now = today();
    const pending = rules
      .filter((r) => r.active && r.mode === 'confirm')
      .flatMap((r) => occurrencesBetween(r, now).dates.map((date) => occurrence(r, date)))
      .sort((a, b) => a.date.localeCompare(b.date));
    res.json({ rules, pending });
  });

  router.get('/upcoming', (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const now = today();
    const until = addDays(now, days);
    const items = db
      .prepare('SELECT * FROM recurring_rules WHERE user_id = ? AND active = 1')
      .all(req.userId)
      .flatMap((r) => occurrencesBetween(r, until).dates.filter((d) => d > now).map((date) => occurrence(r, date)))
      .sort((a, b) => a.date.localeCompare(b.date));
    res.json(items);
  });

  router.post('/', (req, res) => {
    const r = parseRule(req.userId, req.body ?? {});
    const info = db
      .prepare(
        `INSERT INTO recurring_rules (user_id, type, amount, account_id, to_account_id, category_id, payee, note,
           frequency, anchor_day, start_date, end_date, next_date, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(req.userId, r.type, r.amount, r.accountId, r.toAccountId, r.categoryId, r.payee, r.note,
        r.frequency, Number(r.nextDate.slice(8, 10)), r.nextDate, r.endDate, r.nextDate, r.mode);
    res.status(201).json(owned(req.userId, Number(info.lastInsertRowid)));
  });

  router.put('/:id', (req, res) => {
    const existing = owned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Repeating item not found' });
    const r = parseRule(req.userId, req.body ?? {}, [existing.account_id, existing.to_account_id]);
    const active = req.body.active === undefined ? Boolean(existing.active) : Boolean(req.body.active);
    const anchorDay = r.nextDate === existing.next_date ? existing.anchor_day : Number(r.nextDate.slice(8, 10));
    let nextDate = r.nextDate;
    if (active && !existing.active) {
      // Resuming: the paused period didn't happen, so jump to the first date from today on.
      const now = today();
      while (nextDate < now) nextDate = addPeriod(nextDate, r.frequency, anchorDay);
    }
    db.prepare(
      `UPDATE recurring_rules SET type = ?, amount = ?, account_id = ?, to_account_id = ?, category_id = ?, payee = ?, note = ?,
         frequency = ?, anchor_day = ?, end_date = ?, next_date = ?, mode = ?, active = ? WHERE id = ?`
    ).run(r.type, r.amount, r.accountId, r.toAccountId, r.categoryId, r.payee, r.note,
      r.frequency, anchorDay, r.endDate, nextDate, r.mode, active ? 1 : 0, existing.id);
    res.json(owned(req.userId, existing.id));
  });

  router.delete('/:id', (req, res) => {
    const existing = owned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Repeating item not found' });
    inTransaction(db, () => {
      db.prepare('UPDATE transactions SET recurring_id = NULL WHERE recurring_id = ?').run(existing.id);
      db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(existing.id);
    });
    res.status(204).end();
  });

  router.post('/:id/confirm', (req, res) => {
    const rule = dueRule(req);
    if (!rule) return res.status(404).json({ error: 'Repeating item not found' });
    const amount = req.body?.amount ?? rule.amount;
    requireAmount(amount);
    const occurredAt = req.body?.occurredAt ?? rule.next_date;
    requireDateTime(occurredAt);
    const txId = inTransaction(db, () => {
      const id = postOccurrence(db, rule, occurredAt, amount);
      advance(db, rule, addPeriod(rule.next_date, rule.frequency, rule.anchor_day));
      return id;
    });
    res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId));
  });

  router.post('/:id/skip', (req, res) => {
    const rule = dueRule(req);
    if (!rule) return res.status(404).json({ error: 'Repeating item not found' });
    advance(db, rule, addPeriod(rule.next_date, rule.frequency, rule.anchor_day));
    res.json(owned(req.userId, rule.id));
  });

  return router;
}
```

- [ ] **Step 6: Wire the clock and materialisation into the app**

`server/app.js` (replace whole file):

```js
import express from 'express';
import cors from 'cors';
import { createAuthMiddleware } from './middleware/auth.js';
import { ValidationError } from './validate.js';
import { materializeDue, todayLocal } from './services/recurring.js';
import { createAuthRouter } from './routes/auth.js';
import { createCategoriesRouter } from './routes/categories.js';
import { createRulesRouter } from './routes/rules.js';
import { createAccountsRouter } from './routes/accounts.js';
import { createTransactionsRouter } from './routes/transactions.js';
import { createRecurringRouter } from './routes/recurring.js';
import { createBudgetsRouter } from './routes/budgets.js';
import { createExportRouter } from './routes/export.js';

export function createApp(db, jwtSecret, { today = todayLocal } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const requireAuth = createAuthMiddleware(jwtSecret);
  // Post automatic recurring items that have come due before any money data is read.
  const materialize = (req, res, next) => {
    materializeDue(db, req.userId, today());
    next();
  };
  const authed = [requireAuth, materialize];

  app.use('/api/auth', createAuthRouter(db, jwtSecret));
  app.use('/api/categories', requireAuth, createCategoriesRouter(db));
  app.use('/api/rules', requireAuth, createRulesRouter(db));
  app.use('/api/accounts', ...authed, createAccountsRouter(db));
  app.use('/api/transactions', ...authed, createTransactionsRouter(db));
  app.use('/api/recurring', ...authed, createRecurringRouter(db, today));
  app.use('/api/budgets', ...authed, createBudgetsRouter(db));
  app.use('/api/export', ...authed, createExportRouter(db));

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
```

In `server/routes/categories.js` delete handler, add inside `inTransaction` before deleting the category:

```js
      db.prepare('UPDATE recurring_rules SET category_id = NULL WHERE category_id = ?').run(req.params.id);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && npx vitest run`
Expected: PASS — all suites (76 tests).

- [ ] **Step 8: Commit**

```bash
git add server
git commit -m "$(printf 'Add recurring items that post themselves or wait for confirmation\n\nKasturi25n')"
```

---

### Task 8: Summary endpoint

**Files:**
- Create: `server/routes/summary.js`
- Modify: `server/app.js` (mount)
- Test: `server/tests/summary.test.js`

**Interfaces:**
- Consumes: `accountBalances` (Task 4), `requireDate` (Task 3), recurring API (Task 7, in tests).
- Produces: `GET /api/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ income, expense, net, byCategory: [{ categoryId, total }] (expense only, largest first), accounts: non-archived accountBalances rows }`.

- [ ] **Step 1: Write the failing tests**

`server/tests/summary.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, addTx, catId, cashId } from './helpers.js';

describe('summary', () => {
  let app, db, userId, api, cash;
  beforeEach(async () => {
    ({ app, db } = freshApp({ today: () => '2026-10-07' }));
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
    cash = cashId(db, userId);
  });

  it('totals a period, ignoring transfers and rounding to paise', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    const food = catId(db, userId, 'Food & Dining');
    const shopping = catId(db, userId, 'Shopping');
    addTx(db, userId, { type: 'income', amount: 50000, occurredAt: '2026-10-01', accountId: bank });
    addTx(db, userId, { amount: 250, occurredAt: '2026-10-05T13:00', categoryId: food, accountId: cash });
    addTx(db, userId, { amount: 1000, occurredAt: '2026-10-06', categoryId: shopping, accountId: bank });
    addTx(db, userId, { amount: 0.1, occurredAt: '2026-10-06', accountId: cash });
    addTx(db, userId, { amount: 0.2, occurredAt: '2026-10-06', accountId: cash });
    addTx(db, userId, { type: 'transfer', amount: 5000, occurredAt: '2026-10-02', accountId: bank, toAccountId: cash });
    addTx(db, userId, { amount: 999, occurredAt: '2026-09-30T23:59', accountId: cash });

    const res = await api.get('/api/summary?from=2026-10-01&to=2026-10-31');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ income: 50000, expense: 1250.3, net: 48749.7 });
    expect(res.body.byCategory).toEqual([
      { categoryId: shopping, total: 1000 },
      { categoryId: food, total: 250 },
      { categoryId: null, total: 0.3 },
    ]);
    expect(res.body.accounts.map((a) => [a.name, a.balance])).toEqual([['Cash', 3750.7], ['HDFC', 44000]]);
  });

  it('requires valid from and to dates', async () => {
    expect((await api.get('/api/summary')).status).toBe(400);
    expect((await api.get('/api/summary?from=2026-10-01&to=Oct')).status).toBe(400);
  });

  it('includes recurring items that came due', async () => {
    await api.post('/api/recurring', {
      type: 'income', amount: 80000, accountId: cash, payee: 'Acme', categoryId: catId(db, userId, 'Salary'),
      frequency: 'monthly', nextDate: '2026-10-01', mode: 'auto',
    });
    expect((await api.get('/api/summary?from=2026-10-01&to=2026-10-31')).body.income).toBe(80000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run tests/summary.test.js`
Expected: FAIL — `/api/summary` returns 404.

- [ ] **Step 3: Write the summary router**

`server/routes/summary.js`:

```js
import { Router } from 'express';
import { requireDate } from '../validate.js';
import { accountBalances } from './accounts.js';

const round = (n) => Math.round(n * 100) / 100;

export function createSummaryRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const { from, to } = req.query;
    requireDate(from, 'From');
    requireDate(to, 'To');
    const range = 'user_id = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ?';
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
         FROM transactions WHERE ${range}`
      )
      .get(req.userId, from, to);
    const byCategory = db
      .prepare(
        `SELECT category_id AS categoryId, ROUND(SUM(amount), 2) AS total FROM transactions
         WHERE ${range} AND type = 'expense' GROUP BY category_id ORDER BY total DESC`
      )
      .all(req.userId, from, to);

    res.json({
      income: round(totals.income),
      expense: round(totals.expense),
      net: round(totals.income - totals.expense),
      byCategory,
      accounts: accountBalances(db, req.userId).filter((a) => !a.archived),
    });
  });

  return router;
}
```

In `server/app.js` add `import { createSummaryRouter } from './routes/summary.js';` and mount `app.use('/api/summary', ...authed, createSummaryRouter(db));` after the recurring line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run`
Expected: PASS — all suites (79 tests).

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "$(printf 'Add period summary endpoint\n\nKasturi25n')"
```

---

> **Frontend tasks (9–11):** the client has no test runner and adding one would be a new dependency (Global Constraints). Each task is verified by a production build plus a short manual check against the running app; the final task lists the full click-through. Between Task 9 and Task 10 the Home page still calls the removed `getExpenses` and will show an error — Task 10 replaces it.

### Task 9: App shell — API client, Quick Add modal, navigation, Transactions page, styles

**Files:**
- Modify: `client/src/api.js` (whole file), `client/src/format.js` (whole file), `client/src/context/AuthContext.jsx`, `client/src/components/Nav.jsx` (whole file), `client/src/components/CategoryBadge.jsx`, `client/src/App.jsx` (whole file), `client/src/App.css` (whole file), `client/src/main.jsx`
- Create: `client/src/context/QuickAddContext.jsx`, `client/src/components/Modal.jsx`, `client/src/components/QuickAdd.jsx`, `client/src/pages/Transactions.jsx`
- Delete: `client/src/pages/Expenses.jsx`, `client/src/components/ExpenseForm.jsx`, `client/src/index.css`

**Interfaces:**
- Consumes: every API from Tasks 3–8.
- Produces: `api.*` functions listed below; `format.js` exports `formatMoney, signedMoney, toDateStr, todayStr, nowLocalDateTime, formatShortDate, formatDay, timeOf, monthRange`; `useQuickAdd() → { open(tx?), version, refresh() }` — `open()` adds, `open(txRow)` edits, `version` increments after any save so pages reload.

- [ ] **Step 1: Replace the API client**

`client/src/api.js`:

```js
const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) window.dispatchEvent(new Event('auth:expired'));
  if (res.status === 204) return null;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(isJson && data?.error ? data.error : 'Request failed');
  return data;
}

const query = (params = {}) => {
  const clean = Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined);
  const qs = new URLSearchParams(clean).toString();
  return qs ? `?${qs}` : '';
};

export const api = {
  register: (email, password) => request('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),

  getCategories: (token) => request('/categories', { token }),
  createCategory: (token, category) => request('/categories', { method: 'POST', body: category, token }),
  updateCategory: (token, id, category) => request(`/categories/${id}`, { method: 'PUT', body: category, token }),
  deleteCategory: (token, id) => request(`/categories/${id}`, { method: 'DELETE', token }),

  getRules: (token) => request('/rules', { token }),
  createRule: (token, rule) => request('/rules', { method: 'POST', body: rule, token }),
  deleteRule: (token, id) => request(`/rules/${id}`, { method: 'DELETE', token }),

  getAccounts: (token) => request('/accounts', { token }),
  createAccount: (token, account) => request('/accounts', { method: 'POST', body: account, token }),
  updateAccount: (token, id, account) => request(`/accounts/${id}`, { method: 'PUT', body: account, token }),
  deleteAccount: (token, id) => request(`/accounts/${id}`, { method: 'DELETE', token }),

  getTransactions: (token, filters) => request(`/transactions${query(filters)}`, { token }),
  createTransaction: (token, tx) => request('/transactions', { method: 'POST', body: tx, token }),
  updateTransaction: (token, id, tx) => request(`/transactions/${id}`, { method: 'PUT', body: tx, token }),
  deleteTransaction: (token, id) => request(`/transactions/${id}`, { method: 'DELETE', token }),
  getDefaults: (token) => request('/transactions/defaults', { token }),
  getPayees: (token, q, type) => request(`/transactions/payees${query({ q, type })}`, { token }),
  getTags: (token) => request('/transactions/tags', { token }),

  getRecurring: (token) => request('/recurring', { token }),
  getUpcoming: (token, days = 7) => request(`/recurring/upcoming?days=${days}`, { token }),
  createRecurring: (token, item) => request('/recurring', { method: 'POST', body: item, token }),
  updateRecurring: (token, id, item) => request(`/recurring/${id}`, { method: 'PUT', body: item, token }),
  deleteRecurring: (token, id) => request(`/recurring/${id}`, { method: 'DELETE', token }),
  confirmRecurring: (token, id, body) => request(`/recurring/${id}/confirm`, { method: 'POST', body, token }),
  skipRecurring: (token, id) => request(`/recurring/${id}/skip`, { method: 'POST', token }),

  getSummary: (token, from, to) => request(`/summary${query({ from, to })}`, { token }),

  getBudgetStatus: (token, month) => request(`/budgets/status/${month}`, { token }),
  createBudget: (token, budget) => request('/budgets', { method: 'POST', body: budget, token }),
  deleteBudget: (token, id) => request(`/budgets/${id}`, { method: 'DELETE', token }),

  exportCsv: async (token) => {
    const res = await fetch(`${BASE_URL}/export/csv`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },
};
```

- [ ] **Step 2: Replace the formatting helpers**

`client/src/format.js`:

```js
const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export const formatMoney = (amount) => rupee.format(amount);

export function signedMoney(tx) {
  if (tx.type === 'income') return `+${formatMoney(tx.amount)}`;
  if (tx.type === 'expense') return `−${formatMoney(tx.amount)}`;
  return formatMoney(tx.amount);
}

const pad = (n) => String(n).padStart(2, '0');
const parseDate = (s) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => toDateStr(new Date());

export function nowLocalDateTime() {
  const d = new Date();
  return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const formatShortDate = (s) => parseDate(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

export function formatDay(s) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (s === todayStr()) return 'Today';
  if (s === toDateStr(yesterday)) return 'Yesterday';
  return parseDate(s).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

export function timeOf(occurredAt) {
  if (!occurredAt.includes('T')) return '';
  const [h, m] = occurredAt.slice(11, 16).split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

export function monthRange(offset = 0) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { from: toDateStr(first), to: toDateStr(last), label: first.toLocaleString('en-IN', { month: 'short' }) };
}
```

- [ ] **Step 3: Log out automatically when the token expires**

In `client/src/context/AuthContext.jsx`, change the React import to
`import { createContext, useContext, useState, useCallback, useEffect } from 'react';`
and add directly after the `logout` callback:

```jsx
  useEffect(() => {
    window.addEventListener('auth:expired', logout);
    return () => window.removeEventListener('auth:expired', logout);
  }, [logout]);
```

In `client/src/components/CategoryBadge.jsx` change the text `Uncategorized` to `Uncategorised`.

- [ ] **Step 4: Add the modal and Quick Add form**

`client/src/components/Modal.jsx`:

```jsx
import { useEffect } from 'react';

export function Modal({ onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}
```

`client/src/components/QuickAdd.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { nowLocalDateTime } from '../format.js';
import { Modal } from './Modal.jsx';

const TYPES = [['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']];

function toForm(tx) {
  if (!tx.id) {
    return { type: 'expense', amount: '', payee: '', categoryId: '', accountId: '', toAccountId: '', occurredAt: nowLocalDateTime(), tags: '', note: '' };
  }
  return {
    type: tx.type,
    amount: String(tx.amount),
    payee: tx.payee,
    categoryId: tx.category_id ?? '',
    accountId: tx.account_id,
    toAccountId: tx.to_account_id ?? '',
    occurredAt: tx.occurred_at.includes('T') ? tx.occurred_at : `${tx.occurred_at}T00:00`,
    tags: tx.tags.join(', '),
    note: tx.note,
  };
}

export function QuickAdd({ initial, onClose, onSaved }) {
  const { token } = useAuth();
  const isEdit = Boolean(initial.id);
  const [form, setForm] = useState(() => toForm(initial));
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [payees, setPayees] = useState([]);
  const [categoryTouched, setCategoryTouched] = useState(isEdit);
  const [showMore, setShowMore] = useState(isEdit);
  const [ruleOffer, setRuleOffer] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getAccounts(token), api.getCategories(token), isEdit ? null : api.getDefaults(token)])
      .then(([accountList, categoryList, defaults]) => {
        setAccounts(accountList.filter((a) => !a.archived || a.id === initial.account_id || a.id === initial.to_account_id));
        setCategories(categoryList);
        if (defaults?.accountId) setForm((f) => ({ ...f, accountId: f.accountId || defaults.accountId }));
      })
      .catch((e) => setError(e.message));
  }, [token, isEdit, initial]);

  useEffect(() => {
    if (form.type === 'transfer') return undefined;
    const timer = setTimeout(() => {
      api.getPayees(token, form.payee.trim(), form.type)
        .then(({ payees: list, suggestedCategoryId }) => {
          setPayees(list);
          if (!categoryTouched && form.payee.trim()) setForm((f) => ({ ...f, categoryId: suggestedCategoryId ?? '' }));
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [token, form.payee, form.type, categoryTouched]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const chooseType = (type) => {
    setForm((f) => ({ ...f, type, categoryId: '' }));
    setCategoryTouched(false);
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    const amount = parseFloat(form.amount);
    if (!(amount > 0)) return setError('Enter an amount greater than 0');
    if (!form.accountId) return setError('Pick an account');
    if (form.type === 'transfer' && !form.toAccountId) return setError('Pick the account the money went to');

    const body = {
      type: form.type,
      amount,
      occurredAt: form.occurredAt,
      accountId: Number(form.accountId),
      toAccountId: form.type === 'transfer' ? Number(form.toAccountId) : null,
      payee: form.type === 'transfer' ? '' : form.payee.trim(),
      note: form.note.trim(),
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    };
    // A blank category on a new entry lets the server pick one from the payee.
    if (form.type !== 'transfer' && (form.categoryId || isEdit)) {
      body.categoryId = form.categoryId ? Number(form.categoryId) : null;
    }

    try {
      if (isEdit) await api.updateTransaction(token, initial.id, body);
      else await api.createTransaction(token, body);
    } catch (err) {
      return setError(err.message);
    }

    if (isEdit && body.payee && body.categoryId && body.categoryId !== initial.category_id) {
      const rules = await api.getRules(token).catch(() => []);
      if (!rules.some((r) => r.match_text === body.payee.toLowerCase())) {
        const category = categories.find((c) => c.id === body.categoryId);
        return setRuleOffer({ payee: body.payee, categoryId: category.id, categoryName: category.name });
      }
    }
    onSaved();
  };

  const acceptRule = async () => {
    await api.createRule(token, { matchText: ruleOffer.payee, categoryId: ruleOffer.categoryId }).catch(() => {});
    onSaved();
  };

  if (ruleOffer) {
    return (
      <Modal onClose={onSaved}>
        <h2>Remember this?</h2>
        <p>
          Always put <strong>{ruleOffer.payee}</strong> in <strong>{ruleOffer.categoryName}</strong> from now on?
        </p>
        <div className="row">
          <button onClick={acceptRule}>Yes, always</button>
          <button className="secondary" onClick={onSaved}>No thanks</button>
        </div>
      </Modal>
    );
  }

  const kindCategories = categories.filter((c) => c.kind === form.type);
  const accountOptions = (exclude) =>
    accounts.filter((a) => String(a.id) !== String(exclude)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>);

  return (
    <Modal onClose={onClose}>
      <form className="quick-add" onSubmit={save}>
        <h2>{isEdit ? 'Edit transaction' : 'Add transaction'}</h2>
        <div className="segmented">
          {TYPES.map(([value, label]) => (
            <button type="button" key={value} className={form.type === value ? `active ${value}` : ''} onClick={() => chooseType(value)}>
              {label}
            </button>
          ))}
        </div>

        <label>
          Amount (₹)
          <input className="amount-input" type="number" inputMode="decimal" step="0.01" min="0" placeholder="0" autoFocus value={form.amount} onChange={set('amount')} />
        </label>

        {form.type !== 'transfer' && (
          <>
            <label>
              {form.type === 'income' ? 'Received from' : 'Paid to'}
              <input list="payee-options" value={form.payee} onChange={set('payee')} placeholder={form.type === 'income' ? 'e.g. Employer' : 'e.g. Swiggy'} />
              <datalist id="payee-options">{payees.map((p) => <option key={p} value={p} />)}</datalist>
            </label>
            <label>
              Category
              <select value={form.categoryId} onChange={(e) => { setCategoryTouched(true); set('categoryId')(e); }}>
                <option value="">{isEdit ? 'Uncategorised' : 'Pick automatically'}</option>
                {kindCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {!categoryTouched && form.categoryId !== '' && <small className="hint">Picked from the payee — change it if it's wrong</small>}
            </label>
          </>
        )}

        <label>
          {form.type === 'transfer' ? 'From account' : form.type === 'income' ? 'Into account' : 'Paid from'}
          <select value={form.accountId} onChange={set('accountId')}>
            <option value="" disabled>Choose an account</option>
            {accountOptions(null)}
          </select>
        </label>
        {form.type === 'transfer' && (
          <label>
            To account
            <select value={form.toAccountId} onChange={set('toAccountId')}>
              <option value="" disabled>Choose an account</option>
              {accountOptions(form.accountId)}
            </select>
          </label>
        )}

        {showMore ? (
          <>
            <label>Date &amp; time<input type="datetime-local" value={form.occurredAt} onChange={set('occurredAt')} /></label>
            <label>Tags<input value={form.tags} onChange={set('tags')} placeholder="e.g. goa-trip, office" /></label>
            <label>Note<input value={form.note} onChange={set('note')} /></label>
          </>
        ) : (
          <button type="button" className="link" onClick={() => setShowMore(true)}>More details (date, tags, note)</button>
        )}

        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="submit">{isEdit ? 'Save changes' : 'Save'}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
```

`client/src/context/QuickAddContext.jsx`:

```jsx
import { createContext, useContext, useState, useCallback } from 'react';
import { useAuth } from './AuthContext.jsx';
import { QuickAdd } from '../components/QuickAdd.jsx';

const QuickAddContext = createContext(null);

export function QuickAddProvider({ children }) {
  const { token } = useAuth();
  const [editing, setEditing] = useState(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const open = useCallback((tx = {}) => setEditing(tx), []);
  const close = useCallback(() => setEditing(null), []);
  const saved = useCallback(() => {
    setEditing(null);
    setVersion((v) => v + 1);
  }, []);

  return (
    <QuickAddContext.Provider value={{ open, version, refresh }}>
      {children}
      {token && editing && <QuickAdd initial={editing} onClose={close} onSaved={saved} />}
    </QuickAddContext.Provider>
  );
}

export function useQuickAdd() {
  const ctx = useContext(QuickAddContext);
  if (!ctx) throw new Error('useQuickAdd must be used within QuickAddProvider');
  return ctx;
}
```

- [ ] **Step 5: Navigation and routes**

`client/src/components/Nav.jsx`:

```jsx
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';

export function Nav() {
  const { user, logout } = useAuth();
  const { open } = useQuickAdd();
  if (!user) return null;
  return (
    <nav className="nav">
      <div className="nav-links">
        <NavLink to="/" end>Home</NavLink>
        <NavLink to="/transactions">Transactions</NavLink>
        <NavLink to="/budgets">Budgets</NavLink>
        <NavLink to="/recurring">Recurring</NavLink>
        <NavLink to="/accounts">Accounts</NavLink>
        <NavLink to="/categories">Categories</NavLink>
      </div>
      <button className="nav-add" onClick={() => open()}>+ Add</button>
      <div className="nav-user">
        <span>{user.email}</span>
        <button className="secondary" onClick={logout}>Log out</button>
      </div>
    </nav>
  );
}
```

`client/src/App.jsx`:

```jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { QuickAddProvider } from './context/QuickAddContext.jsx';
import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { Nav } from './components/Nav.jsx';
import { Login } from './pages/Login.jsx';
import { Register } from './pages/Register.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Transactions } from './pages/Transactions.jsx';
import { Budgets } from './pages/Budgets.jsx';
import { Categories } from './pages/Categories.jsx';
import './App.css';

const guard = (page) => <ProtectedRoute>{page}</ProtectedRoute>;

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <QuickAddProvider>
          <Nav />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/" element={guard(<Dashboard />)} />
            <Route path="/transactions" element={guard(<Transactions />)} />
            <Route path="/budgets" element={guard(<Budgets />)} />
            <Route path="/categories" element={guard(<Categories />)} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </QuickAddProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
```

In `client/src/main.jsx` delete the line `import './index.css'`, then delete `client/src/index.css`, `client/src/pages/Expenses.jsx` and `client/src/components/ExpenseForm.jsx`.

- [ ] **Step 6: Transactions page**

`client/src/pages/Transactions.jsx`:

```jsx
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { CategoryBadge } from '../components/CategoryBadge.jsx';
import { formatDay, formatMoney, signedMoney, timeOf } from '../format.js';

const PAGE_SIZE = 100;
const NO_FILTERS = { q: '', type: '', accountId: '', categoryId: '', tag: '', from: '', to: '' };

function groupByDay(items) {
  const groups = [];
  for (const tx of items) {
    const day = tx.occurred_at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(tx);
    else groups.push({ day, items: [tx] });
  }
  return groups;
}

export function Transactions() {
  const { token } = useAuth();
  const { open, version } = useQuickAdd();
  const [filters, setFilters] = useState(NO_FILTERS);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getAccounts(token), api.getCategories(token), api.getTags(token)])
      .then(([a, c, t]) => {
        setAccounts(a);
        setCategories(c);
        setTags(t);
      })
      .catch((e) => setError(e.message));
  }, [token, version]);

  const load = useCallback(
    (offset = 0) => {
      api.getTransactions(token, { ...filters, limit: PAGE_SIZE, offset })
        .then((page) => {
          setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
          setTotal(page.total);
          setLoaded(true);
        })
        .catch((e) => setError(e.message));
    },
    [token, filters]
  );

  useEffect(() => {
    load(0);
  }, [load, version]);

  const setFilter = (field) => (e) => setFilters((f) => ({ ...f, [field]: e.target.value }));
  const hasFilters = Object.values(filters).some(Boolean);
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? '';
  const categoryOf = (id) => categories.find((c) => c.id === id);
  const title = (tx) =>
    tx.type === 'transfer'
      ? `${accountName(tx.account_id)} → ${accountName(tx.to_account_id)}`
      : tx.payee || tx.note || categoryOf(tx.category_id)?.name || (tx.type === 'income' ? 'Income' : 'Expense');

  const remove = async (tx) => {
    if (!window.confirm(`Delete this ${tx.type} of ${formatMoney(tx.amount)}?`)) return;
    try {
      await api.deleteTransaction(token, tx.id);
      load(0);
    } catch (e) {
      setError(e.message);
    }
  };

  const exportCsv = async () => {
    try {
      const url = URL.createObjectURL(await api.exportCsv(token));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'transactions.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Transactions</h1>
        <button className="secondary" onClick={exportCsv}>Export CSV</button>
      </div>

      <div className="filters">
        <input type="search" placeholder="Search payee or note" value={filters.q} onChange={setFilter('q')} />
        <select value={filters.type} onChange={setFilter('type')}>
          <option value="">All types</option>
          <option value="expense">Expenses</option>
          <option value="income">Income</option>
          <option value="transfer">Transfers</option>
        </select>
        <select value={filters.accountId} onChange={setFilter('accountId')}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={filters.categoryId} onChange={setFilter('categoryId')}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {tags.length > 0 && (
          <select value={filters.tag} onChange={setFilter('tag')}>
            <option value="">All tags</option>
            {tags.map((t) => <option key={t.name} value={t.name}>#{t.name}</option>)}
          </select>
        )}
        <label className="inline">From <input type="date" value={filters.from} onChange={setFilter('from')} /></label>
        <label className="inline">To <input type="date" value={filters.to} onChange={setFilter('to')} /></label>
        {hasFilters && <button className="link" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </div>

      {error && <p className="error">{error}</p>}

      {loaded && items.length === 0 && (
        <div className="empty">
          {hasFilters ? (
            'No transactions match these filters.'
          ) : (
            <>
              <p>Nothing logged yet.</p>
              <button onClick={() => open()}>Add your first transaction</button>
            </>
          )}
        </div>
      )}

      {groupByDay(items).map((group) => (
        <section key={group.day}>
          <h3>{formatDay(group.day)}</h3>
          <ul className="tx-list">
            {group.items.map((tx) => (
              <li key={tx.id} className="tx-row" onClick={() => open(tx)}>
                <div className="tx-main">
                  <span className="tx-title">{title(tx)}</span>
                  <span className="tx-meta">
                    {tx.type !== 'transfer' && <CategoryBadge category={categoryOf(tx.category_id)} />}
                    {tx.type !== 'transfer' && <span>{accountName(tx.account_id)}</span>}
                    {timeOf(tx.occurred_at) && <span>{timeOf(tx.occurred_at)}</span>}
                    {tx.recurring_id !== null && <span title="Added by a repeating item">↻ repeating</span>}
                    {tx.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
                  </span>
                </div>
                <span className={`amount ${tx.type}`}>{signedMoney(tx)}</span>
                <button className="icon" aria-label="Delete" onClick={(e) => { e.stopPropagation(); remove(tx); }}>×</button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {items.length < total && (
        <button className="secondary load-more" onClick={() => load(items.length)}>
          Show more ({total - items.length} older)
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Styles**

`client/src/App.css` (replace whole file):

```css
:root {
  --bg: #f6f7fb;
  --card: #ffffff;
  --text: #1f2333;
  --muted: #6b7185;
  --border: #e3e6ef;
  --primary: #3b6ef5;
  --primary-dark: #2c58d6;
  --income: #15803d;
  --danger: #d93025;
  --radius: 10px;
}

* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }
h1 { font-size: 1.5rem; margin: 0 0 1rem; }
h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
h3 { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 1.25rem 0 .5rem; }

/* Navigation */
.nav { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; background: #1b1f33; color: #fff; padding: .6rem 1.25rem; }
.nav-links { display: flex; gap: .25rem; flex: 1; flex-wrap: wrap; }
.nav-links a { color: #c9cdf2; text-decoration: none; padding: .4rem .7rem; border-radius: 6px; }
.nav-links a.active { background: rgba(255, 255, 255, .12); color: #fff; }
.nav-add { font-weight: 600; padding: .45rem 1rem; }
.nav-user { display: flex; align-items: center; gap: .75rem; font-size: .85rem; color: #c9cdf2; }

/* Layout */
.page { max-width: 880px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
.page-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1rem; }
.page-header h1 { margin: 0; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem 1.25rem; margin-bottom: 1rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
.row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.row.spread { justify-content: space-between; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: .75rem; align-items: end; }

/* Controls */
input, select, button { font: inherit; padding: .5rem .65rem; border-radius: 6px; border: 1px solid var(--border); background: #fff; color: var(--text); }
button { background: var(--primary); border-color: var(--primary); color: #fff; cursor: pointer; }
button:hover { background: var(--primary-dark); }
button:disabled { opacity: .5; cursor: not-allowed; }
button.secondary { background: #fff; color: var(--text); border-color: var(--border); }
button.secondary:hover { background: #f0f2f8; }
button.danger { background: #fff; color: var(--danger); border-color: #f3c4c0; }
button.link { background: none; border: none; color: var(--primary); padding: 0; text-decoration: underline; align-self: flex-start; }
button.icon { background: none; border: none; color: var(--muted); font-size: 1.2rem; padding: 0 .4rem; }
button.icon:hover { color: var(--danger); }
label { display: flex; flex-direction: column; gap: .3rem; font-size: .85rem; color: var(--muted); }
label.inline { flex-direction: row; align-items: center; gap: .35rem; }
.error { color: var(--danger); }
.hint { color: var(--muted); font-size: .8rem; }
.empty { text-align: center; color: var(--muted); padding: 2.5rem 1rem; background: var(--card); border: 1px dashed var(--border); border-radius: var(--radius); }
.load-more { display: block; margin: 1rem auto; }

/* Quick Add modal */
.modal-backdrop { position: fixed; inset: 0; z-index: 10; display: flex; align-items: flex-start; justify-content: center; padding: 6vh 1rem; overflow-y: auto; background: rgba(15, 18, 35, .45); }
.modal { width: 100%; max-width: 440px; background: #fff; border-radius: 14px; padding: 1.25rem 1.5rem 1.5rem; box-shadow: 0 20px 50px rgba(0, 0, 0, .2); }
.quick-add { display: flex; flex-direction: column; gap: .85rem; }
.amount-input { font-size: 1.8rem; font-weight: 600; }
.segmented { display: flex; padding: 3px; border-radius: 8px; background: #eef0f6; }
.segmented button { flex: 1; background: none; border: none; color: var(--muted); }
.segmented button:hover { background: none; color: var(--text); }
.segmented button.active { background: #fff; color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }
.segmented button.active.income { color: var(--income); }
fieldset.choices { border: none; padding: 0; margin: .75rem 0; display: flex; flex-direction: column; gap: .5rem; }
.choice { flex-direction: row; align-items: center; gap: .5rem; color: var(--text); font-size: .9rem; }

/* Transaction list */
.filters { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
.filters input[type="search"] { flex: 1 1 200px; }
.tx-list { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); }
.tx-row { display: flex; align-items: center; gap: .75rem; padding: .7rem 1rem; border-bottom: 1px solid var(--border); cursor: pointer; }
.tx-row:last-child { border-bottom: none; }
.tx-row:hover { background: #fafbff; }
.tx-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .2rem; }
.tx-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx-meta { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; font-size: .8rem; color: var(--muted); }
.amount { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.amount.income { color: var(--income); }
.amount.transfer { color: var(--muted); }
.amount.negative { color: var(--danger); }
.badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; color: #fff; font-size: .75rem; }
.badge-none { background: #a3a8b8; }
.tag { color: var(--primary); }
.pill { font-size: .75rem; padding: .1rem .5rem; border-radius: 999px; background: #eef0f6; color: var(--muted); }

/* Dashboard, lists, budgets */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; }
.stat span { display: block; font-size: .8rem; color: var(--muted); }
.stat strong { display: block; font-size: 1.5rem; font-variant-numeric: tabular-nums; }
.stat small { color: var(--muted); }
.list { list-style: none; margin: 0; padding: 0; }
.list li { display: flex; align-items: center; gap: .75rem; padding: .6rem 0; border-bottom: 1px solid var(--border); }
.list li:last-child { border-bottom: none; }
.grow { flex: 1; min-width: 0; }
.banner { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1rem; padding: .75rem 1rem; border-radius: var(--radius); background: #fff4e5; border: 1px solid #f5c98b; }
.banner.danger { background: #fdecea; border-color: #f3b6b0; }
.meter { height: 6px; margin: .4rem 0 .2rem; overflow: hidden; border-radius: 999px; background: #eef0f6; }
.meter-fill { height: 100%; background: var(--primary); }
.meter-fill.over { background: var(--danger); }

/* Auth */
.auth-page { max-width: 360px; margin: 4rem auto; padding: 2rem; background: #fff; border: 1px solid var(--border); border-radius: var(--radius); }
.auth-page form { display: flex; flex-direction: column; gap: .75rem; }
```

- [ ] **Step 8: Build**

Run: `cd client && npx vite build`
Expected: `✓ built` with no errors (the >500 kB chunk warning is expected).

- [ ] **Step 9: Manual check**

Start the API (`cd server && node index.js`) and client (`cd client && npx vite --port 5173`), open http://localhost:5173, register a fresh user and check:
- "+ Add" in the nav opens the modal from any page; Esc and clicking outside close it.
- Typing `Swiggy` as payee shows **Food & Dining** with "Picked from the payee"; saving lists it under **Today** as `−₹…`.
- Income shows green `+₹…`; a transfer between two accounts shows `Cash → …` in grey (create the second account later in Task 10, or via `curl`).
- Clicking a row opens it for editing; changing the category of a payee without a rule offers "Remember this?".
- Filters narrow the list; "Clear filters" resets; Export CSV downloads `transactions.csv`.

- [ ] **Step 10: Commit**

```bash
git add -A client
git commit -m "$(printf 'Add Quick Add modal, navigation and Transactions page\n\nKasturi25n')"
```

---

### Task 10: Home dashboard, Accounts and Recurring pages

**Files:**
- Modify: `client/src/pages/Dashboard.jsx` (whole file)
- Create: `client/src/pages/Accounts.jsx`, `client/src/pages/Recurring.jsx`
- Modify: `client/src/App.jsx` (two routes)

**Interfaces:**
- Consumes: `api.*`, `format.js` helpers, `useQuickAdd()` (Task 9).

- [ ] **Step 1: Dashboard**

`client/src/pages/Dashboard.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend, ResponsiveContainer } from 'recharts';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { formatMoney, formatShortDate, monthRange } from '../format.js';

export function Dashboard() {
  const { token } = useAuth();
  const { open, version } = useQuickAdd();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const months = [-5, -4, -3, -2, -1, 0].map(monthRange);
    const current = months[months.length - 1];
    Promise.all([
      Promise.all(months.map((m) => api.getSummary(token, m.from, m.to))),
      api.getCategories(token),
      api.getRecurring(token),
      api.getUpcoming(token, 7),
      api.getBudgetStatus(token, current.from.slice(0, 7)),
      api.getTransactions(token, { limit: 1 }),
    ])
      .then(([history, categories, recurring, upcoming, budgets, anyTx]) =>
        setData({
          summary: history[history.length - 1],
          history: history.map((h, i) => ({ month: months[i].label, 'Money in': h.income, 'Money out': h.expense })),
          categories,
          pending: recurring.pending,
          upcoming,
          budgets,
          hasTransactions: anyTx.total > 0,
        })
      )
      .catch((e) => setError(e.message));
  }, [token, version]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!data) return <div className="page"><p className="hint">Loading…</p></div>;

  const { summary, history, categories, pending, upcoming, budgets, hasTransactions } = data;
  if (!hasTransactions) {
    return (
      <div className="page">
        <h1>Welcome</h1>
        <div className="empty">
          <p>Your home screen fills up as you log money in and out.</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button onClick={() => open()}>Add your first transaction</button>
            <Link to="/accounts">Set up your bank and card accounts</Link>
          </div>
        </div>
      </div>
    );
  }

  const categoryOf = (id) => categories.find((c) => c.id === id);
  const pieData = summary.byCategory.map((b) => ({
    name: categoryOf(b.categoryId)?.name ?? 'Uncategorised',
    value: b.total,
    color: categoryOf(b.categoryId)?.color ?? '#a3a8b8',
  }));
  const savingsRate = summary.income > 0 ? Math.round((summary.net / summary.income) * 100) : null;
  const overBudget = budgets.filter((b) => b.overBudget);
  const totalBalance = summary.accounts.reduce((sum, a) => sum + a.balance, 0);

  return (
    <div className="page">
      <h1>This month</h1>

      {pending.length > 0 && (
        <div className="banner">
          <span>{pending.length === 1 ? '1 bill is' : `${pending.length} bills are`} waiting for you to confirm the amount.</span>
          <Link to="/recurring">Review</Link>
        </div>
      )}
      {overBudget.map((b) => (
        <div key={b.id} className="banner danger">
          <span>
            Over budget in {b.category_id === null ? 'total spending' : categoryOf(b.category_id)?.name}: {formatMoney(b.spent)} of {formatMoney(b.amount)}
          </span>
          <Link to="/budgets">Budgets</Link>
        </div>
      ))}

      <div className="stats">
        <div className="stat"><span>Money in</span><strong className="amount income">{formatMoney(summary.income)}</strong></div>
        <div className="stat"><span>Money out</span><strong>{formatMoney(summary.expense)}</strong></div>
        <div className="stat">
          <span>{summary.net >= 0 ? 'Saved' : 'Overspent'}</span>
          <strong className={summary.net < 0 ? 'amount negative' : ''}>{formatMoney(Math.abs(summary.net))}</strong>
          {savingsRate !== null && <small>{savingsRate}% of what came in</small>}
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Where it went</h2>
          {pieData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95}>
                  {pieData.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v) => formatMoney(v)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="hint">No spending logged this month yet.</p>
          )}
        </div>
        <div className="card">
          <h2>Last 6 months</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={history}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" />
              <YAxis tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} width={50} />
              <Tooltip formatter={(v) => formatMoney(v)} />
              <Legend />
              <Bar dataKey="Money in" fill="#15803d" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Money out" fill="#3b6ef5" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Accounts</h2>
          <ul className="list">
            {summary.accounts.map((a) => (
              <li key={a.id}>
                <span className="grow">{a.name}</span>
                <span className={`amount ${a.balance < 0 ? 'negative' : ''}`}>{formatMoney(a.balance)}</span>
              </li>
            ))}
          </ul>
          <p className="hint">Total across accounts: {formatMoney(totalBalance)}</p>
        </div>
        <div className="card">
          <h2>Coming up in 7 days</h2>
          {upcoming.length ? (
            <ul className="list">
              {upcoming.map((u) => (
                <li key={`${u.ruleId}-${u.date}`}>
                  <span className="grow">{u.payee || 'Repeating item'}</span>
                  <span className="hint">{formatShortDate(u.date)}</span>
                  <span className={`amount ${u.type}`}>{formatMoney(u.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              Nothing due. <Link to="/recurring">Add rent, salary or subscriptions</Link> so they log themselves.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Accounts page**

`client/src/pages/Accounts.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { formatMoney } from '../format.js';

const TYPE_LABELS = { cash: 'Cash', bank: 'Bank / UPI', credit_card: 'Credit card', wallet: 'Wallet' };
const EMPTY = { name: '', type: 'bank', balance: '' };

// Credit cards are entered as "amount you owe" and stored as a negative balance.
const toOpeningBalance = (type, value) => {
  const n = parseFloat(value) || 0;
  return type === 'credit_card' ? -Math.abs(n) : n;
};

export function Accounts() {
  const { token } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.getAccounts(token).then(setAccounts).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [token]);

  const run = async (fn) => {
    setError('');
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };

  const add = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setError('Give the account a name');
    run(async () => {
      await api.createAccount(token, { name: form.name, type: form.type, openingBalance: toOpeningBalance(form.type, form.balance) });
      setForm(EMPTY);
    });
  };

  const update = (a, changes) =>
    run(() => api.updateAccount(token, a.id, { name: a.name, type: a.type, openingBalance: a.opening_balance, archived: Boolean(a.archived), ...changes }));

  const saveEdit = async () => {
    const ok = await update(editing, { name: editing.name, openingBalance: Number(editing.opening_balance) || 0 });
    if (ok) setEditing(null);
  };

  const remove = (a) => {
    if (window.confirm(`Delete "${a.name}"? This can't be undone.`)) run(() => api.deleteAccount(token, a.id));
  };

  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);
  const total = active.reduce((sum, a) => sum + a.balance, 0);

  const row = (a) =>
    editing?.id === a.id ? (
      <li key={a.id}>
        <input className="grow" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        <label className="inline">
          Starting balance
          <input type="number" step="0.01" value={editing.opening_balance} onChange={(e) => setEditing({ ...editing, opening_balance: e.target.value })} />
        </label>
        <button onClick={saveEdit}>Save</button>
        <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
      </li>
    ) : (
      <li key={a.id}>
        <span className="grow">
          <strong>{a.name}</strong> <span className="pill">{TYPE_LABELS[a.type]}</span>
        </span>
        <span className={`amount ${a.balance < 0 ? 'negative' : ''}`}>
          {a.type === 'credit_card' && a.balance < 0 ? `You owe ${formatMoney(-a.balance)}` : formatMoney(a.balance)}
        </span>
        <button className="secondary" onClick={() => setEditing({ ...a })}>Edit</button>
        <button className="secondary" onClick={() => update(a, { archived: !a.archived })}>{a.archived ? 'Restore' : 'Archive'}</button>
        <button className="danger" onClick={() => remove(a)}>Delete</button>
      </li>
    );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Accounts</h1>
        <span className="hint">Total balance <strong>{formatMoney(total)}</strong></span>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <ul className="list">{active.map(row)}</ul>
      </div>

      <form className="card" onSubmit={add}>
        <h2>Add an account</h2>
        <div className="form-grid">
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. HDFC Savings" /></label>
          <label>
            Type
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            {form.type === 'credit_card' ? 'Amount you owe today (₹)' : 'Balance today (₹)'}
            <input type="number" step="0.01" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} placeholder="0" />
          </label>
          <button type="submit">Add account</button>
        </div>
        <p className="hint">
          Paying a credit card bill? Log it as a <strong>Transfer</strong> from your bank to the card — the spending was already counted when you used the card.
        </p>
      </form>

      {archived.length > 0 && (
        <div className="card">
          <h2>Archived</h2>
          <p className="hint">Hidden when adding transactions. History and balances are kept.</p>
          <ul className="list">{archived.map(row)}</ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Recurring page**

`client/src/pages/Recurring.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { formatMoney, formatShortDate, todayStr } from '../format.js';

const FREQUENCIES = { weekly: 'Every week', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year' };
const TYPES = [['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']];

const blank = (accountId) => ({
  type: 'expense', amount: '', payee: '', categoryId: '', accountId: accountId ?? '', toAccountId: '',
  frequency: 'monthly', nextDate: todayStr(), endDate: '', mode: 'auto',
});

const ruleToForm = (r) => ({
  id: r.id, active: r.active, type: r.type, amount: String(r.amount), payee: r.payee, categoryId: r.category_id ?? '',
  accountId: r.account_id, toAccountId: r.to_account_id ?? '', frequency: r.frequency, nextDate: r.next_date,
  endDate: r.end_date ?? '', mode: r.mode,
});

const toBody = (f) => ({
  type: f.type,
  amount: parseFloat(f.amount),
  payee: f.type === 'transfer' ? '' : f.payee.trim(),
  accountId: Number(f.accountId),
  toAccountId: f.type === 'transfer' ? Number(f.toAccountId) : null,
  categoryId: f.type === 'transfer' || !f.categoryId ? null : Number(f.categoryId),
  frequency: f.frequency,
  nextDate: f.nextDate,
  endDate: f.endDate || null,
  mode: f.mode,
});

const keyOf = (o) => `${o.ruleId}-${o.date}`;

export function Recurring() {
  const { token } = useAuth();
  const { refresh } = useQuickAdd();
  const [rules, setRules] = useState([]);
  const [pending, setPending] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(null);
  const [amounts, setAmounts] = useState({});
  const [error, setError] = useState('');

  const load = () =>
    Promise.all([api.getRecurring(token), api.getUpcoming(token, 7), api.getAccounts(token), api.getCategories(token)])
      .then(([r, u, a, c]) => {
        setRules(r.rules);
        setPending(r.pending);
        setUpcoming(u);
        setAccounts(a);
        setCategories(c);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [token]);

  const run = async (fn) => {
    setError('');
    try {
      await fn();
      await load();
      refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? '';
  const categoryName = (id) => categories.find((c) => c.id === id)?.name;
  const describe = (r) =>
    r.type === 'transfer' ? `${accountName(r.account_id)} → ${accountName(r.to_account_id)}` : r.payee || categoryName(r.category_id) || 'Repeating item';
  const status = (r) => {
    if (r.active) return `next ${formatShortDate(r.next_date)}`;
    return r.end_date && r.next_date > r.end_date ? 'ended' : 'paused';
  };
  const activeAccounts = accounts.filter((a) => !a.archived || (form && (a.id === form.accountId || a.id === form.toAccountId)));

  const save = async (e) => {
    e.preventDefault();
    if (!(parseFloat(form.amount) > 0)) return setError('Enter an amount greater than 0');
    if (!form.accountId) return setError('Pick an account');
    const body = toBody(form);
    const ok = await run(() => (form.id ? api.updateRecurring(token, form.id, { ...body, active: Boolean(form.active) }) : api.createRecurring(token, body)));
    if (ok) setForm(null);
  };

  const toggle = (r) => run(() => api.updateRecurring(token, r.id, { ...toBody(ruleToForm(r)), active: !r.active }));
  const remove = (r) => {
    if (window.confirm(`Stop repeating "${describe(r)}"? Transactions already added stay.`)) run(() => api.deleteRecurring(token, r.id));
  };
  const confirm = (p) => run(() => api.confirmRecurring(token, p.ruleId, { amount: parseFloat(amounts[keyOf(p)] ?? p.amount) }));
  const skip = (p) => run(() => api.skipRecurring(token, p.ruleId));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Recurring</h1>
        {!form && <button onClick={() => setForm(blank(accounts.find((a) => !a.archived)?.id))}>+ New repeating item</button>}
      </div>
      {error && <p className="error">{error}</p>}

      {form && (
        <form className="card" onSubmit={save}>
          <h2>{form.id ? 'Edit repeating item' : 'New repeating item'}</h2>
          <div className="segmented">
            {TYPES.map(([value, label]) => (
              <button type="button" key={value} className={form.type === value ? `active ${value}` : ''} onClick={() => setForm({ ...form, type: value, categoryId: '' })}>
                {label}
              </button>
            ))}
          </div>
          <div className="form-grid" style={{ marginTop: '.75rem' }}>
            <label>Amount (₹)<input type="number" step="0.01" value={form.amount} onChange={set('amount')} /></label>
            {form.type !== 'transfer' && (
              <label>
                {form.type === 'income' ? 'Received from' : 'Paid to'}
                <input value={form.payee} onChange={set('payee')} placeholder={form.type === 'income' ? 'e.g. Employer' : 'e.g. Landlord'} />
              </label>
            )}
            {form.type !== 'transfer' && (
              <label>
                Category
                <select value={form.categoryId} onChange={set('categoryId')}>
                  <option value="">Uncategorised</option>
                  {categories.filter((c) => c.kind === form.type).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label>
              {form.type === 'transfer' ? 'From account' : 'Account'}
              <select value={form.accountId} onChange={set('accountId')}>
                <option value="" disabled>Choose</option>
                {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            {form.type === 'transfer' && (
              <label>
                To account
                <select value={form.toAccountId} onChange={set('toAccountId')}>
                  <option value="" disabled>Choose</option>
                  {activeAccounts.filter((a) => a.id !== Number(form.accountId)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
            <label>
              Repeats
              <select value={form.frequency} onChange={set('frequency')}>
                {Object.entries(FREQUENCIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>Next date<input type="date" value={form.nextDate} onChange={set('nextDate')} /></label>
            <label>Ends on (optional)<input type="date" value={form.endDate} onChange={set('endDate')} /></label>
          </div>
          {form.mode === 'auto' && form.nextDate < todayStr() && (
            <p className="hint">Dates before today will be added straight away.</p>
          )}
          <fieldset className="choices">
            <label className="choice">
              <input type="radio" checked={form.mode === 'auto'} onChange={() => setForm({ ...form, mode: 'auto' })} />
              Add it automatically <span className="hint">— same amount every time (rent, salary, SIP, Netflix)</span>
            </label>
            <label className="choice">
              <input type="radio" checked={form.mode === 'confirm'} onChange={() => setForm({ ...form, mode: 'confirm' })} />
              Ask me to confirm the amount <span className="hint">— bills that change (electricity, phone)</span>
            </label>
          </fieldset>
          <div className="row">
            <button type="submit">{form.id ? 'Save changes' : 'Save'}</button>
            <button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      {pending.length > 0 && (
        <div className="card">
          <h2>Waiting for you</h2>
          <p className="hint">These bills change each time. Check the amount, then confirm.</p>
          <ul className="list">
            {pending.map((p, i) => {
              const isNext = pending.findIndex((x) => x.ruleId === p.ruleId) === i;
              return (
                <li key={keyOf(p)}>
                  <span className="grow">
                    {describe(p)} <span className="hint">due {formatShortDate(p.date)}</span>
                  </span>
                  <input type="number" step="0.01" style={{ width: '8rem' }} disabled={!isNext}
                    value={amounts[keyOf(p)] ?? p.amount} onChange={(e) => setAmounts({ ...amounts, [keyOf(p)]: e.target.value })} />
                  <button disabled={!isNext} onClick={() => confirm(p)}>Confirm</button>
                  <button className="secondary" disabled={!isNext} onClick={() => skip(p)}>Skip</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Next 7 days</h2>
        {upcoming.length ? (
          <ul className="list">
            {upcoming.map((u) => (
              <li key={keyOf(u)}>
                <span className="grow">{describe(u)}</span>
                <span className="hint">{formatShortDate(u.date)} · {u.mode === 'auto' ? 'adds itself' : 'asks you'}</span>
                <span className={`amount ${u.type}`}>{formatMoney(u.amount)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Nothing due in the next 7 days.</p>
        )}
      </div>

      <div className="card">
        <h2>All repeating items</h2>
        {rules.length ? (
          <ul className="list">
            {rules.map((r) => (
              <li key={r.id}>
                <span className="grow">
                  <strong>{describe(r)}</strong>
                  <br />
                  <span className="hint">
                    {FREQUENCIES[r.frequency]} · {status(r)} · {r.mode === 'auto' ? 'adds itself' : 'asks you to confirm'}
                  </span>
                </span>
                <span className={`amount ${r.type}`}>{formatMoney(r.amount)}</span>
                <button className="secondary" onClick={() => setForm(ruleToForm(r))}>Edit</button>
                <button className="secondary" onClick={() => toggle(r)}>{r.active ? 'Pause' : 'Resume'}</button>
                <button className="danger" onClick={() => remove(r)}>Delete</button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">No repeating items yet. Add your rent, salary, SIPs or subscriptions so they log themselves.</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the routes**

In `client/src/App.jsx` add

```jsx
import { Accounts } from './pages/Accounts.jsx';
import { Recurring } from './pages/Recurring.jsx';
```

and, after the `/budgets` route:

```jsx
            <Route path="/recurring" element={guard(<Recurring />)} />
            <Route path="/accounts" element={guard(<Accounts />)} />
```

- [ ] **Step 5: Build**

Run: `cd client && npx vite build`
Expected: `✓ built`, no errors.

- [ ] **Step 6: Manual check**

With both servers running, as a fresh user:
- Home shows the welcome empty state; after one transaction it shows Money in / Money out / Saved, both charts, accounts and "Coming up".
- Accounts: add "HDFC" (Bank, 10000) and "ICICI Card" (Credit card, owe 12000 → shows "You owe ₹12,000.00"); archive and restore one; deleting Cash after using it shows the "Archive it instead" message.
- Recurring: add rent (auto, next date 2 months ago) → two or three rent transactions appear on Transactions marked "↻ repeating"; add electricity (confirm, next date last week) → appears under "Waiting for you"; confirm with a new amount → it moves to Transactions and Home's banner disappears; Pause then Resume does not add the skipped months.

- [ ] **Step 7: Commit**

```bash
git add client
git commit -m "$(printf 'Add home dashboard, Accounts and Recurring pages\n\nKasturi25n')"
```

---

### Task 11: Categories & rules page, Budgets polish, README, final verification

**Files:**
- Modify: `client/src/pages/Categories.jsx` (whole file), `client/src/pages/Budgets.jsx` (whole file), `README.md`

**Interfaces:**
- Consumes: `api.getRules/createRule/deleteRule`, category `kind` (Tasks 2–3, 9).

- [ ] **Step 1: Categories and rules**

`client/src/pages/Categories.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';

export function Categories() {
  const { token } = useAuth();
  const [categories, setCategories] = useState([]);
  const [rules, setRules] = useState([]);
  const [form, setForm] = useState({ name: '', color: '#3b6ef5', kind: 'expense' });
  const [editing, setEditing] = useState(null);
  const [ruleForm, setRuleForm] = useState({ matchText: '', categoryId: '' });
  const [error, setError] = useState('');

  const load = () =>
    Promise.all([api.getCategories(token), api.getRules(token)])
      .then(([c, r]) => {
        setCategories(c);
        setRules(r);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [token]);

  const run = async (fn) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const add = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    run(async () => {
      await api.createCategory(token, form);
      setForm({ ...form, name: '' });
    });
  };

  const save = () =>
    run(async () => {
      await api.updateCategory(token, editing.id, { name: editing.name, color: editing.color });
      setEditing(null);
    });

  const remove = (c) => {
    if (window.confirm(`Delete "${c.name}"? Its transactions will become uncategorised.`)) run(() => api.deleteCategory(token, c.id));
  };

  const addRule = (e) => {
    e.preventDefault();
    if (!ruleForm.matchText.trim() || !ruleForm.categoryId) return setError('Enter a word and pick a category');
    run(async () => {
      await api.createRule(token, { matchText: ruleForm.matchText, categoryId: Number(ruleForm.categoryId) });
      setRuleForm({ matchText: '', categoryId: '' });
    });
  };

  const section = (kind, title) => (
    <div className="card">
      <h2>{title}</h2>
      <ul className="list">
        {categories.filter((c) => c.kind === kind).map((c) =>
          editing?.id === c.id ? (
            <li key={c.id}>
              <input className="grow" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <input type="color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
              <button onClick={save}>Save</button>
              <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
            </li>
          ) : (
            <li key={c.id}>
              <span className="grow"><span className="badge" style={{ backgroundColor: c.color }}>{c.name}</span></span>
              <button className="secondary" onClick={() => setEditing({ ...c })}>Edit</button>
              <button className="danger" onClick={() => remove(c)}>Delete</button>
            </li>
          )
        )}
      </ul>
    </div>
  );

  return (
    <div className="page">
      <h1>Categories</h1>
      {error && <p className="error">{error}</p>}

      <form className="card row" onSubmit={add}>
        <input className="grow" placeholder="New category name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          <option value="expense">For spending</option>
          <option value="income">For income</option>
        </select>
        <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
        <button type="submit">Add category</button>
      </form>

      <div className="grid">
        {section('expense', 'Spending')}
        {section('income', 'Income')}
      </div>

      <div className="card">
        <h2>Auto-categorise</h2>
        <p className="hint">When a payee or note contains one of these words, new transactions are filed automatically.</p>
        <form className="row" onSubmit={addRule}>
          <input placeholder='Word, e.g. "chaayos"' value={ruleForm.matchText} onChange={(e) => setRuleForm({ ...ruleForm, matchText: e.target.value })} />
          <span>→</span>
          <select value={ruleForm.categoryId} onChange={(e) => setRuleForm({ ...ruleForm, categoryId: e.target.value })}>
            <option value="">Category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="submit">Add rule</button>
        </form>
        <ul className="list">
          {rules.map((r) => (
            <li key={r.id}>
              <span className="grow">“{r.match_text}” → {r.category_name}</span>
              <button className="icon" aria-label={`Delete rule ${r.match_text}`} onClick={() => run(() => api.deleteRule(token, r.id))}>×</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Budgets with progress bars**

`client/src/pages/Budgets.jsx`:

```jsx
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { formatMoney, todayStr } from '../format.js';

export function Budgets() {
  const { token } = useAuth();
  const [categories, setCategories] = useState([]);
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [status, setStatus] = useState([]);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.getBudgetStatus(token, month).then(setStatus).catch((e) => setError(e.message));
  }, [token, month]);

  useEffect(() => {
    api.getCategories(token).then((c) => setCategories(c.filter((x) => x.kind === 'expense'))).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const categoryName = (id) => (id === null ? 'All spending' : categories.find((c) => c.id === id)?.name ?? 'Deleted category');

  const add = async (e) => {
    e.preventDefault();
    setError('');
    const value = parseFloat(amount);
    if (!(value > 0)) return setError('Enter a budget greater than 0');
    try {
      await api.createBudget(token, { month, amount: value, categoryId: categoryId ? Number(categoryId) : null });
      setAmount('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this budget?')) return;
    await api.deleteBudget(token, id);
    load();
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Budgets</h1>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card">
        {status.length ? (
          <ul className="list">
            {status.map((b) => (
              <li key={b.id}>
                <div className="grow">
                  <div className="row spread">
                    <strong>{categoryName(b.category_id)}</strong>
                    <span className={`amount ${b.overBudget ? 'negative' : ''}`}>{formatMoney(b.spent)} of {formatMoney(b.amount)}</span>
                  </div>
                  <div className="meter">
                    <div className={`meter-fill ${b.overBudget ? 'over' : ''}`} style={{ width: `${Math.min(100, (b.spent / b.amount) * 100)}%` }} />
                  </div>
                  <small className="hint">{b.overBudget ? `Over by ${formatMoney(b.spent - b.amount)}` : `${formatMoney(b.amount - b.spent)} left`}</small>
                </div>
                <button className="icon" aria-label="Remove budget" onClick={() => remove(b.id)}>×</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No budgets for this month yet. Start with your biggest category below.</p>
        )}
      </div>

      <form className="card" onSubmit={add}>
        <h2>Set a budget</h2>
        <div className="form-grid">
          <label>
            Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All spending</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>Limit for the month (₹)<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <button type="submit">Save budget</button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: README**

In `README.md` replace the `## Features` section with:

```markdown
## Features

- **Quick Add** from any page: amount + payee + Save. Category, account and time fill themselves in.
- **Income, expenses and transfers** across accounts (cash, bank/UPI, credit card, wallet) with running balances. Card bill payments are transfers, so they're not double-counted.
- **Auto-categorise rules** (starter rules for Swiggy, Zomato, Uber, Amazon, Netflix, Jio…), plus learning from your past payees.
- **Recurring items** that add themselves (rent, salary, SIP) or wait for you to confirm the amount (electricity).
- **Tags** like `goa-trip`, filters and search, CSV export.
- **Budgets** per category or overall, with progress bars and over-budget warnings.
- **Home** shows this month's money in/out, savings rate, where it went, a 6-month trend, balances and what's coming up.
- Multi-user login (JWT + bcryptjs), self-hosted, no paid APIs.

Existing databases upgrade automatically on first start: old expenses move into a "Cash" account.
```

- [ ] **Step 4: Full verification**

Run: `cd server && npx vitest run`
Expected: PASS — 79 tests.

Run: `cd client && npx vite build`
Expected: `✓ built`, no errors.

Live smoke test (API on :4000 started with `cd server && node index.js`):

```bash
BASE=http://localhost:4000/api
TOKEN=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"smoke$RANDOM@test.com\",\"password\":\"password123\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
CASH=$(curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')
curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"expense\",\"amount\":250,\"occurredAt\":\"2026-10-07T13:00\",\"accountId\":$CASH,\"payee\":\"Swiggy\"}"
curl -s "$BASE/summary?from=2026-10-01&to=2026-10-31" -H "Authorization: Bearer $TOKEN"
```

Expected: the transaction comes back with a non-null `category_id`; the summary shows `"expense":250` and Cash balance `-250`.

Then click through every page as in Task 9 Step 9 and Task 10 Step 6, plus:
- Categories: add an income category; rename and recolour one; add rule "chaayos → Food & Dining", then Quick Add payee "Chaayos" shows Food & Dining.
- Budgets: set ₹100 on Food & Dining; the bar turns red and Home shows the over-budget banner.
- Log out and back in; your data is still there.

Stop the servers and remove any `server/data.db` created only for this check if you started from an empty database.

- [ ] **Step 5: Commit**

```bash
git add client README.md
git commit -m "$(printf 'Add categories with rules, budget progress bars and README update\n\nKasturi25n')"
```

