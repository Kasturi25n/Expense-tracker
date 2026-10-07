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
