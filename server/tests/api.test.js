import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDb } from '../db.js';
import { createApp } from '../app.js';

function freshApp() {
  const db = createDb(':memory:');
  const app = createApp(db, 'test-secret');
  return app;
}

async function registerAndLogin(app, email = 'user@example.com', password = 'password123') {
  const res = await request(app).post('/api/auth/register').send({ email, password });
  return res.body.token;
}

describe('auth', () => {
  let app;
  beforeEach(() => {
    app = freshApp();
  });

  it('registers a new user and returns a token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@b.com', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe('a@b.com');
  });

  it('rejects duplicate email registration', async () => {
    await request(app).post('/api/auth/register').send({ email: 'a@b.com', password: 'password123' });
    const res = await request(app).post('/api/auth/register').send({ email: 'a@b.com', password: 'password123' });
    expect(res.status).toBe(409);
  });

  it('logs in with correct credentials', async () => {
    await request(app).post('/api/auth/register').send({ email: 'a@b.com', password: 'password123' });
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('rejects login with wrong password', async () => {
    await request(app).post('/api/auth/register').send({ email: 'a@b.com', password: 'password123' });
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects protected routes without a token', async () => {
    const res = await request(app).get('/api/expenses');
    expect(res.status).toBe(401);
  });
});

describe('categories CRUD', () => {
  let app, token;
  beforeEach(async () => {
    app = freshApp();
    token = await registerAndLogin(app);
  });

  it('creates and lists categories', async () => {
    await request(app).post('/api/categories').set('Authorization', `Bearer ${token}`).send({ name: 'Food', color: '#ff0000' });
    const res = await request(app).get('/api/categories').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Food');
  });

  it('updates a category', async () => {
    const create = await request(app).post('/api/categories').set('Authorization', `Bearer ${token}`).send({ name: 'Food' });
    const res = await request(app)
      .put(`/api/categories/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Groceries', color: '#00ff00' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Groceries');
  });

  it('deletes a category', async () => {
    const create = await request(app).post('/api/categories').set('Authorization', `Bearer ${token}`).send({ name: 'Food' });
    const res = await request(app).delete(`/api/categories/${create.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    const list = await request(app).get('/api/categories').set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(0);
  });

  it('does not allow one user to see another user\'s categories', async () => {
    await request(app).post('/api/categories').set('Authorization', `Bearer ${token}`).send({ name: 'Food' });
    const otherToken = await registerAndLogin(app, 'other@example.com');
    const res = await request(app).get('/api/categories').set('Authorization', `Bearer ${otherToken}`);
    expect(res.body).toHaveLength(0);
  });
});

describe('expenses CRUD and filtering', () => {
  let app, token, categoryId;
  beforeEach(async () => {
    app = freshApp();
    token = await registerAndLogin(app);
    const cat = await request(app).post('/api/categories').set('Authorization', `Bearer ${token}`).send({ name: 'Food' });
    categoryId = cat.body.id;
  });

  it('creates an expense', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 25.5, description: 'Lunch', date: '2026-09-15', categoryId });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(25.5);
  });

  it('rejects a non-positive amount', async () => {
    const res = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: -5, date: '2026-09-15' });
    expect(res.status).toBe(400);
  });

  it('updates and deletes an expense', async () => {
    const create = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, date: '2026-09-15', categoryId });
    const update = await request(app)
      .put(`/api/expenses/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 20, date: '2026-09-16', categoryId });
    expect(update.status).toBe(200);
    expect(update.body.amount).toBe(20);

    const del = await request(app).delete(`/api/expenses/${create.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
  });

  it('filters expenses by date range, category, and text search', async () => {
    await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`).send({ amount: 10, description: 'Coffee', date: '2026-09-01', categoryId });
    await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`).send({ amount: 20, description: 'Groceries', date: '2026-09-15', categoryId });
    await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`).send({ amount: 30, description: 'Rent', date: '2026-09-30' });

    const byDate = await request(app)
      .get('/api/expenses?from=2026-09-10&to=2026-09-20')
      .set('Authorization', `Bearer ${token}`);
    expect(byDate.body).toHaveLength(1);
    expect(byDate.body[0].description).toBe('Groceries');

    const byCategory = await request(app)
      .get(`/api/expenses?categoryId=${categoryId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(byCategory.body).toHaveLength(2);

    const byText = await request(app).get('/api/expenses?q=Rent').set('Authorization', `Bearer ${token}`);
    expect(byText.body).toHaveLength(1);
    expect(byText.body[0].description).toBe('Rent');
  });

  it('includes expenses with a time on the last day of the date range', async () => {
    await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`).send({ amount: 10, description: 'Dinner', date: '2026-09-20T21:30' });

    const res = await request(app)
      .get('/api/expenses?from=2026-09-20&to=2026-09-20')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].date).toBe('2026-09-20T21:30');
  });
});

describe('budgets', () => {
  let app, token, categoryId;
  beforeEach(async () => {
    app = freshApp();
    token = await registerAndLogin(app);
    const cat = await request(app).post('/api/categories').set('Authorization', `Bearer ${token}`).send({ name: 'Food' });
    categoryId = cat.body.id;
  });

  it('creates a budget and reports over-budget status', async () => {
    await request(app)
      .post('/api/budgets')
      .set('Authorization', `Bearer ${token}`)
      .send({ categoryId, month: '2026-09', amount: 50 });

    await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`).send({ amount: 60, date: '2026-09-05', categoryId });

    const status = await request(app).get('/api/budgets/status/2026-09').set('Authorization', `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body).toHaveLength(1);
    expect(status.body[0].spent).toBe(60);
    expect(status.body[0].overBudget).toBe(true);
  });

  it('rejects an invalid month format', async () => {
    const res = await request(app)
      .post('/api/budgets')
      .set('Authorization', `Bearer ${token}`)
      .send({ month: 'not-a-month', amount: 50 });
    expect(res.status).toBe(400);
  });
});

describe('csv export', () => {
  it('exports expenses as csv', async () => {
    const app = freshApp();
    const token = await registerAndLogin(app);
    await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`).send({ amount: 15, description: 'Snack, salty', date: '2026-09-10' });

    const res = await request(app).get('/api/export/csv').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('date,amount,description,category');
    expect(res.text).toContain('"Snack, salty"');
  });
});
