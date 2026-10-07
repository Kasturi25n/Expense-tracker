import { Router } from 'express';
import { ValidationError, ownedCategory } from '../validate.js';

const SELECT_RULE = `SELECT r.id, r.match_text, r.category_id, c.name AS category_name
  FROM category_rules r JOIN categories c ON c.id = r.category_id`;

export function createRulesRouter(db) {
  const router = Router();
  const getOne = (id) => db.prepare(`${SELECT_RULE} WHERE r.id = ?`).get(id);

  router.get('/', (req, res) => {
    res.json(db.prepare(`${SELECT_RULE} WHERE r.user_id = ? ORDER BY c.name, r.match_text`).all(req.userId));
  });

  router.post('/', (req, res) => {
    const matchText = String(req.body?.matchText ?? '').trim().toLowerCase();
    if (!matchText) throw new ValidationError('Enter the word to match, e.g. "swiggy"');
    ownedCategory(db, req.userId, req.body.categoryId);

    const existing = db.prepare('SELECT id FROM category_rules WHERE user_id = ? AND match_text = ?').get(req.userId, matchText);
    if (existing) {
      db.prepare('UPDATE category_rules SET category_id = ? WHERE id = ?').run(req.body.categoryId, existing.id);
      return res.json(getOne(existing.id));
    }
    const info = db
      .prepare('INSERT INTO category_rules (user_id, match_text, category_id) VALUES (?, ?, ?)')
      .run(req.userId, matchText, req.body.categoryId);
    res.status(201).json(getOne(Number(info.lastInsertRowid)));
  });

  router.delete('/:id', (req, res) => {
    const rule = db.prepare('SELECT id FROM category_rules WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    db.prepare('DELETE FROM category_rules WHERE id = ?').run(rule.id);
    res.status(204).end();
  });

  return router;
}
