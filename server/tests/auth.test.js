import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { freshApp, signup, client } from './helpers.js';

const creds = { email: 'a@b.com', password: 'password123' };

describe('auth', () => {
  it('registers a new user and returns a token', async () => {
    const { app } = freshApp();
    const res = await request(app).post('/api/auth/register').send(creds);
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe('a@b.com');
  });

  it('rejects duplicate email registration', async () => {
    const { app } = freshApp();
    await request(app).post('/api/auth/register').send(creds);
    expect((await request(app).post('/api/auth/register').send(creds)).status).toBe(409);
  });

  it('logs in with correct credentials and rejects a wrong password', async () => {
    const { app } = freshApp();
    await request(app).post('/api/auth/register').send(creds);
    const ok = await request(app).post('/api/auth/login').send(creds);
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect((await request(app).post('/api/auth/login').send({ ...creds, password: 'wrong' })).status).toBe(401);
  });

  it('rejects protected routes without a token', async () => {
    const { app } = freshApp();
    expect((await request(app).get('/api/categories')).status).toBe(401);
  });

  it('answers malformed JSON with 400, not a crash', async () => {
    const { app } = freshApp();
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid JSON/);
  });

  it('gives a new user a Cash account, starter categories and merchant rules', async () => {
    const { app, db } = freshApp();
    const { token, userId } = await signup(app);
    const cats = (await client(app, token).get('/api/categories')).body;
    expect(cats.find((c) => c.name === 'Food & Dining')).toMatchObject({ kind: 'expense' });
    expect(cats.find((c) => c.name === 'Salary')).toMatchObject({ kind: 'income' });
    expect(cats).toHaveLength(17);
    expect(db.prepare('SELECT name, type FROM accounts WHERE user_id = ?').all(userId)).toEqual([{ name: 'Cash', type: 'cash' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM category_rules WHERE user_id = ?').get(userId).n).toBe(27);
  });
});
