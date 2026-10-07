import { describe, it, expect } from 'vitest';
import { freshApp, signup, client, addTx } from './helpers.js';

describe('csv export', () => {
  it('exports transactions with account, category, tags and spreadsheet-safe text', async () => {
    const { app, db } = freshApp();
    const { token, userId } = await signup(app);
    const api = client(app, token);
    const food = (await api.post('/api/categories', { name: 'Food' })).body.id;
    const txId = addTx(db, userId, { amount: 15, occurredAt: '2026-09-10T09:30', categoryId: food, payee: 'Chai, Point', note: '=HYPERLINK("x")' });
    db.prepare("INSERT INTO tags (user_id, name) VALUES (?, 'office')").run(userId);
    db.prepare("INSERT INTO transaction_tags (transaction_id, tag_id) SELECT ?, id FROM tags WHERE name = 'office'").run(txId);

    const res = await api.get('/api/export/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('occurred_at,type,amount,account,to_account,category,payee,note,tags');
    expect(lines[1]).toBe(`2026-09-10T09:30,expense,15,Cash,,Food,"Chai, Point","'=HYPERLINK(""x"")",office`);
  });
});
