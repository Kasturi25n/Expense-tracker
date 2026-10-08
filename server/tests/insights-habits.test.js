import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('weekend habit', () => {
  it('compares spend per weekend day with weekdays', async () => {
    const env = await insightsEnv();
    env.tx(3000, '2026-10-17T20:00');
    env.tx(3000, '2026-10-10T20:00');
    env.tx(1000, '2026-10-14T20:00');
    const [w] = pick(await env.report(), 'weekends');
    expect(w.tone).toBe('info');
    expect(w.title).toMatch(/^You spend [\d.]+× more per day on weekends$/);
    expect(w.detail).toMatch(/a day on weekends vs .* on weekdays, over the last 90 days\.$/);
  });

  it('ignores repeating items', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/recurring', {
      type: 'expense', amount: 5000, accountId: env.cash, payee: 'Saturday class', frequency: 'weekly', nextDate: '2026-08-01', mode: 'auto',
    });
    env.tx(1000, '2026-10-14T20:00');
    expect(pick(await env.report(), 'weekends')).toEqual([]);
  });
});

describe('late-night habit', () => {
  it('counts timed purchases between 11 pm and 4 am only', async () => {
    const env = await insightsEnv();
    for (const at of ['2026-10-02T23:30', '2026-10-05T01:15', '2026-10-08T02:00']) env.tx(300, at, { payee: 'Swiggy' });
    env.tx(300, '2026-10-09T23:59', { payee: 'Uber' });
    env.tx(300, '2026-10-10', { payee: 'Swiggy' });
    env.tx(300, '2026-10-11T22:59', { payee: 'Swiggy' });
    expect(pick(await env.report(), 'late-nights')).toEqual([
      expect.objectContaining({ tone: 'info', title: '4 late-night purchases this month (₹1,200)', detail: 'Mostly Swiggy, between 11 pm and 4 am.' }),
    ]);
  });

  it('needs at least four', async () => {
    const env = await insightsEnv();
    for (const at of ['2026-10-02T23:30', '2026-10-05T01:15', '2026-10-08T02:00']) env.tx(300, at, { payee: 'Swiggy' });
    expect(pick(await env.report(), 'late-nights')).toEqual([]);
  });
});

describe('savings and income', () => {
  it('asks for income when none is logged, and that is all an empty month says', async () => {
    const env = await insightsEnv();
    expect((await env.report('2026-05')).insights).toEqual([
      expect.objectContaining({
        id: 'add-income', tone: 'info', title: 'How much do you earn?',
        action: { label: 'Add income', to: '/recurring?new=1&type=income&frequency=monthly&nextDate=2026-10-01' },
      }),
    ]);
  });

  it('does not ask for income when a salary is already set up as a repeating item', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/recurring', {
      type: 'income', amount: 80000, accountId: env.cash, payee: 'Acme', frequency: 'monthly', nextDate: '2026-10-30', mode: 'auto',
    });
    env.tx(500, '2026-10-05');
    expect(pick(await env.report(), 'add-income')).toEqual([]);
  });

  it('warns when spending is above income', async () => {
    const env = await insightsEnv();
    env.tx(10000, '2026-10-01', { type: 'income' });
    env.tx(12000, '2026-10-05');
    expect(pick(await env.report(), 'savings')[0]).toMatchObject({
      tone: 'warning', title: 'You spent ₹2,000 more than you earned so far', detail: 'Money in ₹10,000, money out ₹12,000.',
    });
  });

  it('celebrates a good savings rate against recent months', async () => {
    const env = await insightsEnv();
    [['07', 45000], ['08', 40000], ['09', 42500]].forEach(([m, spent]) => {
      env.tx(50000, `2026-${m}-01`, { type: 'income' });
      env.tx(spent, `2026-${m}-10`);
    });
    env.tx(50000, '2026-10-01', { type: 'income' });
    env.tx(38000, '2026-10-10');
    expect(pick(await env.report(), 'savings')[0]).toMatchObject({
      tone: 'good', title: 'You saved 24% of your income so far (₹12,000)', detail: 'Up from 15% on average over the last 3 months.',
    });
  });

  it('rounds the savings rate down so it never claims 100% too early', async () => {
    const env = await insightsEnv();
    env.tx(50000, '2026-10-01', { type: 'income' });
    env.tx(250, '2026-10-05');
    expect(pick(await env.report(), 'savings')[0].title).toBe('You saved 99% of your income so far (₹49,750)');
  });

  it('gives a neutral note for a low rate in a past month', async () => {
    const env = await insightsEnv();
    env.tx(50000, '2026-09-01', { type: 'income' });
    env.tx(46000, '2026-09-10');
    expect(pick(await env.report('2026-09'), 'savings')[0]).toMatchObject({
      tone: 'info', title: 'You saved 8% of your income (₹4,000)', detail: 'Aim to save 20% or more.',
    });
  });
});

describe('ordering', () => {
  it('puts warnings first, then information, then good news', async () => {
    const env = await insightsEnv();
    env.tx(1000, '2026-10-01', { type: 'income' });
    for (let i = 1; i <= 9; i += 1) env.tx(150, `2026-10-0${i}`, { payee: 'Chaayos' });
    for (let i = 10; i <= 12; i += 1) env.tx(150, `2026-10-${i}`, { payee: 'Chaayos' });
    env.tx(3000, '2026-09-05', { categoryId: env.id('Groceries') });
    const tones = (await env.report()).insights.map((i) => i.tone);
    expect(tones).toContain('warning');
    expect(tones).toContain('info');
    expect(tones).toContain('good');
    const rank = { warning: 0, info: 1, good: 2 };
    expect(tones.map((t) => rank[t])).toEqual([...tones.map((t) => rank[t])].sort((a, b) => a - b));
  });
});
