import { Router } from 'express';
import { inTransaction } from '../db.js';

const KINDS = ['expense', 'income'];

export function createCategoriesRouter(db) {
  const router = Router();
  const getOne = (userId, id) =>
    db.prepare('SELECT id, name, color, kind FROM categories WHERE id = ? AND user_id = ?').get(id, userId);

  router.get('/', (req, res) => {
    res.json(db.prepare('SELECT id, name, color, kind FROM categories WHERE user_id = ? ORDER BY kind, name').all(req.userId));
  });

  router.post('/', (req, res) => {
    const { name, color } = req.body ?? {};
    const kind = req.body?.kind ?? 'expense';
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required' });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Kind must be expense or income' });
    const info = db
      .prepare('INSERT INTO categories (user_id, name, color, kind) VALUES (?, ?, ?, ?)')
      .run(req.userId, String(name).trim(), color || '#888888', kind);
    res.status(201).json(getOne(req.userId, Number(info.lastInsertRowid)));
  });

  router.put('/:id', (req, res) => {
    if (!getOne(req.userId, req.params.id)) return res.status(404).json({ error: 'Category not found' });
    const { name, color } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Category name is required' });
    db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(String(name).trim(), color || '#888888', req.params.id);
    res.json(getOne(req.userId, req.params.id));
  });

  router.delete('/:id', (req, res) => {
    if (!getOne(req.userId, req.params.id)) return res.status(404).json({ error: 'Category not found' });
    inTransaction(db, () => {
      db.prepare('UPDATE transactions SET category_id = NULL WHERE category_id = ?').run(req.params.id);
      db.prepare('DELETE FROM budgets WHERE category_id = ?').run(req.params.id);
      db.prepare('DELETE FROM category_rules WHERE category_id = ?').run(req.params.id);
      db.prepare('UPDATE recurring_rules SET category_id = NULL WHERE category_id = ?').run(req.params.id);
      db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    });
    res.status(204).end();
  });

  return router;
}
