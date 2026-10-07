import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, catId, cashId } from './helpers.js';

describe('recurring items', () => {
  let app, db, userId, api, cash, today;
  const rule = (extra = {}) => ({
    type: 'expense', amount: 15000, accountId: cash, payee: 'Landlord', categoryId: catId(db, userId, 'Rent'),
    frequency: 'monthly', nextDate: '2026-08-05', mode: 'auto', ...extra,
  });
  const txs = async () => (await api.get('/api/transactions')).body.items;
  beforeEach(async () => {
    today = '2026-10-07';
    ({ app, db } = freshApp({ today: () => today }));
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
    cash = cashId(db, userId);
  });

  it('posts every missed occurrence of an automatic item exactly once', async () => {
    const created = await api.post('/api/recurring', rule());
    expect(created.status).toBe(201);
    const posted = await txs();
    expect(posted.map((t) => t.occurred_at)).toEqual(['2026-10-05', '2026-09-05', '2026-08-05']);
    expect(posted.every((t) => t.recurring_id === created.body.id)).toBe(true);
    expect(await txs()).toHaveLength(3);
    expect((await api.get('/api/recurring')).body.rules[0].next_date).toBe('2026-11-05');
  });

  it('waits for confirmation on "confirm" items, then posts the edited amount', async () => {
    const bills = catId(db, userId, 'Bills & Utilities');
    const { id } = (await api.post('/api/recurring', rule({ payee: 'BESCOM', amount: 1200, categoryId: bills, nextDate: '2026-10-01', mode: 'confirm' }))).body;
    expect(await txs()).toHaveLength(0);
    expect((await api.get('/api/recurring')).body.pending).toEqual([expect.objectContaining({ ruleId: id, date: '2026-10-01', amount: 1200 })]);

    const res = await api.post(`/api/recurring/${id}/confirm`, { amount: 1340 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: 1340, occurred_at: '2026-10-01', recurring_id: id, category_id: bills });
    const after = (await api.get('/api/recurring')).body;
    expect(after.pending).toEqual([]);
    expect(after.rules[0].next_date).toBe('2026-11-01');
  });

  it('skips an occurrence without posting', async () => {
    const { id } = (await api.post('/api/recurring', rule({ nextDate: '2026-10-01', mode: 'confirm' }))).body;
    expect((await api.post(`/api/recurring/${id}/skip`)).status).toBe(200);
    expect(await txs()).toHaveLength(0);
    expect((await api.get('/api/recurring')).body.rules[0].next_date).toBe('2026-11-01');
  });

  it('refuses to confirm something not yet due', async () => {
    const { id } = (await api.post('/api/recurring', rule({ nextDate: '2026-10-20', mode: 'confirm' }))).body;
    expect((await api.post(`/api/recurring/${id}/confirm`, {})).status).toBe(400);
  });

  it('stops at the end date and marks the item inactive', async () => {
    await api.post('/api/recurring', rule({ endDate: '2026-09-30' }));
    expect((await txs()).map((t) => t.occurred_at)).toEqual(['2026-09-05', '2026-08-05']);
    expect((await api.get('/api/recurring')).body.rules[0].active).toBe(0);
  });

  it('does not backfill the time an item was paused', async () => {
    const created = (await api.post('/api/recurring', rule({ nextDate: '2026-10-20' }))).body;
    const body = rule({ nextDate: created.next_date });
    await api.put(`/api/recurring/${created.id}`, { ...body, active: false });
    today = '2026-12-10';
    const resumed = await api.put(`/api/recurring/${created.id}`, { ...body, active: true });
    expect(resumed.body.next_date).toBe('2026-12-20');
    expect(await txs()).toHaveLength(0);
  });

  it('lists what is coming up in the window', async () => {
    await api.post('/api/recurring', rule({ nextDate: '2026-10-20' }));
    expect((await api.get('/api/recurring/upcoming?days=7')).body).toEqual([]);
    expect((await api.get('/api/recurring/upcoming?days=30')).body).toEqual([
      expect.objectContaining({ date: '2026-10-20', amount: 15000, payee: 'Landlord', mode: 'auto' }),
    ]);
  });

  it('changes only future occurrences when an item is edited', async () => {
    const created = (await api.post('/api/recurring', rule())).body;
    await txs();
    await api.put(`/api/recurring/${created.id}`, rule({ amount: 16000, nextDate: '2026-11-05' }));
    expect((await txs()).map((t) => t.amount)).toEqual([15000, 15000, 15000]);
  });

  it('keeps posted transactions when an item is deleted', async () => {
    const created = (await api.post('/api/recurring', rule())).body;
    await txs();
    expect((await api.del(`/api/recurring/${created.id}`)).status).toBe(204);
    const left = await txs();
    expect(left).toHaveLength(3);
    expect(left.every((t) => t.recurring_id === null)).toBe(true);
  });

  it("validates input and protects other users' items", async () => {
    expect((await api.post('/api/recurring', rule({ frequency: 'daily' }))).status).toBe(400);
    expect((await api.post('/api/recurring', rule({ nextDate: '5 Oct' }))).status).toBe(400);
    expect((await api.post('/api/recurring', rule({ endDate: '2026-01-01' }))).status).toBe(400);
    const created = (await api.post('/api/recurring', rule({ nextDate: '2026-10-20' }))).body;
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.put(`/api/recurring/${created.id}`, rule())).status).toBe(404);
    expect((await other.del(`/api/recurring/${created.id}`)).status).toBe(404);
  });

  it('does not post into an archived account', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    await api.post('/api/recurring', rule({ accountId: bank, nextDate: '2026-10-20' }));
    await api.put(`/api/accounts/${bank}`, { name: 'HDFC', type: 'bank', openingBalance: 0, archived: true });
    today = '2026-12-10';
    expect(await txs()).toHaveLength(0);
  });

  it('refuses to confirm a bill into an archived account', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    const { id } = (await api.post('/api/recurring', rule({ accountId: bank, nextDate: '2026-10-01', mode: 'confirm' }))).body;
    await api.put(`/api/accounts/${bank}`, { name: 'HDFC', type: 'bank', openingBalance: 0, archived: true });
    const res = await api.post(`/api/recurring/${id}/confirm`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/archived/);
  });

  it('clears the category from items when the category is deleted', async () => {
    const rent = catId(db, userId, 'Rent');
    const created = (await api.post('/api/recurring', rule({ nextDate: '2026-10-20' }))).body;
    await api.del(`/api/categories/${rent}`);
    expect((await api.get('/api/recurring')).body.rules.find((r) => r.id === created.id).category_id).toBeNull();
  });
});
