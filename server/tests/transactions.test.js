import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, catId, cashId } from './helpers.js';

describe('transactions', () => {
  let app, db, userId, api, cash, food;
  const expense = (extra = {}) => ({ type: 'expense', amount: 250, occurredAt: '2026-10-05T13:10', accountId: cash, payee: 'Swiggy', ...extra });
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
    cash = cashId(db, userId);
    food = catId(db, userId, 'Food & Dining');
  });

  it('creates an expense, auto-categorising from the payee', async () => {
    const res = await api.post('/api/transactions', expense());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'expense', amount: 250, occurred_at: '2026-10-05T13:10', account_id: cash, category_id: food, payee: 'Swiggy', tags: [] });
  });

  it('keeps an explicit "no category"', async () => {
    expect((await api.post('/api/transactions', expense({ categoryId: null }))).body.category_id).toBeNull();
  });

  it('normalises tags', async () => {
    const res = await api.post('/api/transactions', expense({ tags: ['Goa-Trip ', 'goa-trip', 'Food'] }));
    expect(res.body.tags).toEqual(['food', 'goa-trip']);
  });

  it('validates amount, date and type', async () => {
    for (const bad of [{ amount: 0 }, { amount: 'abc' }, { amount: 2e9 }, { occurredAt: '05/10/2026' }, { type: 'gift' }]) {
      expect((await api.post('/api/transactions', expense(bad))).status).toBe(400);
    }
  });

  it('rejects accounts and categories that belong to someone else', async () => {
    const other = await signup(app, 'other@example.com');
    expect((await api.post('/api/transactions', expense({ accountId: cashId(db, other.userId) }))).status).toBe(400);
    expect((await api.post('/api/transactions', expense({ categoryId: catId(db, other.userId, 'Groceries') }))).status).toBe(400);
  });

  it('rejects a category of the wrong kind', async () => {
    const res = await api.post('/api/transactions', expense({ type: 'income', categoryId: food }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expense/);
  });

  it('records transfers between two different accounts without a category', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    expect((await api.post('/api/transactions', expense({ type: 'transfer', toAccountId: cash }))).status).toBe(400);
    const res = await api.post('/api/transactions', expense({ type: 'transfer', accountId: bank, toAccountId: cash, categoryId: food }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'transfer', account_id: bank, to_account_id: cash, category_id: null });
  });

  it('updates fields and tags, and 404s for other users', async () => {
    const groceries = catId(db, userId, 'Groceries');
    const { id } = (await api.post('/api/transactions', expense({ tags: ['a'] }))).body;
    const res = await api.put(`/api/transactions/${id}`, expense({ amount: 300, categoryId: groceries, tags: ['b'] }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: 300, category_id: groceries, tags: ['b'] });
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.put(`/api/transactions/${id}`, expense())).status).toBe(404);
  });

  it('still allows editing a transaction whose account was archived, but not new ones', async () => {
    const { id } = (await api.post('/api/transactions', expense())).body;
    await api.put(`/api/accounts/${cash}`, { name: 'Cash', type: 'cash', openingBalance: 0, archived: true });
    expect((await api.put(`/api/transactions/${id}`, expense({ amount: 99 }))).status).toBe(200);
    expect((await api.post('/api/transactions', expense())).status).toBe(400);
  });

  it('deletes a transaction', async () => {
    const { id } = (await api.post('/api/transactions', expense({ tags: ['x'] }))).body;
    expect((await api.del(`/api/transactions/${id}`)).status).toBe(204);
    expect((await api.get('/api/transactions')).body.total).toBe(0);
  });

  it('filters by type, account, category, tag, text and date', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    await api.post('/api/transactions', expense({ occurredAt: '2026-09-01T09:00', payee: 'Swiggy', tags: ['office'] }));
    await api.post('/api/transactions', expense({ occurredAt: '2026-09-20T21:30', payee: 'Uber', note: 'airport' }));
    await api.post('/api/transactions', { type: 'income', amount: 50000, occurredAt: '2026-09-30', accountId: bank, payee: 'Acme Corp' });
    await api.post('/api/transactions', { type: 'transfer', amount: 2000, occurredAt: '2026-09-25T10:00', accountId: bank, toAccountId: cash });
    const list = async (params) =>
      (await api.get(`/api/transactions?${new URLSearchParams(params)}`)).body.items.map((t) => t.payee || t.type);

    expect(await list({ type: 'income' })).toEqual(['Acme Corp']);
    expect(await list({ accountId: bank })).toEqual(['Acme Corp', 'transfer']);
    expect(await list({ categoryId: food })).toEqual(['Swiggy']);
    expect(await list({ tag: 'Office' })).toEqual(['Swiggy']);
    expect(await list({ q: 'airport' })).toEqual(['Uber']);
    expect(await list({ from: '2026-09-20', to: '2026-09-20' })).toEqual(['Uber']);
  });

  it('paginates newest first with a total', async () => {
    for (const day of ['01', '02', '03']) await api.post('/api/transactions', expense({ occurredAt: `2026-09-${day}T10:00` }));
    const first = (await api.get('/api/transactions?limit=2')).body;
    expect(first.total).toBe(3);
    expect(first.items.map((t) => t.occurred_at)).toEqual(['2026-09-03T10:00', '2026-09-02T10:00']);
    expect((await api.get('/api/transactions?limit=2&offset=2')).body.items).toHaveLength(1);
  });

  it('remembers the last account used', async () => {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank' })).body.id;
    expect((await api.get('/api/transactions/defaults')).body.accountId).toBe(cash);
    await api.post('/api/transactions', expense({ accountId: bank }));
    expect((await api.get('/api/transactions/defaults')).body.accountId).toBe(bank);
  });

  it('suggests payees by frequency, and a category for the typed text', async () => {
    await api.post('/api/transactions', expense({ payee: 'Swiggy' }));
    await api.post('/api/transactions', expense({ payee: 'Swiggy' }));
    await api.post('/api/transactions', expense({ payee: 'Swagath Hotel', categoryId: null }));
    expect((await api.get('/api/transactions/payees?q=sw&type=expense')).body.payees).toEqual(['Swiggy', 'Swagath Hotel']);
    expect((await api.get('/api/transactions/payees?q=zomato&type=expense')).body.suggestedCategoryId).toBe(food);
  });

  it('lists tags with usage counts', async () => {
    await api.post('/api/transactions', expense({ tags: ['goa-trip'] }));
    await api.post('/api/transactions', expense({ tags: ['goa-trip', 'office'] }));
    expect((await api.get('/api/transactions/tags')).body).toEqual([{ name: 'goa-trip', uses: 2 }, { name: 'office', uses: 1 }]);
  });
});
