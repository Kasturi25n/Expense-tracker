import { Router } from 'express';
import { ownedAccount, requireDate } from '../validate.js';
import { accountBalances } from './accounts.js';

const round = (n) => Math.round(n * 100) / 100;

export function createSummaryRouter(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const { from, to } = req.query;
    requireDate(from, 'From');
    requireDate(to, 'To');
    const accountId = req.query.accountId ? Number(req.query.accountId) : null;
    if (accountId !== null) ownedAccount(db, req.userId, accountId, 'Account', [accountId]);

    const range = 'user_id = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ? AND (? IS NULL OR account_id = ?)';
    const params = [req.userId, from, to, accountId, accountId];
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
         FROM transactions WHERE ${range}`
      )
      .get(...params);
    const byCategory = db
      .prepare(
        `SELECT category_id AS categoryId, ROUND(SUM(amount), 2) AS total FROM transactions
         WHERE ${range} AND type = 'expense' GROUP BY category_id ORDER BY total DESC`
      )
      .all(...params);
    const spentByAccount = new Map(
      db
        .prepare(
          `SELECT account_id, SUM(amount) AS spent FROM transactions
           WHERE user_id = ? AND type = 'expense' AND substr(occurred_at, 1, 10) BETWEEN ? AND ? GROUP BY account_id`
        )
        .all(req.userId, from, to)
        .map((r) => [r.account_id, r.spent])
    );

    res.json({
      income: round(totals.income),
      expense: round(totals.expense),
      net: round(totals.income - totals.expense),
      byCategory,
      accounts: accountBalances(db, req.userId)
        .filter((a) => !a.archived)
        .map((a) => ({ ...a, spent: round(spentByAccount.get(a.id) ?? 0) })),
    });
  });

  return router;
}
