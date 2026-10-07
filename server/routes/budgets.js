import { Router } from 'express';

export function createBudgetsRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const { month } = req.query;
    let sql = 'SELECT * FROM budgets WHERE user_id = ?';
    const params = [req.userId];
    if (month) {
      sql += ' AND month = ?';
      params.push(month);
    }
    res.json(db.prepare(sql).all(...params));
  });

  router.post('/', (req, res) => {
    const { categoryId, month, amount } = req.body ?? {};
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Month is required in YYYY-MM format' });
    }
    if (typeof amount !== 'number' || Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A positive numeric amount is required' });
    }
    const info = db
      .prepare('INSERT INTO budgets (user_id, category_id, month, amount) VALUES (?, ?, ?, ?)')
      .run(req.userId, categoryId ?? null, month, amount);
    const row = db.prepare('SELECT * FROM budgets WHERE id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json(row);
  });

  router.delete('/:id', (req, res) => {
    const existing = db
      .prepare('SELECT id FROM budgets WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);
    if (!existing) {
      return res.status(404).json({ error: 'Budget not found' });
    }
    db.prepare('DELETE FROM budgets WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  // Budget vs actual spend for a given month, per category plus overall.
  router.get('/status/:month', (req, res) => {
    const { month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Month must be in YYYY-MM format' });
    }

    const budgets = db.prepare('SELECT * FROM budgets WHERE user_id = ? AND month = ?').all(req.userId, month);
    const spendByCategory = db
      .prepare(
        `SELECT category_id, SUM(amount) as total FROM expenses
         WHERE user_id = ? AND date LIKE ? GROUP BY category_id`
      )
      .all(req.userId, `${month}%`);
    const spendMap = new Map(spendByCategory.map((r) => [r.category_id, r.total]));
    const overallSpend = spendByCategory.reduce((sum, r) => sum + r.total, 0);

    const results = budgets.map((b) => ({
      ...b,
      spent: b.category_id === null ? overallSpend : spendMap.get(b.category_id) || 0,
    }));
    results.forEach((r) => {
      r.overBudget = r.spent > r.amount;
    });

    res.json(results);
  });

  return router;
}
