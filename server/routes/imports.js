import { Router } from 'express';
import { inTransaction } from '../db.js';
import { ValidationError, ownedAccount, ownedCategory, requireAmount, requireDateTime, requireOneOf } from '../validate.js';
import { suggestCategory } from '../services/categorize.js';
import { readSheet, detectHeaderRow, guessMapping, detectDateFormat, buildPreview, headerSignature } from '../services/statement.js';
import { accountBalances } from './accounts.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const DATE_FORMATS = ['dmy', 'mdy', 'ymd'];

const isColumn = (v) => Number.isInteger(v) && v >= 0;
const round = (n) => Math.round(n * 100) / 100;

function checkMapping(m) {
  if (!m || !['split', 'single'].includes(m.layout)) throw new ValidationError('Choose how amounts are shown in the file');
  if (!isColumn(m.date)) throw new ValidationError('Choose the date column');
  if (!isColumn(m.description)) throw new ValidationError('Choose the description column');
  if (m.layout === 'split' && (!isColumn(m.debit) || !isColumn(m.credit))) throw new ValidationError('Choose the money out and money in columns');
  if (m.layout === 'single' && !isColumn(m.amount)) throw new ValidationError('Choose the amount column');
}

function checkRows(rows) {
  if (!Array.isArray(rows)) throw new ValidationError('Statement rows are missing');
  if (rows.length > MAX_ROWS + 50) throw new ValidationError('That statement has more than 5,000 rows — download a shorter date range.');
  return rows.map((r) => (Array.isArray(r) ? r.map((cell) => String(cell ?? '')) : []));
}

export function createImportsRouter(db) {
  const router = Router();

  router.post('/read', (req, res) => {
    const { fileName, fileBase64 } = req.body ?? {};
    if (typeof fileName !== 'string' || typeof fileBase64 !== 'string' || !fileBase64) throw new ValidationError('Choose a statement file');
    if (!/\.(csv|xlsx|xls)$/i.test(fileName)) {
      throw new ValidationError("Use an Excel (.xls, .xlsx) or CSV file. PDF statements aren't supported.");
    }
    if (Buffer.byteLength(fileBase64, 'base64') > MAX_FILE_BYTES) {
      return res.status(413).json({ error: 'That file is larger than 5 MB. Download a shorter date range.' });
    }

    let rows;
    try {
      rows = readSheet(fileBase64, fileName);
    } catch {
      throw new ValidationError("We couldn't read that file. Try downloading it again as Excel or CSV.");
    }
    checkRows(rows);

    const saved = new Map(
      db.prepare('SELECT signature, mapping FROM import_formats WHERE user_id = ?').all(req.userId).map((f) => [f.signature, JSON.parse(f.mapping)])
    );
    for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
      const format = saved.get(headerSignature(rows[i]));
      if (format) return res.json({ rows, headerRow: i, mapping: format.mapping, dateFormat: format.dateFormat, savedFormat: true });
    }

    const headerRow = detectHeaderRow(rows);
    const mapping = headerRow >= 0 ? guessMapping(rows[headerRow]) : null;
    const dateFormat = mapping && mapping.date !== null ? detectDateFormat(rows.slice(headerRow + 1).map((r) => r[mapping.date])) : 'dmy';
    res.json({ rows, headerRow, mapping, dateFormat, savedFormat: false });
  });

  router.post('/preview', (req, res) => {
    const { accountId, headerRow, mapping, dateFormat } = req.body ?? {};
    const account = ownedAccount(db, req.userId, accountId);
    const rows = checkRows(req.body?.rows);
    checkMapping(mapping);
    requireOneOf(dateFormat, DATE_FORMATS, 'Date style');
    if (!Number.isInteger(headerRow) || headerRow < -1) throw new ValidationError('Choose the row with the headings');

    const preview = buildPreview(rows, headerRow, mapping, dateFormat);

    // Existing transactions on this account, counted per (day, amount, direction) so each can
    // only mark one imported row as a duplicate.
    const existing = new Map();
    if (preview.transactions.length) {
      const days = preview.transactions.map((t) => t.occurredAt).sort();
      const found = db
        .prepare(
          `SELECT substr(occurred_at, 1, 10) AS day, amount,
             CASE WHEN (account_id = ? AND type = 'income') OR (to_account_id = ? AND type = 'transfer') THEN 'in' ELSE 'out' END AS direction
           FROM transactions WHERE user_id = ? AND (account_id = ? OR to_account_id = ?)
             AND substr(occurred_at, 1, 10) BETWEEN ? AND ?`
        )
        .all(account.id, account.id, req.userId, account.id, account.id, days[0], days[days.length - 1]);
      for (const t of found) {
        const key = `${t.day}|${round(t.amount)}|${t.direction}`;
        existing.set(key, (existing.get(key) ?? 0) + 1);
      }
    }

    const transactions = preview.transactions.map((t) => {
      const key = `${t.occurredAt}|${round(t.amount)}|${t.direction}`;
      const duplicate = (existing.get(key) ?? 0) > 0;
      if (duplicate) existing.set(key, existing.get(key) - 1);
      const type = t.direction === 'out' ? 'expense' : 'income';
      return { ...t, categoryId: suggestCategory(db, req.userId, { payee: t.payee, note: t.note, type }), duplicate };
    });

    const now = accountBalances(db, req.userId).find((a) => a.id === account.id).balance;
    res.json({ transactions, skipped: preview.skipped, balance: { now, statementClosing: preview.statementClosing } });
  });

  router.post('/', (req, res) => {
    const { accountId, fileName, headers, mapping, dateFormat, headerRow, transactions } = req.body ?? {};
    const account = ownedAccount(db, req.userId, accountId);
    if (!Array.isArray(transactions) || !transactions.length) throw new ValidationError('Tick at least one transaction to import');
    if (transactions.length > MAX_ROWS) throw new ValidationError('You can import up to 5,000 transactions at a time');
    const rememberFormat = Array.isArray(headers) && headerSignature(headers) !== '';
    if (rememberFormat) {
      checkMapping(mapping);
      requireOneOf(dateFormat, DATE_FORMATS, 'Date style');
    }

    const rows = transactions.map((t) => {
      requireAmount(t.amount);
      requireDateTime(t.occurredAt);
      requireOneOf(t.direction, ['in', 'out'], 'Direction');
      const note = String(t.note ?? '').trim();
      if (t.transferAccountId !== undefined && t.transferAccountId !== null) {
        const other = ownedAccount(db, req.userId, t.transferAccountId, 'Transfer account');
        if (other.id === account.id) throw new ValidationError('Choose a different account for the transfer');
        const [from, to] = t.direction === 'out' ? [account.id, other.id] : [other.id, account.id];
        return { type: 'transfer', amount: t.amount, occurredAt: t.occurredAt, accountId: from, toAccountId: to, categoryId: null, payee: '', note };
      }
      const type = t.direction === 'out' ? 'expense' : 'income';
      if (t.categoryId !== undefined && t.categoryId !== null) ownedCategory(db, req.userId, t.categoryId, type);
      return {
        type, amount: t.amount, occurredAt: t.occurredAt, accountId: account.id, toAccountId: null,
        categoryId: t.categoryId ?? null, payee: String(t.payee ?? '').trim().slice(0, 80), note,
      };
    });

    const id = inTransaction(db, () => {
      const batch = db
        .prepare('INSERT INTO imports (user_id, account_id, file_name, row_count) VALUES (?, ?, ?, ?)')
        .run(req.userId, account.id, String(fileName ?? 'statement').slice(0, 200), rows.length);
      const importId = Number(batch.lastInsertRowid);
      const insert = db.prepare(
        `INSERT INTO transactions (user_id, type, amount, occurred_at, account_id, to_account_id, category_id, payee, note, import_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of rows) {
        insert.run(req.userId, r.type, r.amount, r.occurredAt, r.accountId, r.toAccountId, r.categoryId, r.payee, r.note, importId);
      }
      if (rememberFormat) {
        db.prepare(
          `INSERT INTO import_formats (user_id, signature, header_row, mapping) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, signature) DO UPDATE SET header_row = excluded.header_row, mapping = excluded.mapping, updated_at = datetime('now')`
        ).run(req.userId, headerSignature(headers), Number.isInteger(headerRow) ? headerRow : 0, JSON.stringify({ mapping, dateFormat }));
      }
      return importId;
    });
    res.status(201).json({ id, rowCount: rows.length });
  });

  router.get('/', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT i.id, i.file_name, i.row_count, i.created_at, i.account_id, a.name AS account_name
           FROM imports i JOIN accounts a ON a.id = i.account_id WHERE i.user_id = ? ORDER BY i.id DESC`
        )
        .all(req.userId)
    );
  });

  router.delete('/:id', (req, res) => {
    const batch = db.prepare('SELECT id FROM imports WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!batch) return res.status(404).json({ error: 'Import not found' });
    inTransaction(db, () => {
      db.prepare('DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE import_id = ?)').run(batch.id);
      db.prepare('DELETE FROM transactions WHERE import_id = ?').run(batch.id);
      db.prepare('DELETE FROM imports WHERE id = ?').run(batch.id);
    });
    res.status(204).end();
  });

  return router;
}
