import { Router } from 'express';

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function createExportRouter(db) {
  const router = Router();

  router.get('/csv', (req, res) => {
    const rows = db
      .prepare(
        `SELECT e.date, e.amount, e.description, c.name as category
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
         WHERE e.user_id = ? ORDER BY e.date DESC`
      )
      .all(req.userId);

    const header = 'date,amount,description,category';
    const lines = rows.map((r) =>
      [r.date, r.amount, csvEscape(r.description), csvEscape(r.category)].join(',')
    );
    const csv = [header, ...lines].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send(csv);
  });

  return router;
}
