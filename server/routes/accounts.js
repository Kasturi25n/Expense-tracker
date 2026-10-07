import { Router } from 'express';
import { ValidationError, requireOneOf } from '../validate.js';

export const ACCOUNT_TYPES = ['cash', 'bank', 'credit_card', 'wallet'];

export function accountBalances(db, userId) {
  return db
    .prepare(
      `SELECT a.id, a.name, a.type, a.opening_balance, a.archived,
         ROUND(a.opening_balance
           + COALESCE((SELECT SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE -t.amount END)
                       FROM transactions t WHERE t.account_id = a.id), 0)
           + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.to_account_id = a.id), 0), 2) AS balance
       FROM accounts a WHERE a.user_id = ? ORDER BY a.archived, a.id`
    )
    .all(userId);
}

function parseAccount(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new ValidationError('Account name is required');
  requireOneOf(body.type, ACCOUNT_TYPES, 'Account type');
  const openingBalance = body.openingBalance ?? 0;
  if (typeof openingBalance !== 'number' || !Number.isFinite(openingBalance)) {
    throw new ValidationError('Balance must be a number');
  }
  return { name, type: body.type, openingBalance };
}

export function createAccountsRouter(db) {
  const router = Router();
  const owned = (userId, id) => db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(id, userId);
  const withBalance = (userId, id) => accountBalances(db, userId).find((a) => a.id === Number(id));

  router.get('/', (req, res) => res.json(accountBalances(db, req.userId)));

  router.post('/', (req, res) => {
    const a = parseAccount(req.body);
    const info = db
      .prepare('INSERT INTO accounts (user_id, name, type, opening_balance) VALUES (?, ?, ?, ?)')
      .run(req.userId, a.name, a.type, a.openingBalance);
    res.status(201).json(withBalance(req.userId, info.lastInsertRowid));
  });

  router.put('/:id', (req, res) => {
    if (!owned(req.userId, req.params.id)) return res.status(404).json({ error: 'Account not found' });
    const a = parseAccount(req.body);
    db.prepare('UPDATE accounts SET name = ?, type = ?, opening_balance = ?, archived = ? WHERE id = ?')
      .run(a.name, a.type, a.openingBalance, req.body.archived ? 1 : 0, req.params.id);
    res.json(withBalance(req.userId, req.params.id));
  });

  router.delete('/:id', (req, res) => {
    const id = req.params.id;
    if (!owned(req.userId, id)) return res.status(404).json({ error: 'Account not found' });
    const { n } = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM transactions WHERE account_id = ? OR to_account_id = ?)
              + (SELECT COUNT(*) FROM recurring_rules WHERE account_id = ? OR to_account_id = ?) AS n`
      )
      .get(id, id, id, id);
    if (n) return res.status(409).json({ error: 'This account has transactions. Archive it instead to hide it.' });
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    res.status(204).end();
  });

  return router;
}
