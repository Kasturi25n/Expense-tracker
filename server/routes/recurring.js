import { Router } from 'express';
import { inTransaction } from '../db.js';
import { ValidationError, ownedAccount, requireAmount, requireDate, requireDateTime, requireOneOf, validateMovement } from '../validate.js';
import { FREQUENCIES, addDays, addPeriod, advance, occurrencesBetween, postOccurrence } from '../services/recurring.js';

const MODES = ['auto', 'confirm'];

const occurrence = (r, date) => ({
  ruleId: r.id, date, amount: r.amount, type: r.type, payee: r.payee, mode: r.mode,
  category_id: r.category_id, account_id: r.account_id, to_account_id: r.to_account_id,
});

export function createRecurringRouter(db, today) {
  const router = Router();
  const owned = (userId, id) => db.prepare('SELECT * FROM recurring_rules WHERE id = ? AND user_id = ?').get(id, userId);

  const parseRule = (userId, body, allowArchivedIds) => {
    const m = validateMovement(db, userId, body, allowArchivedIds);
    requireOneOf(body.frequency, FREQUENCIES, 'Frequency');
    requireDate(body.nextDate, 'Next date');
    const endDate = body.endDate || null;
    if (endDate) {
      requireDate(endDate, 'End date');
      if (endDate < body.nextDate) throw new ValidationError('End date must be after the next date');
    }
    const mode = body.mode ?? 'auto';
    requireOneOf(mode, MODES, 'Mode');
    return { ...m, frequency: body.frequency, nextDate: body.nextDate, endDate, mode };
  };

  const dueRule = (req) => {
    const rule = owned(req.userId, req.params.id);
    if (!rule) return null;
    if (!rule.active || rule.next_date > today()) throw new ValidationError('Nothing is due for this item yet');
    return rule;
  };

  router.get('/', (req, res) => {
    const rules = db.prepare('SELECT * FROM recurring_rules WHERE user_id = ? ORDER BY active DESC, next_date').all(req.userId);
    const now = today();
    const pending = rules
      .filter((r) => r.active && r.mode === 'confirm')
      .flatMap((r) => occurrencesBetween(r, now).dates.map((date) => occurrence(r, date)))
      .sort((a, b) => a.date.localeCompare(b.date));
    res.json({ rules, pending });
  });

  router.get('/upcoming', (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const now = today();
    const until = addDays(now, days);
    const items = db
      .prepare('SELECT * FROM recurring_rules WHERE user_id = ? AND active = 1')
      .all(req.userId)
      .flatMap((r) => occurrencesBetween(r, until).dates.filter((d) => d > now).map((date) => occurrence(r, date)))
      .sort((a, b) => a.date.localeCompare(b.date));
    res.json(items);
  });

  router.post('/', (req, res) => {
    const r = parseRule(req.userId, req.body ?? {});
    const info = db
      .prepare(
        `INSERT INTO recurring_rules (user_id, type, amount, account_id, to_account_id, category_id, payee, note,
           frequency, anchor_day, start_date, end_date, next_date, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(req.userId, r.type, r.amount, r.accountId, r.toAccountId, r.categoryId, r.payee, r.note,
        r.frequency, Number(r.nextDate.slice(8, 10)), r.nextDate, r.endDate, r.nextDate, r.mode);
    res.status(201).json(owned(req.userId, Number(info.lastInsertRowid)));
  });

  router.put('/:id', (req, res) => {
    const existing = owned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Repeating item not found' });
    const r = parseRule(req.userId, req.body ?? {}, [existing.account_id, existing.to_account_id]);
    const active = req.body.active === undefined ? Boolean(existing.active) : Boolean(req.body.active);
    const anchorDay = r.nextDate === existing.next_date ? existing.anchor_day : Number(r.nextDate.slice(8, 10));
    let nextDate = r.nextDate;
    if (active && !existing.active) {
      // Resuming: the paused period didn't happen, so jump to the first date from today on.
      const now = today();
      while (nextDate < now) nextDate = addPeriod(nextDate, r.frequency, anchorDay);
    }
    db.prepare(
      `UPDATE recurring_rules SET type = ?, amount = ?, account_id = ?, to_account_id = ?, category_id = ?, payee = ?, note = ?,
         frequency = ?, anchor_day = ?, end_date = ?, next_date = ?, mode = ?, active = ? WHERE id = ?`
    ).run(r.type, r.amount, r.accountId, r.toAccountId, r.categoryId, r.payee, r.note,
      r.frequency, anchorDay, r.endDate, nextDate, r.mode, active ? 1 : 0, existing.id);
    res.json(owned(req.userId, existing.id));
  });

  router.delete('/:id', (req, res) => {
    const existing = owned(req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Repeating item not found' });
    inTransaction(db, () => {
      db.prepare('UPDATE transactions SET recurring_id = NULL WHERE recurring_id = ?').run(existing.id);
      db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(existing.id);
    });
    res.status(204).end();
  });

  router.post('/:id/confirm', (req, res) => {
    const rule = dueRule(req);
    if (!rule) return res.status(404).json({ error: 'Repeating item not found' });
    ownedAccount(db, req.userId, rule.account_id);
    if (rule.to_account_id) ownedAccount(db, req.userId, rule.to_account_id, 'Destination account');
    const amount = req.body?.amount ?? rule.amount;
    requireAmount(amount);
    const occurredAt = req.body?.occurredAt ?? rule.next_date;
    requireDateTime(occurredAt);
    const txId = inTransaction(db, () => {
      const id = postOccurrence(db, rule, occurredAt, amount);
      advance(db, rule, addPeriod(rule.next_date, rule.frequency, rule.anchor_day));
      return id;
    });
    res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId));
  });

  router.post('/:id/skip', (req, res) => {
    const rule = dueRule(req);
    if (!rule) return res.status(404).json({ error: 'Repeating item not found' });
    advance(db, rule, addPeriod(rule.next_date, rule.frequency, rule.anchor_day));
    res.json(owned(req.userId, rule.id));
  });

  return router;
}
