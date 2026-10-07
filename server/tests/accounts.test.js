import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, addTx } from './helpers.js';

describe('accounts', () => {
  let app, db, userId, api;
  const byName = async (name) => (await api.get('/api/accounts')).body.find((a) => a.name === name);
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
  });

  it('starts with a Cash account at zero', async () => {
    expect(await byName('Cash')).toMatchObject({ type: 'cash', balance: 0, archived: 0 });
  });

  it('creates an account with an opening balance', async () => {
    const res = await api.post('/api/accounts', { name: 'HDFC', type: 'bank', openingBalance: 10000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'HDFC', type: 'bank', balance: 10000 });
  });

  it('computes balances from income, expenses and transfers', async () => {
    const hdfc = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank', openingBalance: 10000 })).body.id;
    const cash = (await byName('Cash')).id;
    addTx(db, userId, { type: 'income', amount: 50000, accountId: hdfc });
    addTx(db, userId, { type: 'expense', amount: 1200, accountId: hdfc });
    addTx(db, userId, { type: 'transfer', amount: 5000, accountId: hdfc, toAccountId: cash });
    expect((await byName('HDFC')).balance).toBe(53800);
    expect((await byName('Cash')).balance).toBe(5000);
  });

  it('rounds balances to paise', async () => {
    const wallet = (await api.post('/api/accounts', { name: 'Paytm', type: 'wallet', openingBalance: 100 })).body.id;
    addTx(db, userId, { amount: 0.1, accountId: wallet });
    addTx(db, userId, { amount: 0.2, accountId: wallet });
    expect((await byName('Paytm')).balance).toBe(99.7);
  });

  it('allows a negative opening balance for a credit card', async () => {
    const res = await api.post('/api/accounts', { name: 'ICICI Card', type: 'credit_card', openingBalance: -12000 });
    expect(res.body.balance).toBe(-12000);
  });

  it('validates name, type and opening balance', async () => {
    expect((await api.post('/api/accounts', { name: '', type: 'bank' })).status).toBe(400);
    expect((await api.post('/api/accounts', { name: 'X', type: 'savings' })).status).toBe(400);
    expect((await api.post('/api/accounts', { name: 'X', type: 'bank', openingBalance: 'lots' })).status).toBe(400);
  });

  it('renames and archives, keeping the account listed', async () => {
    const cash = await byName('Cash');
    const res = await api.put(`/api/accounts/${cash.id}`, { name: 'Wallet cash', type: 'cash', openingBalance: 0, archived: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Wallet cash', archived: 1 });
  });

  it('refuses to delete an account with transactions, but deletes an unused one', async () => {
    const cash = await byName('Cash');
    addTx(db, userId, { amount: 10, accountId: cash.id });
    const del = await api.del(`/api/accounts/${cash.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/Archive/);
    const spare = (await api.post('/api/accounts', { name: 'Spare', type: 'wallet' })).body.id;
    expect((await api.del(`/api/accounts/${spare}`)).status).toBe(204);
  });

  it('keeps accounts private to their owner', async () => {
    const cash = await byName('Cash');
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.get('/api/accounts')).body.map((a) => a.id)).not.toContain(cash.id);
    expect((await other.put(`/api/accounts/${cash.id}`, { name: 'Mine', type: 'cash' })).status).toBe(404);
    expect((await other.del(`/api/accounts/${cash.id}`)).status).toBe(404);
  });
});
