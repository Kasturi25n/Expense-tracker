import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('pace insight', () => {
  it('forecasts without a limit (day 20 of 31)', async () => {
    const env = await insightsEnv();
    env.tx(2000, '2026-10-05T10:00');
    env.tx(2000, '2026-10-15T10:00');
    const r = await env.report();
    expect(r.pace).toEqual({ spentSoFar: 4000, forecast: 6200, limit: null, limitSource: null, safePerDay: null, daysLeft: 12 });
    expect(pick(r, 'pace')).toEqual([expect.objectContaining({ tone: 'info', title: "At this pace you'll spend about ₹6,200 this month" })]);
  });

  it('projects only variable spending and adds upcoming and pending repeating items', async () => {
    const env = await insightsEnv();
    const base = { type: 'expense', accountId: env.cash, frequency: 'monthly', mode: 'auto' };
    await env.api.post('/api/recurring', { ...base, amount: 3000, payee: 'SIP', nextDate: '2026-10-05' });
    await env.api.post('/api/recurring', { ...base, amount: 10000, payee: 'Landlord', nextDate: '2026-10-25' });
    await env.api.post('/api/recurring', { ...base, amount: 1500, payee: 'BESCOM', nextDate: '2026-10-15', mode: 'confirm' });
    env.tx(2000, '2026-10-10T10:00');
    const r = await env.report();
    expect(r.pace).toMatchObject({ spentSoFar: 5000, forecast: 17600 });
  });

  it('warns when the forecast passes the overall budget', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/budgets', { month: '2026-10', amount: 10000 });
    env.tx(4000, '2026-10-05T10:00');
    env.tx(4000, '2026-10-12T10:00');
    const r = await env.report();
    expect(r.pace).toMatchObject({ forecast: 12400, limit: 10000, limitSource: 'budget', safePerDay: 166.67 });
    expect(pick(r, 'pace')[0]).toMatchObject({
      tone: 'warning',
      title: "At this pace you'll spend ₹12,400 this month",
      detail: "That's ₹2,400 over your ₹10,000 budget. Try to keep to ₹167 a day for the next 12 days.",
    });
  });

  it('says when the limit is already used up', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/budgets', { month: '2026-10', amount: 5000 });
    env.tx(6000, '2026-10-05T10:00');
    expect(pick(await env.report(), 'pace')[0]).toMatchObject({
      tone: 'warning', title: "You've used up your ₹5,000 budget", detail: 'Spent ₹6,000 with 12 days to go.',
    });
  });

  it('uses income as the limit when there are no budgets', async () => {
    const env = await insightsEnv();
    env.tx(50000, '2026-10-01', { type: 'income' });
    env.tx(4000, '2026-10-05T10:00');
    const r = await env.report();
    expect(r.pace).toMatchObject({ limit: 50000, limitSource: 'income', safePerDay: 3833.33 });
    expect(pick(r, 'pace')[0]).toMatchObject({
      tone: 'good', title: 'On track: about ₹6,200 this month', detail: 'You can spend ₹3,833 a day for the next 12 days.',
    });
  });

  it('warns when a category is heading over its budget', async () => {
    const env = await insightsEnv();
    const food = env.id('Food & Dining');
    await env.api.post('/api/budgets', { month: '2026-10', amount: 3000, categoryId: food });
    env.tx(2000, '2026-10-08T13:00', { categoryId: food });
    expect(pick(await env.report(), 'pace-category')).toEqual([
      expect.objectContaining({
        id: `pace-category:${food}`, tone: 'warning',
        title: 'Food & Dining is heading for ₹3,100',
        detail: 'Its budget is ₹3,000, with ₹1,000 left for 12 days.',
      }),
    ]);
  });

  it('mentions bills still due when they use up the limit', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/budgets', { month: '2026-10', amount: 5000 });
    await env.api.post('/api/recurring', {
      type: 'expense', amount: 3000, accountId: env.cash, payee: 'Landlord', frequency: 'monthly', nextDate: '2026-10-25', mode: 'auto',
    });
    env.tx(3000, '2026-10-05T10:00');
    expect(pick(await env.report(), 'pace')[0]).toMatchObject({
      tone: 'warning',
      title: "You've used up your ₹5,000 budget",
      detail: 'Spent ₹3,000 plus ₹3,000 in bills still due, with 12 days to go.',
    });
  });

  it('says nothing about pace when there is nothing to project', async () => {
    const env = await insightsEnv();
    const r = await env.report();
    expect(r.pace).toBeNull();
    expect(r.insights.map((i) => i.id)).toEqual(['add-income']);
  });

  it('stays quiet before day 3 and for past months', async () => {
    const env = await insightsEnv('2026-10-02');
    env.tx(500, '2026-10-01T10:00');
    expect((await env.report()).pace).toBeNull();
    expect(pick(await env.report(), 'pace')).toEqual([]);
    expect((await env.report('2026-09')).pace).toBeNull();
  });
});
