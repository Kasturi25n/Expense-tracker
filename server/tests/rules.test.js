import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, client, catId } from './helpers.js';

describe('rules API', () => {
  let app, db, userId, api;
  beforeEach(async () => {
    ({ app, db } = freshApp());
    const s = await signup(app);
    userId = s.userId;
    api = client(app, s.token);
  });

  it('lists starter rules with category names', async () => {
    const res = await api.get('/api/rules');
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual(expect.objectContaining({ match_text: 'swiggy', category_name: 'Food & Dining' }));
  });

  it('adds a rule, trimming and lower-casing the word', async () => {
    const res = await api.post('/api/rules', { matchText: '  Chaayos ', categoryId: catId(db, userId, 'Food & Dining') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ match_text: 'chaayos', category_name: 'Food & Dining' });
  });

  it('re-points an existing word instead of duplicating it', async () => {
    const res = await api.post('/api/rules', { matchText: 'Swiggy', categoryId: catId(db, userId, 'Groceries') });
    expect(res.status).toBe(200);
    const swiggy = (await api.get('/api/rules')).body.filter((r) => r.match_text === 'swiggy');
    expect(swiggy).toHaveLength(1);
    expect(swiggy[0].category_name).toBe('Groceries');
  });

  it("rejects empty words and other users' categories", async () => {
    expect((await api.post('/api/rules', { matchText: ' ', categoryId: catId(db, userId, 'Groceries') })).status).toBe(400);
    const other = await signup(app, 'other@example.com');
    expect((await api.post('/api/rules', { matchText: 'x', categoryId: catId(db, other.userId, 'Groceries') })).status).toBe(400);
  });

  it('deletes only your own rules', async () => {
    const rule = (await api.get('/api/rules')).body[0];
    const other = client(app, (await signup(app, 'other@example.com')).token);
    expect((await other.del(`/api/rules/${rule.id}`)).status).toBe(404);
    expect((await api.del(`/api/rules/${rule.id}`)).status).toBe(204);
  });

  it("removes a category's rules when the category is deleted", async () => {
    const food = catId(db, userId, 'Food & Dining');
    expect((await api.del(`/api/categories/${food}`)).status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM category_rules WHERE category_id = ?').get(food).n).toBe(0);
  });
});
