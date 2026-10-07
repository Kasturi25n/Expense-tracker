import { Router } from 'express';

export function createExpensesRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const { from, to, categoryId, q } = req.query;
    let sql = 'SELECT * FROM expenses WHERE user_id = ?';
    const params = [req.userId];

    if (from) {
      sql += ' AND substr(date, 1, 10) >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND substr(date, 1, 10) <= ?';
      params.push(to);
    }
    if (categoryId) {
      sql += ' AND category_id = ?';
      params.push(categoryId);
    }
    if (q) {
      sql += ' AND description LIKE ?';
      params.push(`%${q}%`);
    }
    sql += ' ORDER BY date DESC, id DESC';

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  });

  router.post('/', (req, res) => {
    const { amount, description, date, categoryId } = req.body ?? {};
    if (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A positive numeric amount is required' });
    }
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    const info = db
      .prepare(
        'INSERT INTO expenses (user_id, category_id, amount, description, date) VALUES (?, ?, ?, ?, ?)'
      )
      .run(req.userId, categoryId ?? null, amount, description ?? '', date);
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json(row);
  });

  router.put('/:id', (req, res) => {
    const existing = db
      .prepare('SELECT id FROM expenses WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    const { amount, description, date, categoryId } = req.body ?? {};
    if (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A positive numeric amount is required' });
    }
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    db.prepare(
      'UPDATE expenses SET amount = ?, description = ?, date = ?, category_id = ? WHERE id = ?'
    ).run(amount, description ?? '', date, categoryId ?? null, req.params.id);
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(req.params.id));
    res.json(row);
  });

  router.delete('/:id', (req, res) => {
    const existing = db
      .prepare('SELECT id FROM expenses WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);
    if (!existing) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  return router;
}
