import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { freshApp } from './helpers.js';

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
});
