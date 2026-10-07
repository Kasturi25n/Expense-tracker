import { Router } from 'express';

const COLUMNS = ['occurred_at', 'type', 'amount', 'account', 'to_account', 'category', 'payee', 'note', 'tags'];

function csvEscape(value) {
  let str = String(value ?? '');
  // Stop spreadsheets from running text that starts like a formula.
  if (/^[=+\-@]/.test(str)) str = `'${str}`;
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function createExportRouter(db) {
  const router = Router();

  router.get('/csv', (req, res) => {
    const rows = db
      .prepare(
        `SELECT t.occurred_at, t.type, t.amount, a.name AS account, ta.name AS to_account,
                c.name AS category, t.payee, t.note,
                (SELECT group_concat(g.name, ';') FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
                 WHERE tt.transaction_id = t.id) AS tags
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN accounts ta ON ta.id = t.to_account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = ?
         ORDER BY t.occurred_at DESC, t.id DESC`
      )
      .all(req.userId);

    const lines = rows.map((r) => COLUMNS.map((col) => csvEscape(r[col])).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send([COLUMNS.join(','), ...lines].join('\n'));
  });

  return router;
}
