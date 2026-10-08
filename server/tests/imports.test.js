import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, catId, cashId, addTx } from './helpers.js';

const HDFC = [
  'HDFC BANK Ltd.,,,,,,',
  'Statement of account,,,,,,',
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '05/10/26,UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment,4123,05/10/26,250.00,,"9,750.00"',
  '05/10/26,UPI/DR/412345678902/CHAAYOS/YESB/chaayos@ybl/Payment,4124,05/10/26,20.00,,"9,730.00"',
  '06/10/26,NEFT CR-HDFC0000001-ACME CORP-SALARY,4125,06/10/26,,"50,000.00","59,730.00"',
  '07/10/26,CC PAYMENT ICICI CARD,4126,07/10/26,"5,000.00",,"54,730.00"',
  ',Total,,,"5,270.00","50,000.00",',
].join('\n');
const file = { fileName: 'hdfc-oct.csv', fileBase64: Buffer.from(HDFC).toString('base64') };
const SPLIT = { layout: 'split', date: 0, description: 1, debit: 2, credit: 3, amount: null, drcr: null, balance: null };

describe('statement import', () => {
  let app, db, userId, api, bank;
  const read = async () => (await api.post('/api/imports/read', file)).body;
  const preview = async (r, accountId = bank) =>
    (await api.post('/api/imports/preview', { accountId, rows: r.rows, headerRow: r.headerRow, mapping: r.mapping, dateFormat: r.dateFormat })).body;

  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
    bank = (await api.post('/api/accounts', { name: 'HDFC', type: 'bank', openingBalance: 10000 })).body.id;
  });

  it('reads the file and guesses headings, columns and date style', async () => {
    expect(await read()).toMatchObject({
      headerRow: 2, dateFormat: 'dmy', savedFormat: false,
      mapping: { layout: 'split', date: 0, description: 1, debit: 4, credit: 5, balance: 6 },
    });
  });

  it('previews payees, categories, skipped rows and the balance check', async () => {
    const p = await preview(await read());
    expect(p.transactions.map((t) => [t.occurredAt, t.direction, t.amount, t.payee])).toEqual([
      ['2026-10-05', 'out', 250, 'Swiggy'],
      ['2026-10-05', 'out', 20, 'Chaayos'],
      ['2026-10-06', 'in', 50000, 'Acme Corp'],
      ['2026-10-07', 'out', 5000, 'Cc Payment Icici Card'],
    ]);
    expect(p.transactions[0].categoryId).toBe(catId(db, userId, 'Food & Dining'));
    expect(p.transactions.every((t) => t.duplicate === false)).toBe(true);
    expect(p.skipped.map((s) => s.reason)).toEqual(['No valid date']);
    expect(p.balance).toEqual({ now: 10000, statementClosing: 54730 });
  });

  it('flags duplicates by day, amount and direction, including transfers', async () => {
    addTx(db, userId, { amount: 250, occurredAt: '2026-10-05T13:00', accountId: bank, payee: 'Swiggy' });
    addTx(db, userId, { type: 'income', amount: 20, occurredAt: '2026-10-05', accountId: bank });
    addTx(db, userId, { type: 'transfer', amount: 5000, occurredAt: '2026-10-07', accountId: bank, toAccountId: cashId(db, userId) });
    const p = await preview(await read());
    expect(p.transactions.map((t) => t.duplicate)).toEqual([true, false, false, true]);
  });

  it('counts duplicates one-for-one', async () => {
    addTx(db, userId, { amount: 20, occurredAt: '2026-10-05', accountId: bank });
    const rows = [['Date', 'Narration', 'Withdrawal', 'Deposit'], ['05/10/26', 'Chai', '20', ''], ['05/10/26', 'Chai', '20', '']];
    const p = (await api.post('/api/imports/preview', { accountId: bank, rows, headerRow: 0, mapping: SPLIT, dateFormat: 'dmy' })).body;
    expect(p.transactions.map((t) => t.duplicate)).toEqual([true, false]);
    expect(p.balance.statementClosing).toBeNull();
  });

  it('imports ticked rows as one batch, including a transfer, and remembers the format', async () => {
    const card = (await api.post('/api/accounts', { name: 'ICICI Card', type: 'credit_card' })).body.id;
    const r = await read();
    const picked = (await preview(r)).transactions.map(({ occurredAt, amount, direction, payee, note, categoryId }) => ({
      occurredAt, amount, direction, payee, note, categoryId,
    }));
    picked[3].transferAccountId = card;
    const res = await api.post('/api/imports', {
      accountId: bank, fileName: 'hdfc-oct.csv', headers: r.rows[r.headerRow],
      mapping: { ...r.mapping, balance: null }, dateFormat: r.dateFormat, transactions: picked,
    });
    expect(res.status).toBe(201);
    expect(res.body.rowCount).toBe(4);

    const accounts = (await api.get('/api/accounts')).body;
    expect(accounts.find((a) => a.id === bank).balance).toBe(54730);
    expect(accounts.find((a) => a.id === card).balance).toBe(5000);
    const txs = (await api.get('/api/transactions')).body.items;
    expect(txs.find((t) => t.type === 'transfer')).toMatchObject({ account_id: bank, to_account_id: card, amount: 5000 });
    expect(txs.every((t) => t.import_id === res.body.id)).toBe(true);

    const again = await read();
    expect(again).toMatchObject({ savedFormat: true, headerRow: 2 });
    expect(again.mapping.balance).toBeNull();
  });

  it('lists imports and undoes only that batch, even if a row was edited', async () => {
    addTx(db, userId, { amount: 99, occurredAt: '2026-10-01', accountId: bank, payee: 'Manual' });
    const rows = (await preview(await read())).transactions;
    const first = (await api.post('/api/imports', { accountId: bank, fileName: 'a.csv', transactions: rows.slice(0, 2) })).body;
    const second = (await api.post('/api/imports', { accountId: bank, fileName: 'b.csv', transactions: rows.slice(2, 3) })).body;
    expect((await api.get('/api/imports')).body.map((i) => [i.file_name, i.row_count, i.account_name])).toEqual([
      ['b.csv', 1, 'HDFC'],
      ['a.csv', 2, 'HDFC'],
    ]);

    const edited = (await api.get('/api/transactions')).body.items.find((t) => t.import_id === first.id);
    await api.put(`/api/transactions/${edited.id}`, {
      type: edited.type, amount: edited.amount, occurredAt: edited.occurred_at, accountId: bank,
      categoryId: edited.category_id, payee: edited.payee, note: edited.note, tags: ['office'],
    });
    expect((await api.del(`/api/imports/${first.id}`)).status).toBe(204);
    expect((await api.get('/api/transactions')).body.items.map((t) => t.payee).sort()).toEqual(['Acme Corp', 'Manual']);
    expect((await api.get('/api/imports')).body.map((i) => i.id)).toEqual([second.id]);
  });

  it("refuses other users' accounts and transfer targets", async () => {
    const other = await signup(app, 'other@example.com');
    const theirs = cashId(db, other.userId);
    const r = await read();
    expect((await api.post('/api/imports/preview', { accountId: theirs, rows: r.rows, headerRow: 2, mapping: r.mapping, dateFormat: 'dmy' })).status).toBe(400);
    const row = { ...(await preview(r)).transactions[3], transferAccountId: theirs };
    expect((await api.post('/api/imports', { accountId: bank, fileName: 'x.csv', transactions: [row] })).status).toBe(400);
    const batch = (await api.post('/api/imports', { accountId: bank, fileName: 'x.csv', transactions: [(await preview(r)).transactions[0]] })).body;
    expect((await client(app, other.token).del(`/api/imports/${batch.id}`)).status).toBe(404);
  });

  it('rejects PDFs and files over 5 MB', async () => {
    expect((await api.post('/api/imports/read', { fileName: 'statement.pdf', fileBase64: 'AAAA' })).status).toBe(400);
    const big = Buffer.alloc(5.5 * 1024 * 1024).toString('base64');
    const res = await api.post('/api/imports/read', { fileName: 'big.csv', fileBase64: big });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/5 MB/);
  });

  it('lets an account be deleted once its imported transactions are gone', async () => {
    const spare = (await api.post('/api/accounts', { name: 'Spare', type: 'bank' })).body.id;
    const [row] = (await preview(await read(), spare)).transactions;
    await api.post('/api/imports', { accountId: spare, fileName: 'x.csv', transactions: [row] });
    const tx = (await api.get(`/api/transactions?accountId=${spare}`)).body.items[0];
    await api.del(`/api/transactions/${tx.id}`);
    expect((await api.del(`/api/accounts/${spare}`)).status).toBe(204);
  });
});
