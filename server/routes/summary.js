import { Router } from 'express';
import { requireDate } from '../validate.js';
import { accountBalances } from './accounts.js';

const round = (n) => Math.round(n * 100) / 100;

export function createSummaryRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const { from, to } = req.query;
    requireDate(from, 'From');
    requireDate(to, 'To');
    const range = 'user_id = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ?';
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
         FROM transactions WHERE ${range}`
      )
      .get(req.userId, from, to);
    const byCategory = db
      .prepare(
        `SELECT category_id AS categoryId, ROUND(SUM(amount), 2) AS total FROM transactions
         WHERE ${range} AND type = 'expense' GROUP BY category_id ORDER BY total DESC`
      )
      .all(req.userId, from, to);

    res.json({
      income: round(totals.income),
      expense: round(totals.expense),
      net: round(totals.income - totals.expense),
      byCategory,
      accounts: accountBalances(db, req.userId).filter((a) => !a.archived),
    });
  });

  return router;
}
