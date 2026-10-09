import { ValidationError, TX_TYPES, requireAmount, requireDate, requireDateTime, requireOneOf } from '../validate.js';
import { ACCOUNT_TYPES } from '../routes/accounts.js';
import { FREQUENCIES, addPeriod } from './recurring.js';

export const BACKUP_APP = 'expense-tracker';
export const BACKUP_VERSION = 1;
const KINDS = ['accounts', 'categories', 'categoryRules', 'tags', 'recurringRules', 'imports', 'importFormats', 'transactions', 'budgets', 'goals'];
const LABELS = { categoryRules: 'auto-categorise rules', recurringRules: 'recurring items', importFormats: 'import formats' };

const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
const paise = (n) => Math.round(n * 100);
// A date with no time and the same date at midnight are the same moment to the user.
const moment = (s) => (s.endsWith('T00:00') ? s.slice(0, 10) : s);
const txKey = (t) => [t.type, paise(t.amount), moment(t.occurred_at), t.account_id, t.to_account_id ?? '', norm(t.payee)].join('|');
const postedKey = (r, date) => [r.type, paise(r.amount), r.account_id, r.to_account_id ?? '', norm(r.payee), date].join('|');
const recurringKey = (r) => [r.type, paise(r.amount), r.account_id, r.to_account_id ?? '', norm(r.payee), r.frequency, r.anchor_day].join('|');
const contributionKey = (goalId, c) => [goalId, paise(c.amount), c.date].join('|');

export function exportData(db, userId) {
  const all = (sql) => db.prepare(sql).all(userId);
  const tagRows = all(
    `SELECT tt.transaction_id, g.name FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE g.user_id = ? ORDER BY g.name`
  );
  const tagsByTx = new Map();
  for (const t of tagRows) tagsByTx.set(t.transaction_id, [...(tagsByTx.get(t.transaction_id) ?? []), t.name]);
  const contributions = all(
    `SELECT c.goal_id, c.amount, c.date, c.note, c.created_at FROM goal_contributions c JOIN goals g ON g.id = c.goal_id
     WHERE g.user_id = ? ORDER BY c.id`
  );

  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      accounts: all('SELECT id, name, type, opening_balance, archived, created_at FROM accounts WHERE user_id = ? ORDER BY id'),
      categories: all('SELECT id, name, color, kind FROM categories WHERE user_id = ? ORDER BY id'),
      categoryRules: all('SELECT match_text, category_id FROM category_rules WHERE user_id = ? ORDER BY id'),
      tags: all('SELECT name FROM tags WHERE user_id = ? ORDER BY name').map((t) => t.name),
      recurringRules: all(
        `SELECT id, type, amount, account_id, to_account_id, category_id, payee, note, frequency, anchor_day,
           start_date, end_date, next_date, mode, active, created_at FROM recurring_rules WHERE user_id = ? ORDER BY id`
      ),
      imports: all('SELECT id, account_id, file_name, row_count, created_at FROM imports WHERE user_id = ? ORDER BY id'),
      importFormats: all('SELECT signature, header_row, mapping FROM import_formats WHERE user_id = ? ORDER BY id'),
      transactions: all(
        `SELECT id, type, amount, occurred_at, account_id, to_account_id, category_id, payee, note, recurring_id, import_id, created_at
         FROM transactions WHERE user_id = ? ORDER BY id`
      ).map(({ id, ...t }) => ({ ...t, tags: tagsByTx.get(id) ?? [] })),
      budgets: all('SELECT category_id, month, amount FROM budgets WHERE user_id = ? ORDER BY id'),
      goals: all('SELECT id, name, target_amount, target_date, created_at FROM goals WHERE user_id = ? ORDER BY id').map((g) => ({
        ...g,
        contributions: contributions.filter((c) => c.goal_id === g.id).map(({ goal_id, ...c }) => c),
      })),
    },
  };
}

// --- Restore -------------------------------------------------------------------------------

const text = (value, label, max = 200) => {
  if (typeof value !== 'string') throw new ValidationError(`${label} is missing`);
  return value.trim().slice(0, max);
};
const optionalText = (value, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const flag = (value) => (value ? 1 : 0);
const timestamp = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value : null);
const wholeNumber = (value, label) => {
  if (!Number.isInteger(value)) throw new ValidationError(`${label} must be a whole number`);
  return value;
};
const realDate = (value, label) => {
  requireDate(value, label);
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new ValidationError(`${label} ${value} is not a real date`);
  return value;
};

function checkEnvelope(file) {
  if (!file || typeof file !== 'object' || file.app !== BACKUP_APP || !file.data || typeof file.data !== 'object') {
    throw new ValidationError("That isn't an Expense Tracker backup file.");
  }
  if (!Number.isInteger(file.version) || file.version < 1) throw new ValidationError("That isn't an Expense Tracker backup file.");
  if (file.version > BACKUP_VERSION) throw new ValidationError('This backup was made by a newer version of the app. Update the app first.');
  for (const kind of KINDS) {
    if (!Array.isArray(file.data[kind])) throw new ValidationError(`The backup file is damaged: ${LABELS[kind] ?? kind} are missing.`);
  }
}

// Merges a backup into the user's data. Whatever is already there wins: nothing is edited or deleted.
// Must run inside a transaction so a bad row leaves the account untouched. Returns { kind: { added, skipped } }.
export function restoreData(db, userId, file) {
  checkEnvelope(file);
  const { data } = file;
  const summary = Object.fromEntries([...KINDS, 'goalContributions'].map((k) => [k, { added: 0, skipped: 0 }]));
  const all = (sql) => db.prepare(sql).all(userId);
  const insert = (sql, ...params) => Number(db.prepare(sql).run(...params).lastInsertRowid);

  // Validates and merges one kind of row; `merge` returns true when it added something.
  const each = (kind, merge) => {
    data[kind].forEach((row, i) => {
      try {
        if (row === null || (typeof row !== 'object' && kind !== 'tags')) throw new ValidationError('is not a valid entry');
        summary[kind][merge(row) ? 'added' : 'skipped'] += 1;
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        throw new ValidationError(`The backup file has a problem in ${LABELS[kind] ?? kind}, entry ${i + 1}: ${err.message}`);
      }
    });
  };
  // Looks up the row a file id now points to; ids only mean something inside the file.
  const ref = (map, id, label, required = false) => {
    if (id === null || id === undefined) {
      if (required) throw new ValidationError(`${label} is missing`);
      return null;
    }
    if (!map.has(id)) throw new ValidationError(`${label} points to something that isn't in the file`);
    return map.get(id);
  };

  const accountIds = new Map();
  const accountsByName = new Map(all('SELECT id, name FROM accounts WHERE user_id = ?').map((a) => [norm(a.name), a.id]));
  each('accounts', (a) => {
    const name = text(a.name, 'Account name', 80);
    if (!name) throw new ValidationError('Account name is missing');
    requireOneOf(a.type, ACCOUNT_TYPES, 'Account type');
    if (typeof a.opening_balance !== 'number' || !Number.isFinite(a.opening_balance)) throw new ValidationError('Balance must be a number');
    const existing = accountsByName.get(norm(name));
    if (existing) return accountIds.set(a.id, existing) && false;
    const id = insert(
      "INSERT INTO accounts (user_id, name, type, opening_balance, archived, created_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))",
      userId, name, a.type, a.opening_balance, flag(a.archived), timestamp(a.created_at)
    );
    accountsByName.set(norm(name), id);
    accountIds.set(a.id, id);
    return true;
  });

  const categoryIds = new Map();
  const categoryKinds = new Map();
  const categoriesByName = new Map();
  for (const c of all('SELECT id, name, kind FROM categories WHERE user_id = ?')) {
    categoriesByName.set(`${norm(c.name)}|${c.kind}`, c.id);
    categoryKinds.set(c.id, c.kind);
  }
  each('categories', (c) => {
    const name = text(c.name, 'Category name', 60);
    if (!name) throw new ValidationError('Category name is missing');
    requireOneOf(c.kind, ['expense', 'income'], 'Category kind');
    const key = `${norm(name)}|${c.kind}`;
    const existing = categoriesByName.get(key);
    if (existing) return categoryIds.set(c.id, existing) && false;
    const color = typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#888888';
    const id = insert('INSERT INTO categories (user_id, name, color, kind) VALUES (?, ?, ?, ?)', userId, name, color, c.kind);
    categoriesByName.set(key, id);
    categoryKinds.set(id, c.kind);
    categoryIds.set(c.id, id);
    return true;
  });
  const categoryFor = (id, type) => {
    const mapped = ref(categoryIds, id, 'Category');
    if (mapped !== null && type === 'transfer') return null;
    if (mapped !== null && categoryKinds.get(mapped) !== type) throw new ValidationError(`Category is for ${categoryKinds.get(mapped)}, not ${type}`);
    return mapped;
  };

  const ruleTexts = new Set(all('SELECT match_text FROM category_rules WHERE user_id = ?').map((r) => r.match_text));
  each('categoryRules', (r) => {
    const matchText = norm(text(r.match_text, 'Match text', 80));
    if (!matchText) throw new ValidationError('Match text is missing');
    const categoryId = ref(categoryIds, r.category_id, 'Category', true);
    if (ruleTexts.has(matchText)) return false;
    insert('INSERT INTO category_rules (user_id, match_text, category_id) VALUES (?, ?, ?)', userId, matchText, categoryId);
    ruleTexts.add(matchText);
    return true;
  });

  const tagIds = new Map(all('SELECT id, name FROM tags WHERE user_id = ?').map((t) => [t.name, t.id]));
  const tagId = (raw) => {
    const name = norm(text(raw, 'Tag', 40));
    if (!name) throw new ValidationError('Tag is empty');
    if (tagIds.has(name)) return { id: tagIds.get(name), added: false };
    const id = insert('INSERT INTO tags (user_id, name) VALUES (?, ?)', userId, name);
    tagIds.set(name, id);
    return { id, added: true };
  };
  each('tags', (name) => tagId(name).added);

  // Shared by transactions and recurring items.
  const movement = (row) => {
    requireOneOf(row.type, TX_TYPES, 'Type');
    requireAmount(row.amount);
    const accountId = ref(accountIds, row.account_id, 'Account', true);
    const toAccountId = row.type === 'transfer' ? ref(accountIds, row.to_account_id, 'Destination account', true) : null;
    if (toAccountId === accountId) throw new ValidationError('A transfer needs two different accounts');
    return {
      type: row.type, amount: row.amount, account_id: accountId, to_account_id: toAccountId,
      category_id: categoryFor(row.category_id, row.type), payee: optionalText(row.payee, 80), note: optionalText(row.note),
    };
  };

  const recurringIds = new Map();
  const addedRules = [];
  const recurringByKey = new Map(
    all('SELECT id, type, amount, account_id, to_account_id, payee, frequency, anchor_day FROM recurring_rules WHERE user_id = ?').map((r) => [recurringKey(r), r.id])
  );
  each('recurringRules', (r) => {
    const m = movement(r);
    requireOneOf(r.frequency, FREQUENCIES, 'Frequency');
    requireOneOf(r.mode, ['auto', 'confirm'], 'Mode');
    const anchorDay = wholeNumber(r.anchor_day, 'Anchor day');
    if (anchorDay < 1 || anchorDay > 31) throw new ValidationError('Anchor day must be between 1 and 31');
    realDate(r.start_date, 'Start date');
    realDate(r.next_date, 'Next date');
    if (r.end_date !== null && r.end_date !== undefined) realDate(r.end_date, 'End date');
    const rule = { ...m, frequency: r.frequency, anchor_day: anchorDay };
    const existing = recurringByKey.get(recurringKey(rule));
    if (existing) return recurringIds.set(r.id, existing) && false;
    const id = insert(
      `INSERT INTO recurring_rules (user_id, type, amount, account_id, to_account_id, category_id, payee, note, frequency,
         anchor_day, start_date, end_date, next_date, mode, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
      userId, m.type, m.amount, m.account_id, m.to_account_id, m.category_id, m.payee, m.note, r.frequency,
      anchorDay, r.start_date, r.end_date ?? null, r.next_date, r.mode, flag(r.active), timestamp(r.created_at)
    );
    recurringByKey.set(recurringKey(rule), id);
    recurringIds.set(r.id, id);
    addedRules.push({ ...rule, id, next_date: r.next_date, end_date: r.end_date ?? null });
    return true;
  });

  // Import batches are only created once one of their transactions is actually added.
  const batches = new Map();
  const batchesByKey = new Map(
    all('SELECT id, account_id, file_name, created_at FROM imports WHERE user_id = ?').map((b) => [`${b.account_id}|${b.file_name}|${b.created_at}`, b.id])
  );
  each('imports', (b) => {
    const batch = {
      accountId: ref(accountIds, b.account_id, 'Account', true),
      fileName: text(b.file_name, 'File name') || 'statement',
      rowCount: wholeNumber(b.row_count, 'Row count'),
      createdAt: timestamp(b.created_at),
    };
    batch.id = batchesByKey.get(`${batch.accountId}|${batch.fileName}|${batch.createdAt}`) ?? null;
    batches.set(b.id, batch);
    return false;
  });
  const batchId = (fileId) => {
    const batch = ref(batches, fileId, 'Import');
    if (batch === null) return null;
    if (batch.id === null) {
      batch.id = insert(
        "INSERT INTO imports (user_id, account_id, file_name, row_count, created_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))",
        userId, batch.accountId, batch.fileName, batch.rowCount, batch.createdAt
      );
      summary.imports.added += 1;
      summary.imports.skipped -= 1;
    }
    return batch.id;
  };

  const signatures = new Set(all('SELECT signature FROM import_formats WHERE user_id = ?').map((f) => f.signature));
  each('importFormats', (f) => {
    const signature = text(f.signature, 'Signature', 2000);
    if (!signature) throw new ValidationError('Signature is missing');
    wholeNumber(f.header_row, 'Header row');
    try {
      JSON.parse(text(f.mapping, 'Mapping', 5000));
    } catch {
      throw new ValidationError('Mapping is not readable');
    }
    if (signatures.has(signature)) return false;
    insert('INSERT INTO import_formats (user_id, signature, header_row, mapping) VALUES (?, ?, ?, ?)', userId, signature, f.header_row, f.mapping);
    signatures.add(signature);
    return true;
  });

  // Counted matching: each existing transaction can absorb one identical row from the file, so
  // genuine repeats survive and restoring the same file twice adds nothing.
  const alreadyHere = new Map();
  for (const t of all('SELECT type, amount, occurred_at, account_id, to_account_id, payee FROM transactions WHERE user_id = ?')) {
    alreadyHere.set(txKey(t), (alreadyHere.get(txKey(t)) ?? 0) + 1);
  }
  const addTransaction = db.prepare(
    `INSERT INTO transactions (user_id, type, amount, occurred_at, account_id, to_account_id, category_id, payee, note, recurring_id, import_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
  );
  const addTag = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)');
  each('transactions', (t) => {
    const m = movement(t);
    requireDateTime(t.occurred_at);
    realDate(t.occurred_at.slice(0, 10), 'Date');
    const recurringId = ref(recurringIds, t.recurring_id, 'Recurring item');
    if (t.tags !== undefined && !Array.isArray(t.tags)) throw new ValidationError('Tags must be a list');
    const key = txKey({ ...m, occurred_at: t.occurred_at });
    const matches = alreadyHere.get(key) ?? 0;
    if (matches > 0) {
      ref(batches, t.import_id, 'Import');
      alreadyHere.set(key, matches - 1);
      return false;
    }
    const info = addTransaction.run(
      userId, m.type, m.amount, t.occurred_at, m.account_id, m.to_account_id, m.category_id, m.payee, m.note,
      recurringId, batchId(t.import_id), timestamp(t.created_at)
    );
    for (const name of t.tags ?? []) addTag.run(Number(info.lastInsertRowid), tagId(name).id);
    return true;
  });

  // A restored repeating item must not post again what is already logged (e.g. an old backup
  // brought back into an account that kept running), so move it past occurrences that exist.
  if (addedRules.length) {
    const posted = new Set(
      all('SELECT type, amount, occurred_at, account_id, to_account_id, payee FROM transactions WHERE user_id = ?').map((t) => postedKey(t, t.occurred_at.slice(0, 10)))
    );
    for (const rule of addedRules) {
      let next = rule.next_date;
      while (posted.has(postedKey(rule, next)) && (rule.end_date === null || next <= rule.end_date)) next = addPeriod(next, rule.frequency, rule.anchor_day);
      if (next !== rule.next_date) db.prepare('UPDATE recurring_rules SET next_date = ? WHERE id = ?').run(next, rule.id);
    }
  }

  const budgetKeys = new Set(all('SELECT category_id, month FROM budgets WHERE user_id = ?').map((b) => `${b.category_id ?? ''}|${b.month}`));
  each('budgets', (b) => {
    if (typeof b.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month)) throw new ValidationError('Month must look like 2026-10');
    requireAmount(b.amount);
    const categoryId = categoryFor(b.category_id, 'expense');
    const key = `${categoryId ?? ''}|${b.month}`;
    if (budgetKeys.has(key)) return false;
    insert('INSERT INTO budgets (user_id, category_id, month, amount) VALUES (?, ?, ?, ?)', userId, categoryId, b.month, b.amount);
    budgetKeys.add(key);
    return true;
  });

  const goalsByName = new Map(all('SELECT id, name FROM goals WHERE user_id = ?').map((g) => [norm(g.name), g.id]));
  const savedAlready = new Map();
  for (const c of all('SELECT c.goal_id, c.amount, c.date FROM goal_contributions c JOIN goals g ON g.id = c.goal_id WHERE g.user_id = ?')) {
    const key = contributionKey(c.goal_id, c);
    savedAlready.set(key, (savedAlready.get(key) ?? 0) + 1);
  }
  each('goals', (g) => {
    const name = text(g.name, 'Goal name', 60);
    if (!name) throw new ValidationError('Goal name is missing');
    requireAmount(g.target_amount);
    if (g.target_date !== null && g.target_date !== undefined) realDate(g.target_date, 'Deadline');
    if (!Array.isArray(g.contributions)) throw new ValidationError('Saved amounts are missing');
    let goalId = goalsByName.get(norm(name));
    const added = !goalId;
    if (added) {
      goalId = insert(
        "INSERT INTO goals (user_id, name, target_amount, target_date, created_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))",
        userId, name, g.target_amount, g.target_date ?? null, timestamp(g.created_at)
      );
      goalsByName.set(norm(name), goalId);
    }
    for (const c of g.contributions) {
      if (!c || typeof c.amount !== 'number') throw new ValidationError('A saved amount is not a number');
      requireAmount(Math.abs(c.amount));
      realDate(c.date, 'Saved-on date');
      const key = contributionKey(goalId, c);
      const matches = savedAlready.get(key) ?? 0;
      if (matches > 0) {
        savedAlready.set(key, matches - 1);
        summary.goalContributions.skipped += 1;
      } else {
        insert(
          "INSERT INTO goal_contributions (goal_id, amount, date, note, created_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))",
          goalId, c.amount, c.date, optionalText(c.note, 200), timestamp(c.created_at)
        );
        summary.goalContributions.added += 1;
      }
    }
    return added;
  });

  return summary;
}
