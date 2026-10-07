import { Router } from 'express';

export function createCategoriesRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const rows = db
      .prepare('SELECT id, name, color FROM categories WHERE user_id = ? ORDER BY name')
      .all(req.userId);
    res.json(rows);
  });

  router.post('/', (req, res) => {
    const { name, color } = req.body ?? {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    const info = db
      .prepare('INSERT INTO categories (user_id, name, color) VALUES (?, ?, ?)')
      .run(req.userId, name.trim(), color || '#888888');
    res.status(201).json({ id: Number(info.lastInsertRowid), name: name.trim(), color: color || '#888888' });
  });

  router.put('/:id', (req, res) => {
    const { name, color } = req.body ?? {};
    const existing = db
      .prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);
    if (!existing) {
      return res.status(404).json({ error: 'Category not found' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(
      name.trim(),
      color || '#888888',
      req.params.id
    );
    res.json({ id: Number(req.params.id), name: name.trim(), color: color || '#888888' });
  });

  router.delete('/:id', (req, res) => {
    const existing = db
      .prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);
    if (!existing) {
      return res.status(404).json({ error: 'Category not found' });
    }
    db.prepare('UPDATE expenses SET category_id = NULL WHERE category_id = ?').run(req.params.id);
    db.prepare('DELETE FROM budgets WHERE category_id = ?').run(req.params.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
    res.status(204).end();
  });

  return router;
}
