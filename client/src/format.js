const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export const formatMoney = (amount) => rupee.format(amount);

export function formatDateTime(value) {
  if (!value) return '';
  if (!value.includes('T')) return value;
  const d = new Date(value);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function nowLocalDateTime() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
