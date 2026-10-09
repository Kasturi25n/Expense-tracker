import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, addTx, catId, cashId } from './helpers.js';

const count = (db, table, userId) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId).n;

describe('backup and restore', () => {
  let app, db, userId, api, clock;
  beforeEach(async () => {
    clock = { today: '2026-10-08' };
    ({ app, db } = freshApp({ today: () => clock.today }));
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
  });

  // A small but complete account: two accounts, a transfer, tags, a rule, a recurring item, a budget and a goal.
  async function fill() {
    const bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank', openingBalance: 10000 })).body.id;
    const cash = cashId(db, userId);
    const food = catId(db, userId, 'Food & Dining');
    const trip = (await api.post('/api/categories', { name: 'Trips', color: '#123456' })).body.id;
    await api.post('/api/rules', { matchText: 'irctc', categoryId: trip });
    await api.post('/api/transactions', { type: 'income', amount: 50000, occurredAt: '2026-10-01T09:00', accountId: bank, payee: 'Acme', categoryId: catId(db, userId, 'Salary') });
    await api.post('/api/transactions', { type: 'expense', amount: 450, occurredAt: '2026-10-02T13:30', accountId: bank, payee: 'Swiggy', categoryId: food, tags: ['office', 'lunch'] });
    await api.post('/api/transactions', { type: 'transfer', amount: 2000, occurredAt: '2026-10-03T10:00', accountId: bank, toAccountId: cash });
    await api.post('/api/transactions', { type: 'expense', amount: 20, occurredAt: '2026-10-04', accountId: cash, payee: 'Chai' });
    await api.post('/api/transactions', { type: 'expense', amount: 20, occurredAt: '2026-10-04', accountId: cash, payee: 'Chai' });
    await api.post('/api/recurring', { type: 'expense', amount: 15000, accountId: bank, payee: 'Rent', frequency: 'monthly', nextDate: '2026-11-01' });
    await api.post('/api/budgets', { categoryId: food, month: '2026-10', amount: 6000 });
    const goal = (await api.post('/api/goals', { name: 'Goa trip', targetAmount: 40000, targetDate: '2027-03-31' })).body.id;
    await api.post(`/api/goals/${goal}/contributions`, { amount: 5000, date: '2026-10-05' });
    return { bank, cash, food, trip };
  }
  const backup = async (from = api) => (await from.get('/api/backup')).body;
  const restore = (file, to = api, qs = '') => to.post(`/api/backup/restore${qs}`, file);
  const newUser = async (email = 'second@example.com') => {
    const s = await signup(app, email);
    return { id: s.userId, api: client(app, s.token) };
  };

  it('downloads everything the user owns and nothing else', async () => {
    await fill();
    const other = await newUser();
    await other.api.post('/api/transactions', { type: 'expense', amount: 999, occurredAt: '2026-10-02', accountId: cashId(db, other.id), payee: 'Secret' });

    const file = await backup();
    expect(file).toMatchObject({ app: 'expense-tracker', version: 1 });
    expect(file.data.transactions).toHaveLength(5);
    expect(file.data.transactions.find((t) => t.payee === 'Swiggy').tags).toEqual(['lunch', 'office']);
    expect(file.data.goals[0].contributions).toHaveLength(1);
    expect(JSON.stringify(file)).not.toMatch(/Secret|password|example\.com/);
  });

  it('rebuilds the account for a new user', async () => {
    await fill();
    const file = await backup();
    const other = await newUser();
    const res = await restore(file, other.api);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      accounts: { added: 1, skipped: 1 }, // Cash already exists for every user
      transactions: { added: 5, skipped: 0 },
      recurringRules: { added: 1, skipped: 0 },
      budgets: { added: 1, skipped: 0 },
      goals: { added: 1, skipped: 0 },
      goalContributions: { added: 1, skipped: 0 },
    });

    const balances = async (from) => (await from.get('/api/accounts')).body.map((a) => [a.name, a.balance]);
    expect(await balances(other.api)).toEqual(await balances(api));
    const summary = async (from) => {
      const { income, expense, byCategory } = (await from.get('/api/summary?from=2026-10-01&to=2026-10-31')).body;
      return { income, expense, categories: byCategory.length };
    };
    expect(await summary(other.api)).toEqual(await summary(api));
    const mine = (await other.api.get('/api/transactions?q=Swiggy')).body.items[0];
    expect(mine.tags).toEqual(['lunch', 'office']);
    expect(mine.category_id).toBe(catId(db, other.id, 'Food & Dining'));
    expect((await other.api.get('/api/goals')).body[0]).toMatchObject({ name: 'Goa trip', saved: 5000 });
    // Nothing may point at the first user's rows.
    const foreign = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id WHERE t.user_id = ? AND (a.user_id != ? OR c.user_id != ?)`
      )
      .get(other.id, other.id, other.id).n;
    expect(foreign).toBe(0);
  });

  it('adds nothing when the same file is restored again', async () => {
    await fill();
    const file = await backup();
    const before = JSON.stringify((await backup()).data);
    const res = await restore(file);
    for (const [kind, n] of Object.entries(res.body.summary)) expect([kind, n.added]).toEqual([kind, 0]);
    expect(res.body.summary.transactions.skipped).toBe(5);
    expect(JSON.stringify((await backup()).data)).toBe(before);
  });

  it('keeps genuine repeats but only adds the ones that are missing', async () => {
    const { cash } = await fill();
    const file = await backup();
    const chai = (await api.get('/api/transactions?q=Chai')).body.items;
    await api.del(`/api/transactions/${chai[0].id}`);
    const res = await restore(file);
    expect(res.body.summary.transactions).toEqual({ added: 1, skipped: 4 });
    expect((await api.get(`/api/transactions?q=Chai&accountId=${cash}`)).body.total).toBe(2);
  });

  it('does not re-add a transaction that was re-categorised, annotated or re-saved without a time', async () => {
    const { bank, trip } = await fill();
    const file = await backup();
    const swiggy = (await api.get('/api/transactions?q=Swiggy')).body.items[0];
    await api.put(`/api/transactions/${swiggy.id}`, { type: 'expense', amount: 450, occurredAt: '2026-10-02T13:30', accountId: bank, payee: 'swiggy ', categoryId: trip, note: 'team lunch' });
    const chai = (await api.get('/api/transactions?q=Chai')).body.items[0];
    await api.put(`/api/transactions/${chai.id}`, { type: 'expense', amount: 20, occurredAt: '2026-10-04T00:00', accountId: chai.account_id, payee: 'Chai' });

    expect((await restore(file)).body.summary.transactions).toEqual({ added: 0, skipped: 5 });
    expect((await api.get('/api/transactions?q=swiggy')).body.items[0]).toMatchObject({ category_id: trip, note: 'team lunch' });
  });

  it('never changes what is already there', async () => {
    const { bank, food } = await fill();
    const file = await backup();
    await api.put(`/api/accounts/${bank}`, { name: 'hdfc', type: 'bank', openingBalance: 500 });
    const goal = (await api.get('/api/goals')).body[0];
    await api.put(`/api/goals/${goal.id}`, { name: 'Goa Trip', targetAmount: 60000, targetDate: null });
    db.prepare('UPDATE budgets SET amount = 9000 WHERE user_id = ? AND category_id = ?').run(userId, food);

    const res = await restore(file);
    expect(res.body.summary).toMatchObject({ accounts: { added: 0 }, goals: { added: 0 }, budgets: { added: 0 }, goalContributions: { added: 0 } });
    expect((await api.get('/api/accounts')).body.find((a) => a.id === bank)).toMatchObject({ name: 'hdfc', opening_balance: 500 });
    expect((await api.get('/api/goals')).body[0]).toMatchObject({ target_amount: 60000, saved: 5000 });
    expect(db.prepare('SELECT amount FROM budgets WHERE user_id = ?').get(userId).amount).toBe(9000);
  });

  it('previews without writing anything', async () => {
    await fill();
    const file = await backup();
    const other = await newUser();
    const res = await restore(file, other.api, '?dryRun=1');
    expect(res.body).toMatchObject({ preview: true, summary: { transactions: { added: 5, skipped: 0 } } });
    expect(count(db, 'transactions', other.id)).toBe(0);
    expect(count(db, 'accounts', other.id)).toBe(1);
    expect(count(db, 'goals', other.id)).toBe(0);
  });

  it('rejects files that are not backups', async () => {
    for (const file of [{}, { app: 'something-else', version: 1, data: {} }, { app: 'expense-tracker', version: 1, data: { accounts: [] } }]) {
      expect((await restore(file)).status).toBe(400);
    }
    const file = await backup();
    const res = await restore({ ...file, version: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/newer version/);
  });

  it('changes nothing when any row is bad', async () => {
    await fill();
    const file = await backup();
    const other = await newUser();
    const broken = (change) => {
      const copy = JSON.parse(JSON.stringify(file));
      change(copy.data);
      return copy;
    };
    const bad = [
      broken((d) => { d.transactions[4].amount = -5; }),
      broken((d) => { d.transactions[4].account_id = 987654; }),
      broken((d) => { d.transactions[4].occurred_at = '2026-13-45'; }),
      broken((d) => { d.transactions[2].to_account_id = d.transactions[2].account_id; }),
      broken((d) => { d.transactions[1].category_id = d.categories.find((c) => c.kind === 'income').id; }),
      broken((d) => { d.goals[0].contributions[0].amount = 'lots'; }),
      broken((d) => { d.recurringRules[0].frequency = 'hourly'; }),
    ];
    for (const copy of bad) {
      const res = await restore(copy, other.api);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/entry \d+/);
    }
    expect(count(db, 'transactions', other.id)).toBe(0);
    expect(count(db, 'accounts', other.id)).toBe(1);
    expect(count(db, 'categories', other.id)).toBe(17);
    expect(count(db, 'goals', other.id)).toBe(0);
  });

  it('does not let a restored repeating item post what is already logged', async () => {
    const { bank } = await fill();
    const file = await backup(); // Rent is next due 1 Nov
    clock.today = '2026-12-05';
    await api.get('/api/accounts'); // posts rent for 1 Nov and 1 Dec
    const rule = (await api.get('/api/recurring')).body.rules[0];
    await api.del(`/api/recurring/${rule.id}`);

    expect((await restore(file)).body.summary.recurringRules).toEqual({ added: 1, skipped: 0 });
    await api.get('/api/accounts');
    expect((await api.get(`/api/transactions?q=Rent&accountId=${bank}`)).body.total).toBe(2);
    expect((await api.get('/api/recurring')).body.rules[0].next_date).toBe('2027-01-01');
  });

  it('keeps import batches with the transactions they brought in', async () => {
    const cash = cashId(db, userId);
    await api.post('/api/imports', { accountId: cash, fileName: 'oct.csv', transactions: [{ amount: 300, occurredAt: '2026-10-06', direction: 'out', payee: 'Dmart' }] });
    const file = await backup();
    const other = await newUser();
    expect((await restore(file, other.api)).body.summary.imports).toEqual({ added: 1, skipped: 0 });
    const [batch] = (await other.api.get('/api/imports')).body;
    expect(batch).toMatchObject({ file_name: 'oct.csv', row_count: 1 });
    expect((await restore(file, other.api)).body.summary.imports).toEqual({ added: 0, skipped: 1 });
    await other.api.del(`/api/imports/${batch.id}`);
    expect(count(db, 'transactions', other.id)).toBe(0);
  });
});
