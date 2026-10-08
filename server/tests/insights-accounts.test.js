import { describe, it, expect } from 'vitest';
import { insightsEnv, signup, cashId, pick } from './helpers.js';

describe('insights for one account', () => {
  it('limits totals, categories and payees to the chosen account', async () => {
    const env = await insightsEnv();
    const bank = (await env.api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    const food = env.id('Food & Dining');
    env.tx(50000, '2026-10-01', { type: 'income', accountId: bank });
    env.tx(700, '2026-10-05', { categoryId: food, payee: 'Swiggy', accountId: bank });
    env.tx(300, '2026-10-06', { categoryId: food, payee: 'Chai', accountId: env.cash });

    const all = await env.report();
    expect(all.totals).toMatchObject({ income: 50000, expense: 1000 });

    const r = (await env.api.get(`/api/insights?month=2026-10&accountId=${bank}`)).body;
    expect(r.totals).toMatchObject({ income: 50000, expense: 700, net: 49300 });
    expect(r.categories).toEqual([{ categoryId: food, total: 700, previous: 0, average: 0 }]);
    expect(r.topPayees).toEqual([{ payee: 'Swiggy', total: 700, count: 1 }]);
  });

  it('ignores whole-account budgets and the income prompt in a single-account view', async () => {
    const env = await insightsEnv();
    const bank = (await env.api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    await env.api.post('/api/budgets', { month: '2026-10', amount: 1000 });
    env.tx(2000, '2026-10-05', { accountId: bank });
    const r = (await env.api.get(`/api/insights?month=2026-10&accountId=${bank}`)).body;
    expect(r.pace).toMatchObject({ limit: null, limitSource: null });
    expect(pick(r, 'add-income')).toEqual([]);
  });

  it("rejects an account that isn't yours", async () => {
    const env = await insightsEnv();
    const other = await signup(env.app, 'other@example.com');
    const res = await env.api.get(`/api/insights?month=2026-10&accountId=${cashId(env.db, other.userId)}`);
    expect(res.status).toBe(400);
  });
});
