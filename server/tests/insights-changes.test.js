import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('category change insights', () => {
  it('compares like-for-like days and names the payee behind a rise', async () => {
    const env = await insightsEnv();
    const food = env.id('Food & Dining');
    const fun = env.id('Entertainment');
    env.tx(500, '2026-09-05', { categoryId: food, payee: 'Swiggy' });
    env.tx(500, '2026-09-10', { categoryId: food, payee: 'Dominos' });
    env.tx(5000, '2026-09-25', { categoryId: food, payee: 'Wedding dinner' });
    for (const day of ['02', '05', '08']) env.tx(500, `2026-10-${day}`, { categoryId: food, payee: 'Swiggy' });
    env.tx(500, '2026-10-09', { categoryId: food, payee: 'Dominos' });
    env.tx(1000, '2026-09-03', { categoryId: fun, payee: 'PVR' });
    env.tx(1000, '2026-10-03', { categoryId: fun, payee: 'PVR' });
    env.tx(300, '2026-10-04', { categoryId: fun, payee: 'Concert' });
    env.tx(300, '2026-10-05', { categoryId: fun, payee: 'Bowling' });
    env.tx(350, '2026-10-06', { categoryId: fun, payee: 'Arcade' });
    env.tx(50, '2026-10-07', { categoryId: fun, payee: 'Games' });

    const r = await env.report();
    expect(pick(r, `category-up:${food}`)[0]).toMatchObject({
      tone: 'warning',
      title: 'Food & Dining up 100% (₹1,000) vs last month',
      detail: '₹2,000 so far vs ₹1,000 by this point last month — mostly Swiggy: 3 payments vs 1.',
      action: { label: 'See transactions', to: `/transactions?categoryId=${food}&from=2026-10-01&to=2026-10-20` },
    });
    expect(pick(r, `category-up:${fun}`)[0].detail).toBe('₹2,000 so far vs ₹1,000 by this point last month.');
  });

  it('ignores small or modest changes and reports new spending', async () => {
    const env = await insightsEnv();
    env.tx(2000, '2026-09-05', { categoryId: env.id('Transport') });
    env.tx(2400, '2026-10-05', { categoryId: env.id('Transport') });
    env.tx(4000, '2026-09-05', { categoryId: env.id('Shopping') });
    env.tx(4900, '2026-10-05', { categoryId: env.id('Shopping') });
    env.tx(800, '2026-10-06', { categoryId: env.id('Health'), payee: 'Apollo' });
    const ups = pick(await env.report(), 'category-up');
    expect(ups.map((i) => i.title)).toEqual(['New spending on Health: ₹800']);
  });

  it('does not call everything "new" in a first month with no history', async () => {
    const env = await insightsEnv();
    env.tx(1200, '2026-10-05', { categoryId: env.id('Shopping'), payee: 'Amazon' });
    env.tx(900, '2026-10-06', { categoryId: env.id('Food & Dining'), payee: 'Swiggy' });
    expect(pick(await env.report(), 'category-up')).toEqual([]);
  });

  it('words a payee with no earlier payments plainly', async () => {
    const env = await insightsEnv();
    env.tx(300, '2026-09-05', { categoryId: env.id('Transport') });
    env.tx(800, '2026-10-06', { categoryId: env.id('Health'), payee: 'Apollo' });
    expect(pick(await env.report(), 'category-up')[0].detail).toBe(
      '₹800 so far vs ₹0 by this point last month — mostly Apollo: 1 payment, none before.'
    );
  });

  it('celebrates the biggest drop', async () => {
    const env = await insightsEnv();
    const groceries = env.id('Groceries');
    env.tx(3000, '2026-09-05', { categoryId: groceries });
    env.tx(1000, '2026-10-05', { categoryId: groceries });
    expect(pick(await env.report(), 'category-down')).toEqual([
      expect.objectContaining({ tone: 'good', title: 'Groceries down 67% (₹2,000) vs last month', detail: '₹1,000 so far vs ₹3,000 by this point last month. Nice.' }),
    ]);
  });

  it('shows at most three rises, largest first, and uses full months in the past', async () => {
    const env = await insightsEnv();
    const names = ['Food & Dining', 'Transport', 'Shopping', 'Health'];
    names.forEach((name, i) => {
      env.tx(1000, '2026-08-05', { categoryId: env.id(name) });
      env.tx(2000 + i * 1000, '2026-09-28', { categoryId: env.id(name) });
    });
    const ups = pick(await env.report('2026-09'), 'category-up');
    expect(ups.map((i) => i.title)).toEqual([
      'Health up 400% (₹4,000) vs last month',
      'Shopping up 300% (₹3,000) vs last month',
      'Transport up 200% (₹2,000) vs last month',
    ]);
    expect(ups[0].detail).toBe('₹5,000 vs ₹1,000 last month.');
  });
});
