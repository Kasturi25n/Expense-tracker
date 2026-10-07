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
