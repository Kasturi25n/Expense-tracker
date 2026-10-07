import { Router } from 'express';
import { inTransaction } from '../db.js';
import { ValidationError, requireDateTime, validateMovement } from '../validate.js';
import { suggestCategory } from '../services/categorize.js';

function normalizeTags(tags) {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags)) throw new ValidationError('Tags must be a list');
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();
}

export function createTransactionsRouter(db) {
  const router = Router();

  const setTags = (userId, txId, tags) => {
    db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(txId);
    for (const name of tags) {
      db.prepare('INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)').run(userId, name);
      const tag = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, name);
      db.prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(txId, tag.id);
    }
  };

  const withTags = (rows) => {
    if (!rows.length) return rows;
    const placeholders = rows.map(() => '?').join(',');
    const tagRows = db
      .prepare(
        `SELECT tt.transaction_id, g.name FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
         WHERE tt.transaction_id IN (${placeholders}) ORDER BY g.name`
      )
      .all(...rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, tags: tagRows.filter((t) => t.transaction_id === r.id).map((t) => t.name) }));
  };

  const getOne = (userId, id) => {
    const row = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, userId);
    return row ? withTags([row])[0] : null;
  };

  router.get('/defaults', (req, res) => {
    const recent = db
      .prepare(
        `SELECT t.account_id FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = ? AND a.archived = 0 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`
      )
      .get(req.userId);
    const first = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND archived = 0 ORDER BY id LIMIT 1').get(req.userId);
    res.json({ accountId: recent?.account_id ?? first?.id ?? null });
  });

  router.get('/payees', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const type = req.query.type === 'income' ? 'income' : 'expense';
    const rows = db
      .prepare(
        `SELECT payee, COUNT(*) AS uses FROM transactions
         WHERE user_id = ? AND type = ? AND payee != '' AND payee LIKE ?
         GROUP BY lower(payee) ORDER BY uses DESC, MAX(occurred_at) DESC LIMIT 10`
      )
      .all(req.userId, type, `%${q}%`);
    res.json({
      payees: rows.map((r) => r.payee),
      suggestedCategoryId: q ? suggestCategory(db, req.userId, { payee: q, type }) : null,
    });
  });

  router.get('/tags', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT g.name, COUNT(tt.transaction_id) AS uses FROM tags g
           LEFT JOIN transaction_tags tt ON tt.tag_id = g.id
           WHERE g.user_id = ? GROUP BY g.id ORDER BY uses DESC, g.name`
        )
        .all(req.userId)
    );
  });

  router.get('/', (req, res) => {
    const { from, to, type, accountId, categoryId, tag, q } = req.query;
    const where = ['t.user_id = ?'];
    const params = [req.userId];
    if (from) { where.push('substr(t.occurred_at, 1, 10) >= ?'); params.push(from); }
    if (to) { where.push('substr(t.occurred_at, 1, 10) <= ?'); params.push(to); }
    if (type) { where.push('t.type = ?'); params.push(type); }
    if (accountId) { where.push('(t.account_id = ? OR t.to_account_id = ?)'); params.push(accountId, accountId); }
    if (categoryId) { where.push('t.category_id = ?'); params.push(categoryId); }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = t.id AND g.name = ?)');
      params.push(String(tag).toLowerCase());
    }
    if (q) { where.push('(t.payee LIKE ? OR t.note LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const whereSql = where.join(' AND ');
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM transactions t WHERE ${whereSql}`).get(...params);
    const items = db
      .prepare(`SELECT t.* FROM transactions t WHERE ${whereSql} ORDER BY t.occurred_at DESC, t.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    res.json({ items: withTags(items), total });
  });

  router.post('/', (req, res) => {
    const m = validateMovement(db, req.userId, req.body);
    requireDateTime(req.body.occurredAt);
    const tags = normalizeTags(req.body.tags) ?? [];
    if (req.body.categoryId === undefined && m.type !== 'transfer') {
      m.categoryId = suggestCategory(db, req.userId, { payee: m.payee, note: m.note, type: m.type });
    }
    const id = inTransaction(db, () => {
      const info = db
        .prepare(
          `INSERT INTO transactions (user_id, type, amount, occurred_at, account_id, to_account_id, category_id, payee, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.userId, m.type, m.amount, req.body.occurredAt, m.accountId, m.toAccountId, m.categoryId, m.payee, m.note);
      const txId = Number(info.lastInsertRowid);
      setTags(req.userId, txId, tags);
      return txId;
    });
    res.status(201).json(getOne(req.userId, id));
  });

  router.put('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });
    const m = validateMovement(db, req.userId, req.body, [existing.account_id, existing.to_account_id]);
    requireDateTime(req.body.occurredAt);
    const tags = normalizeTags(req.body.tags);
    inTransaction(db, () => {
      db.prepare(
        `UPDATE transactions SET type = ?, amount = ?, occurred_at = ?, account_id = ?, to_account_id = ?,
           category_id = ?, payee = ?, note = ? WHERE id = ?`
      ).run(m.type, m.amount, req.body.occurredAt, m.accountId, m.toAccountId, m.categoryId, m.payee, m.note, existing.id);
      if (tags !== undefined) setTags(req.userId, existing.id, tags);
    });
    res.json(getOne(req.userId, existing.id));
  });

  router.delete('/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM transactions WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });
    inTransaction(db, () => {
      db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(existing.id);
      db.prepare('DELETE FROM transactions WHERE id = ?').run(existing.id);
    });
    res.status(204).end();
  });

  return router;
}
