import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('subscription insights', () => {
  it('spots a steady monthly payment and offers to track it', async () => {
    const env = await insightsEnv();
    const fun = env.id('Entertainment');
    for (const month of ['07', '08', '09', '10']) env.tx(119, `2026-${month}-03`, { payee: 'Spotify', categoryId: fun });
    const [sub] = pick(await env.report(), 'subscription');
    expect(sub).toMatchObject({ id: 'subscription:spotify', tone: 'info', title: 'Spotify looks like a subscription: ₹119 every month' });
    const params = new URLSearchParams(sub.action.to.split('?')[1]);
    expect(Object.fromEntries(params)).toEqual({
      new: '1', type: 'expense', payee: 'Spotify', amount: '119', categoryId: String(fun),
      accountId: String(env.cash), frequency: 'monthly', nextDate: '2026-11-03',
    });
  });

  it('never pre-fills a start date in the past', async () => {
    const env = await insightsEnv();
    for (const month of ['05', '06', '07']) env.tx(119, `2026-${month}-03`, { payee: 'Spotify' });
    const [sub] = pick(await env.report('2026-07'), 'subscription');
    expect(new URLSearchParams(sub.action.to.split('?')[1]).get('nextDate')).toBe('2026-11-03');
  });

  it('skips tracked items, changing amounts and repeat purchases', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/recurring', {
      type: 'expense', amount: 649, accountId: env.cash, payee: 'Netflix', frequency: 'monthly', nextDate: '2026-11-05', mode: 'confirm',
    });
    for (const month of ['08', '09', '10']) env.tx(649, `2026-${month}-05`, { payee: 'Netflix' });
    [1000, 1500, 1000].forEach((amount, i) => env.tx(amount, `2026-${['08', '09', '10'][i]}-07`, { payee: 'Gym' }));
    for (const day of ['2026-08-09', '2026-09-09', '2026-10-09', '2026-10-15']) env.tx(300, day, { payee: 'Zomato' });
    expect(pick(await env.report(), 'subscription')).toEqual([]);
  });
});
