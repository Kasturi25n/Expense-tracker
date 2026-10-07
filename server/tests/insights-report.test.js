import { describe, it, expect } from 'vitest';
import { insightsEnv, signup, addTx } from './helpers.js';

describe('insights report', () => {
  it('returns totals, a categories table and top payees for the month', async () => {
    const env = await insightsEnv();
    const food = env.id('Food & Dining');
    const transport = env.id('Transport');
    env.tx(50000, '2026-10-01', { type: 'income' });
    env.tx(500, '2026-10-02T13:00', { categoryId: food, payee: 'Swiggy' });
    env.tx(300, '2026-10-05T20:00', { categoryId: food, payee: 'swiggy' });
    env.tx(200, '2026-10-06T09:00', { categoryId: transport, payee: 'Uber' });
    env.tx(1000, '2026-09-10', { categoryId: food });
    env.tx(100, '2026-09-11', { categoryId: transport });
    env.tx(600, '2026-08-10', { categoryId: food });
    env.tx(1400, '2026-07-10', { categoryId: food });

    const r = await env.report();
    expect(r).toMatchObject({ month: '2026-10', isCurrentMonth: true });
    expect(r.totals).toEqual({
      income: 50000, expense: 1000, net: 49000, expectedIncome: 50000,
      previous: { income: 0, expense: 1100, net: -1100 },
    });
    expect(r.categories).toEqual([
      { categoryId: food, total: 800, previous: 1000, average: 1000 },
      { categoryId: transport, total: 200, previous: 100, average: 33.33 },
    ]);
    expect(r.topPayees).toEqual([
      { payee: 'swiggy', total: 800, count: 2 },
      { payee: 'Uber', total: 200, count: 1 },
    ]);
  });

  it('compares the current month with the same days of last month', async () => {
    const env = await insightsEnv();
    const food = env.id('Food & Dining');
    env.tx(1000, '2026-09-10', { categoryId: food });
    env.tx(9000, '2026-09-25', { categoryId: food });
    env.tx(800, '2026-10-05', { categoryId: food });
    const r = await env.report();
    expect(r.totals.previous.expense).toBe(1000);
    expect(r.categories).toEqual([{ categoryId: food, total: 800, previous: 1000, average: 3333.33 }]);
    expect((await env.report('2026-09')).totals.previous.expense).toBe(0);
  });

  it('includes expected income from repeating items', async () => {
    const env = await insightsEnv();
    env.tx(5000, '2026-10-02', { type: 'income' });
    await env.api.post('/api/recurring', {
      type: 'income', amount: 80000, accountId: env.cash, payee: 'Acme', frequency: 'monthly', nextDate: '2026-10-30', mode: 'auto',
    });
    expect((await env.report()).totals.expectedIncome).toBe(85000);
  });

  it('rejects an invalid month', async () => {
    const env = await insightsEnv();
    expect((await env.api.get('/api/insights?month=2026-13')).status).toBe(400);
    expect((await env.api.get('/api/insights?month=oct')).status).toBe(400);
  });

  it("never includes another user's transactions", async () => {
    const env = await insightsEnv();
    const other = await signup(env.app, 'other@example.com');
    addTx(env.db, other.userId, { amount: 9999, occurredAt: '2026-10-05', payee: 'Secret' });
    const r = await env.report();
    expect(r.totals.expense).toBe(0);
    expect(r.topPayees).toEqual([]);
  });

  it('handles an empty month calmly', async () => {
    const env = await insightsEnv();
    const r = await env.report('2026-05');
    expect(r).toMatchObject({
      month: '2026-05', isCurrentMonth: false, pace: null, categories: [], topPayees: [],
      totals: { income: 0, expense: 0, net: 0, previous: { income: 0, expense: 0, net: 0 } },
    });
  });
});
