const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const wholeRupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// Paise are shown only when there are some: ₹450, but ₹99.50.
export const formatMoney = (amount) => (Number.isInteger(Math.round(amount * 100) / 100) ? wholeRupee : rupee).format(amount);

export function signedMoney(tx) {
  if (tx.type === 'income') return `+${formatMoney(tx.amount)}`;
  if (tx.type === 'expense') return `−${formatMoney(tx.amount)}`;
  return formatMoney(tx.amount);
}

const pad = (n) => String(n).padStart(2, '0');
const parseDate = (s) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => toDateStr(new Date());

export function nowLocalDateTime() {
  const d = new Date();
  return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const formatShortDate = (s) => parseDate(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

export function formatDay(s) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (s === todayStr()) return 'Today';
  if (s === toDateStr(yesterday)) return 'Yesterday';
  return parseDate(s).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

export function timeOf(occurredAt) {
  if (!occurredAt.includes('T')) return '';
  const [h, m] = occurredAt.slice(11, 16).split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

export function monthRange(offset = 0) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return { from: toDateStr(first), to: toDateStr(last), label: first.toLocaleString('en-IN', { month: 'short' }) };
}
