import express from 'express';
import cors from 'cors';
import { createAuthMiddleware } from './middleware/auth.js';
import { ValidationError } from './validate.js';
import { materializeDue, todayLocal } from './services/recurring.js';
import { createAuthRouter } from './routes/auth.js';
import { createCategoriesRouter } from './routes/categories.js';
import { createRulesRouter } from './routes/rules.js';
import { createAccountsRouter } from './routes/accounts.js';
import { createTransactionsRouter } from './routes/transactions.js';
import { createRecurringRouter } from './routes/recurring.js';
import { createBudgetsRouter } from './routes/budgets.js';
import { createExportRouter } from './routes/export.js';

export function createApp(db, jwtSecret, { today = todayLocal } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const requireAuth = createAuthMiddleware(jwtSecret);
  // Post automatic recurring items that have come due before any money data is read.
  const materialize = (req, res, next) => {
    materializeDue(db, req.userId, today());
    next();
  };
  const authed = [requireAuth, materialize];

  app.use('/api/auth', createAuthRouter(db, jwtSecret));
  app.use('/api/categories', requireAuth, createCategoriesRouter(db));
  app.use('/api/rules', requireAuth, createRulesRouter(db));
  app.use('/api/accounts', ...authed, createAccountsRouter(db));
  app.use('/api/transactions', ...authed, createTransactionsRouter(db));
  app.use('/api/recurring', ...authed, createRecurringRouter(db, today));
  app.use('/api/budgets', ...authed, createBudgetsRouter(db));
  app.use('/api/export', ...authed, createExportRouter(db));

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
