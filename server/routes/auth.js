import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { inTransaction } from '../db.js';
import { seedStarterData } from '../seed.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Emails are matched without regard to case or stray spaces, so "Me@Mail.com " and "me@mail.com" are one account.
const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export function createAuthRouter(db, jwtSecret) {
  const router = Router();

  router.post('/register', (req, res) => {
    const { password } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const userId = inTransaction(db, () => {
      const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, passwordHash);
      const id = Number(info.lastInsertRowid);
      seedStarterData(db, id);
      return id;
    });
    const token = jwt.sign({ userId }, jwtSecret, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: userId, email } });
  });

  router.post('/login', (req, res) => {
    const { password } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);
    if (!email || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE lower(email) = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email } });
  });

  return router;
}
