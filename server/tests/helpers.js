import request from 'supertest';
import { createDb } from '../db.js';
import { createApp } from '../app.js';

export function freshApp(options = {}) {
  const db = createDb(':memory:');
  return { app: createApp(db, 'test-secret', options), db };
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
