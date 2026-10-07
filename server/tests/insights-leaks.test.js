import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('small leaks', () => {
  it('adds up many small purchases and names the usual place', async () => {
    const env = await insightsEnv();
    for (let i = 1; i <= 6; i += 1) env.tx(100, `2026-10-0${i}`, { payee: 'Chaayos' });
    for (const payee of ['Tea stall', 'Tea stall', 'Bus', 'Bus', 'Kirana', 'Kirana']) env.tx(100, '2026-10-10', { payee });
    expect(pick(await env.report(), 'leaks')).toEqual([
      expect.objectContaining({ tone: 'info', title: '12 small purchases under ₹200 added up to ₹1,200', detail: 'Mostly Chaayos (6).' }),
    ]);
  });

  it('stays quiet below ten purchases', async () => {
    const env = await insightsEnv();
    for (let i = 1; i <= 9; i += 1) env.tx(150, `2026-10-0${i}`, { payee: 'Chaayos' });
    expect(pick(await env.report(), 'leaks')).toEqual([]);
  });
});

describe('unusual spends', () => {
  it('flags a purchase far above the category median', async () => {
    const env = await insightsEnv();
    const shopping = env.id('Shopping');
    for (const day of ['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-15', '2026-09-30']) env.tx(2000, day, { categoryId: shopping });
    const croma = env.tx(8000, '2026-10-12T18:00', { categoryId: shopping, payee: 'Croma' });
    expect(pick(await env.report(), 'unusual')).toEqual([
      expect.objectContaining({
        id: `unusual:${croma}`, tone: 'info',
        title: '₹8,000 at Croma was unusually high',
        detail: "It's 4× your usual Shopping spend of ₹2,000 (12 Oct).",
      }),
    ]);
  });

  it('needs at least five earlier purchases to judge', async () => {
    const env = await insightsEnv();
    const shopping = env.id('Shopping');
    for (const day of ['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-15']) env.tx(2000, day, { categoryId: shopping });
    env.tx(8000, '2026-10-12', { categoryId: shopping, payee: 'Croma' });
    expect(pick(await env.report(), 'unusual')).toEqual([]);
  });
});
