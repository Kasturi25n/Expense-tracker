import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, pick } from './helpers.js';

describe('goals', () => {
  let app, db, api, clock;
  beforeEach(async () => {
    clock = { today: '2026-10-08' };
    ({ app, db } = freshApp({ today: () => clock.today }));
    api = client(app, (await signup(app)).token);
  });

  const create = async (body = { name: 'Goa trip', targetAmount: 40000, targetDate: '2027-03-31' }) => (await api.post('/api/goals', body)).body;
  const madeOn = (id, date) => db.prepare('UPDATE goals SET created_at = ? WHERE id = ?').run(`${date} 10:00:00`, id);
  const list = async () => (await api.get('/api/goals')).body;

  it('works out how much to put aside each month', async () => {
    const goal = await create();
    expect(goal).toMatchObject({ name: 'Goa trip', target_amount: 40000, saved: 0, remaining: 40000, monthsLeft: 6, perMonth: 6667, status: 'on-track' });

    await api.post(`/api/goals/${goal.id}/contributions`, { amount: 10000, date: '2026-10-08' });
    const [after] = await list();
    expect(after).toMatchObject({ saved: 10000, remaining: 30000, perMonth: 5000 });
    expect(after.contributions).toHaveLength(1);
  });

  it('is behind when a full month has passed without its share', async () => {
    const goal = await create();
    madeOn(goal.id, '2026-10-08');
    clock.today = '2026-12-05';
    // Oct..Mar is 6 months; two have fully passed, so 13,333.33 should be saved.
    await api.post(`/api/goals/${goal.id}/contributions`, { amount: 13000 });
    expect((await list())[0]).toMatchObject({ status: 'behind', monthsLeft: 4, perMonth: 6750 });
    await api.post(`/api/goals/${goal.id}/contributions`, { amount: 400 });
    expect((await list())[0].status).toBe('on-track');
  });

  it('reports reached, overdue and open goals', async () => {
    const goal = await create();
    const open = await create({ name: 'Emergency fund', targetAmount: 100000 });
    expect(open).toMatchObject({ status: 'open', monthsLeft: null, perMonth: null, target_date: null });

    clock.today = '2027-04-01';
    expect((await list()).find((g) => g.id === goal.id)).toMatchObject({ status: 'overdue', perMonth: null });
    await api.post(`/api/goals/${goal.id}/contributions`, { amount: 45000 });
    expect((await list()).find((g) => g.id === goal.id)).toMatchObject({ status: 'reached', remaining: 0, perMonth: null });
  });

  it('lets money be taken out, but not more than is saved', async () => {
    const goal = await create();
    await api.post(`/api/goals/${goal.id}/contributions`, { amount: 5000 });
    expect((await api.post(`/api/goals/${goal.id}/contributions`, { amount: -6000 })).status).toBe(400);
    expect((await api.post(`/api/goals/${goal.id}/contributions`, { amount: 0 })).status).toBe(400);
    const taken = await api.post(`/api/goals/${goal.id}/contributions`, { amount: -2000, note: 'Flight deposit' });
    expect(taken.status).toBe(201);
    expect(taken.body.saved).toBe(3000);

    const first = taken.body.contributions.find((c) => c.amount === 5000);
    // Removing the 5,000 would leave the goal at -2,000.
    expect((await api.del(`/api/goals/${goal.id}/contributions/${first.id}`)).status).toBe(400);
    const out = taken.body.contributions.find((c) => c.amount === -2000);
    expect((await api.del(`/api/goals/${goal.id}/contributions/${out.id}`)).status).toBe(200);
    expect((await list())[0].saved).toBe(5000);
  });

  it('validates, edits and deletes', async () => {
    expect((await api.post('/api/goals', { name: ' ', targetAmount: 100 })).status).toBe(400);
    expect((await api.post('/api/goals', { name: 'Bike', targetAmount: 0 })).status).toBe(400);
    expect((await api.post('/api/goals', { name: 'Bike', targetAmount: 100, targetDate: 'soon' })).status).toBe(400);

    const goal = await create();
    const edited = await api.put(`/api/goals/${goal.id}`, { name: 'Goa', targetAmount: 30000, targetDate: null });
    expect(edited.body).toMatchObject({ name: 'Goa', target_amount: 30000, status: 'open' });

    await api.post(`/api/goals/${goal.id}/contributions`, { amount: 100 });
    expect((await api.del(`/api/goals/${goal.id}`)).status).toBe(204);
    expect(await list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM goal_contributions').get().n).toBe(0);
  });

  it("hides other people's goals", async () => {
    const goal = await create();
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.get('/api/goals')).body).toEqual([]);
    expect((await other.put(`/api/goals/${goal.id}`, { name: 'x', targetAmount: 1 })).status).toBe(404);
    expect((await other.post(`/api/goals/${goal.id}/contributions`, { amount: 5 })).status).toBe(404);
    expect((await other.del(`/api/goals/${goal.id}`)).status).toBe(404);
  });

  it('shows an insight for goals that are behind, only for this month across all accounts', async () => {
    const goal = await create();
    madeOn(goal.id, '2026-10-08');
    const report = async (qs) => (await api.get(`/api/insights?${qs}`)).body;
    expect(pick(await report('month=2026-10'), 'goal-')).toEqual([]);

    clock.today = '2026-12-05';
    const [insight] = pick(await report('month=2026-12'), 'goal-');
    expect(insight).toMatchObject({ id: `goal-${goal.id}`, action: { to: '/goals' } });
    expect(insight.title).toContain('Goa trip');
    expect(pick(await report('month=2026-11'), 'goal-')).toEqual([]);
    const cash = db.prepare("SELECT id FROM accounts WHERE name = 'Cash'").get().id;
    expect(pick(await report(`month=2026-12&accountId=${cash}`), 'goal-')).toEqual([]);
  });
});
