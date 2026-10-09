import { Router } from 'express';
import { inTransaction } from '../db.js';
import { ValidationError, requireAmount, requireDate } from '../validate.js';
import { listGoals } from '../services/goals.js';

function parseGoal(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new ValidationError('Give the goal a name, e.g. "Goa trip"');
  if (name.length > 60) throw new ValidationError('Keep the goal name under 60 characters');
  requireAmount(body.targetAmount);
  const targetDate = body.targetDate || null;
  if (targetDate !== null) requireDate(targetDate, 'Deadline');
  return { name, targetAmount: body.targetAmount, targetDate };
}

export function createGoalsRouter(db, today) {
  const router = Router();
  const one = (userId, id) => listGoals(db, userId, today()).find((g) => g.id === Number(id));

  router.param('id', (req, res, next) => {
    req.goal = one(req.userId, req.params.id);
    if (!req.goal) return res.status(404).json({ error: 'Goal not found' });
    next();
  });

  router.get('/', (req, res) => res.json(listGoals(db, req.userId, today())));

  router.post('/', (req, res) => {
    const g = parseGoal(req.body);
    const info = db
      .prepare('INSERT INTO goals (user_id, name, target_amount, target_date) VALUES (?, ?, ?, ?)')
      .run(req.userId, g.name, g.targetAmount, g.targetDate);
    res.status(201).json(one(req.userId, info.lastInsertRowid));
  });

  router.put('/:id', (req, res) => {
    const g = parseGoal(req.body);
    db.prepare('UPDATE goals SET name = ?, target_amount = ?, target_date = ? WHERE id = ?').run(g.name, g.targetAmount, g.targetDate, req.goal.id);
    res.json(one(req.userId, req.goal.id));
  });

  router.delete('/:id', (req, res) => {
    inTransaction(db, () => {
      db.prepare('DELETE FROM goal_contributions WHERE goal_id = ?').run(req.goal.id);
      db.prepare('DELETE FROM goals WHERE id = ?').run(req.goal.id);
    });
    res.status(204).end();
  });

  // A negative amount is money taken back out of the goal.
  router.post('/:id/contributions', (req, res) => {
    const { amount, note = '' } = req.body ?? {};
    requireAmount(Math.abs(amount));
    if (typeof amount !== 'number') throw new ValidationError('Amount must be a number');
    if (req.goal.saved + amount < 0) throw new ValidationError("You can't take out more than you've saved");
    const date = req.body.date ?? today();
    requireDate(date);
    db.prepare('INSERT INTO goal_contributions (goal_id, amount, date, note) VALUES (?, ?, ?, ?)')
      .run(req.goal.id, amount, date, String(note).trim().slice(0, 200));
    res.status(201).json(one(req.userId, req.goal.id));
  });

  router.delete('/:id/contributions/:contributionId', (req, res) => {
    const entry = req.goal.contributions.find((c) => c.id === Number(req.params.contributionId));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (req.goal.saved - entry.amount < 0) throw new ValidationError('Removing this would leave the goal below zero. Remove the money taken out first.');
    db.prepare('DELETE FROM goal_contributions WHERE id = ?').run(entry.id);
    res.json(one(req.userId, req.goal.id));
  });

  return router;
}
