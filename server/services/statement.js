import * as XLSX from 'xlsx';

const HEADER_WORDS = ['date', 'narration', 'description', 'particulars', 'details', 'remarks', 'debit', 'withdrawal', 'credit', 'deposit', 'amount', 'balance', 'ref', 'chq', 'cheque', 'value'];
const HEADER_SCAN_ROWS = 30;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const NOISE = new Set([
  'upi', 'dr', 'cr', 'neft', 'imps', 'rtgs', 'pos', 'ach', 'nach', 'payment', 'pay', 'paid', 'trf', 'txn', 'ref', 'mob',
  'ib', 'inb', 'to', 'by', 'from', 'ecom', 'bil', 'billpay', 'p2a', 'p2m', 'sent', 'received', 'transfer', 'onl', 'online',
]);
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/i;

const pad = (n) => String(n).padStart(2, '0');
const normalize = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const hasWord = (text, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text);

function cellText(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) return XLSX.SSF.format('yyyy-mm-dd', cell.v);
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  return String(cell.v).trim();
}

// Every cell comes back as text; real Excel date cells become YYYY-MM-DD. CSV is read as plain text
// so day-first dates like 05/10/26 are never reinterpreted.
export function readSheet(base64, fileName) {
  const buffer = Buffer.from(base64, 'base64');
  const wb = /\.csv$/i.test(fileName)
    ? XLSX.read(buffer.toString('utf8'), { type: 'string', raw: true })
    : XLSX.read(buffer, { type: 'buffer', raw: true, cellNF: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) row.push(cellText(ws[XLSX.utils.encode_cell({ r, c })]));
    while (row.length && row[row.length - 1] === '') row.pop();
    if (row.length) rows.push(row);
  }
  return rows;
}

export function detectHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i += 1) {
    const hits = rows[i].filter((cell) => HEADER_WORDS.some((w) => normalize(cell).includes(w))).length;
    if (hits >= 3) return i;
  }
  return -1;
}

export const headerSignature = (cells) => cells.map(normalize).filter(Boolean).join('|');

export function guessMapping(headerCells) {
  const cells = headerCells.map(normalize);
  const isDrCr = (c) => (hasWord(c, 'dr') && hasWord(c, 'cr')) || c === 'type';
  const find = (tests, exclude = () => false) => {
    for (const test of tests) {
      const idx = cells.findIndex((c) => c && !exclude(c) && (test.length <= 2 ? hasWord(c, test) : c.includes(test)));
      if (idx >= 0) return idx;
    }
    return null;
  };

  const date = find(['txn date', 'transaction date', 'tran date', 'date'], (c) => c.includes('value'));
  const description = find(['narration', 'description', 'particulars', 'details', 'remarks']);
  const debit = find(['withdrawal', 'debit', 'dr'], isDrCr);
  const credit = find(['deposit', 'credit', 'cr'], isDrCr);
  const amount = find(['amount'], (c) => ['withdrawal', 'deposit', 'debit', 'credit'].some((w) => c.includes(w)));
  const drcrIdx = cells.findIndex(isDrCr);
  const balance = find(['balance']);
  const split = debit !== null && credit !== null;

  return {
    layout: split ? 'split' : 'single',
    date,
    description,
    debit: split ? debit : null,
    credit: split ? credit : null,
    amount: split ? null : amount,
    drcr: split || drcrIdx < 0 ? null : drcrIdx,
    balance,
  };
}

export function detectDateFormat(values) {
  let dayFirst = false;
  let monthFirst = false;
  let yearFirst = false;
  for (const value of values) {
    const m = String(value ?? '').trim().match(/^(\d{1,4})[/\-. ](\d{1,2}|[a-z]{3,})[/\-. ]/i);
    if (!m) continue;
    if (m[1].length === 4) {
      yearFirst = true;
      continue;
    }
    if (!/^\d+$/.test(m[2])) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (yearFirst && !dayFirst && !monthFirst) return 'ymd';
  if (monthFirst && !dayFirst) return 'mdy';
  return 'dmy';
}

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const fullYear = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));

export function parseDate(text, format) {
  const s = String(text ?? '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[-/. ]([a-z]{3,9})[-/. ,]+(\d{2,4})\b/i);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return month ? validDate(fullYear(m[3]), month, Number(m[1])) : null;
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return format === 'mdy' ? validDate(fullYear(m[3]), a, b) : validDate(fullYear(m[3]), b, a);
  }
  return null;
}

// Signed: negative = money out. Returns null when there is no number at all.
export function parseAmount(text) {
  let s = String(text ?? '').trim();
  if (!s) return null;
  let sign = 1;
  const drcr = s.match(/\s*\b(dr|cr)\.?$/i);
  if (drcr) {
    sign = drcr[1].toLowerCase() === 'dr' ? -1 : 1;
    s = s.slice(0, drcr.index).trim();
  }
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/₹|rs\.?|inr|,|\s/gi, '');
  if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s) * sign;
}

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const tidy = (s) => {
  const t = s.slice(0, 40).trim();
  return t === t.toUpperCase() ? titleCase(t) : t;
};

export function payeeFromNarration(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (/\bATM\b/i.test(raw) && /\b(wdl|withdrawal|cash|atw|nfs)\b/i.test(raw)) return 'ATM withdrawal';
  const pieces = raw.split(/[/\-:|*]+/).map((p) => p.trim()).filter(Boolean);
  for (const piece of pieces) {
    if (piece.includes('@') || IFSC.test(piece)) continue;
    const words = piece.split(/\s+/);
    while (words.length && (NOISE.has(words[0].toLowerCase()) || /\d/.test(words[0]))) words.shift();
    const rest = words.join(' ');
    if (rest.length > 2 && /[a-z]/i.test(rest)) return tidy(rest);
  }
  const vpa = pieces.find((p) => p.includes('@'));
  return tidy(vpa ? vpa.split('@')[0] : raw);
}

export function buildPreview(rows, headerRow, mapping, dateFormat) {
  const transactions = [];
  const skipped = [];
  const balances = [];
  for (let i = headerRow + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const text = row.filter(Boolean).join(' · ').slice(0, 120);
    const occurredAt = parseDate(row[mapping.date], dateFormat);
    if (!occurredAt) {
      skipped.push({ row: i, reason: 'No valid date', text });
      continue;
    }
    let amount;
    if (mapping.layout === 'split') {
      const out = parseAmount(row[mapping.debit]);
      const incoming = parseAmount(row[mapping.credit]);
      amount = out ? -Math.abs(out) : incoming ? Math.abs(incoming) : null;
    } else {
      amount = parseAmount(row[mapping.amount]);
      if (amount && mapping.drcr !== null && mapping.drcr !== undefined) {
        const flag = normalize(row[mapping.drcr]);
        if (/^(dr|debit|withdrawal|d)\b/.test(flag)) amount = -Math.abs(amount);
        else if (/^(cr|credit|deposit|c)\b/.test(flag)) amount = Math.abs(amount);
      }
    }
    if (!amount) {
      skipped.push({ row: i, reason: 'No amount', text });
      continue;
    }
    const note = String(row[mapping.description] ?? '').trim();
    transactions.push({ row: i, occurredAt, amount: Math.abs(amount), direction: amount < 0 ? 'out' : 'in', note, payee: payeeFromNarration(note) });
    if (mapping.balance !== null && mapping.balance !== undefined) {
      const balance = parseAmount(row[mapping.balance]);
      if (balance !== null) balances.push({ occurredAt, balance });
    }
  }

  // Closing balance = balance on the newest date; on a tie, the last row in an oldest-first file
  // or the first row in a newest-first file.
  let statementClosing = null;
  if (balances.length) {
    const latest = balances.reduce((max, b) => (b.occurredAt > max ? b.occurredAt : max), balances[0].occurredAt);
    const ascending = transactions[0].occurredAt <= transactions[transactions.length - 1].occurredAt;
    const onLatest = balances.filter((b) => b.occurredAt === latest);
    statementClosing = (ascending ? onLatest[onLatest.length - 1] : onLatest[0]).balance;
  }
  return { transactions, skipped, statementClosing };
}
