import { Router } from 'express';
import { ValidationError, ownedAccount } from '../validate.js';
import { buildMonthReport } from '../services/insights.js';

export function createInsightsRouter(db, today) {
  const router = Router();
  router.get('/', (req, res) => {
    const month = req.query.month ?? today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError('Month must look like 2026-10');
    const accountId = req.query.accountId ? Number(req.query.accountId) : null;
    if (accountId !== null) ownedAccount(db, req.userId, accountId, 'Account', [accountId]);
    res.json(buildMonthReport(db, req.userId, month, today(), accountId));
  });
  return router;
}
