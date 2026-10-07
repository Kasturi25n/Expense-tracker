import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, addTx } from './helpers.js';

describe('categories', () => {
  let app, db, userId, api;
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
  });

  it('creates and lists categories', async () => {
    expect((await api.post('/api/categories', { name: 'Pets', color: '#ff0000' })).status).toBe(201);
    expect((await api.get('/api/categories')).body.map((c) => c.name)).toContain('Pets');
  });

  it('renames a category', async () => {
    const { id } = (await api.post('/api/categories', { name: 'Pets' })).body;
    const res = await api.put(`/api/categories/${id}`, { name: 'Pet care', color: '#00ff00' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Pet care');
  });

  it('deletes a category and leaves its transactions uncategorised', async () => {
    const { id } = (await api.post('/api/categories', { name: 'Pets' })).body;
    const txId = addTx(db, userId, { amount: 10, categoryId: id });
    expect((await api.del(`/api/categories/${id}`)).status).toBe(204);
    expect((await api.get('/api/categories')).body.map((c) => c.id)).not.toContain(id);
    expect(db.prepare('SELECT category_id FROM transactions WHERE id = ?').get(txId).category_id).toBeNull();
  });

  it("does not show one user's categories to another", async () => {
    await api.post('/api/categories', { name: 'Pets' });
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.get('/api/categories')).body.map((c) => c.name)).not.toContain('Pets');
  });
});
