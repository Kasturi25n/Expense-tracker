export class ValidationError extends Error {}

export const TX_TYPES = ['expense', 'income', 'transfer'];
const MAX_AMOUNT = 1_000_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

export function requireAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new ValidationError('Amount must be a number greater than 0');
  }
}

// Rejects dates the calendar doesn't have, like 2026-02-30 or month 13.
function isRealDate(value) {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function requireDateTime(value) {
  if (typeof value !== 'string' || !DATE_TIME_RE.test(value)) {
    throw new ValidationError('Date must look like 2026-10-05 or 2026-10-05T13:30');
  }
  const [h, min] = value.includes('T') ? value.slice(11).split(':').map(Number) : [0, 0];
  if (!isRealDate(value) || h > 23 || min > 59) throw new ValidationError(`${value} is not a real date`);
}

export function requireDate(value, label = 'Date') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ValidationError(`${label} must look like 2026-10-05`);
  }
  if (!isRealDate(value)) throw new ValidationError(`${label} ${value} is not a real date`);
}

export function requireOneOf(value, options, label) {
  if (!options.includes(value)) throw new ValidationError(`${label} must be one of: ${options.join(', ')}`);
}

export function ownedAccount(db, userId, id, label = 'Account', allowArchivedIds = []) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(id ?? null, userId);
  if (!row) throw new ValidationError(`${label} not found`);
  if (row.archived && !allowArchivedIds.includes(row.id)) throw new ValidationError(`${label} "${row.name}" is archived`);
  return row;
}

export function ownedCategory(db, userId, id, txType) {
  const row = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id ?? null, userId);
  if (!row) throw new ValidationError('Category not found');
  if (txType && row.kind !== txType) {
    throw new ValidationError(`Category "${row.name}" is for ${row.kind}, not ${txType}`);
  }
  return row;
}

// Shared by transactions and recurring rules: the "who paid whom from where" part of a money movement.
export function validateMovement(db, userId, body, allowArchivedIds = []) {
  const { type, amount, accountId, toAccountId, categoryId, payee = '', note = '' } = body ?? {};
  requireOneOf(type, TX_TYPES, 'Type');
  requireAmount(amount);
  ownedAccount(db, userId, accountId, 'Account', allowArchivedIds);

  let to = null;
  let category = null;
  if (type === 'transfer') {
    ownedAccount(db, userId, toAccountId, 'Destination account', allowArchivedIds);
    if (Number(toAccountId) === Number(accountId)) throw new ValidationError('Choose two different accounts for a transfer');
    to = toAccountId;
  } else if (categoryId !== undefined && categoryId !== null) {
    ownedCategory(db, userId, categoryId, type);
    category = categoryId;
  }

  return { type, amount, accountId, toAccountId: to, categoryId: category, payee: String(payee).trim(), note: String(note).trim() };
}
