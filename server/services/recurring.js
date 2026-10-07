export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const MONTHS_PER_PERIOD = { monthly: 1, quarterly: 3, yearly: 12 };

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return toDateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// anchorDay is the day-of-month the item was set up on, so "31st" survives a 28-day February.
export function addPeriod(dateStr, frequency, anchorDay) {
  if (frequency === 'weekly') return addDays(dateStr, 7);
  const [y, m] = dateStr.split('-').map(Number);
  const monthIndex = m - 1 + MONTHS_PER_PERIOD[frequency];
  const year = y + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return toDateStr(year, month, Math.min(anchorDay, daysInMonth(year, month)));
}

export function occurrencesBetween(rule, until) {
  const dates = [];
  let date = rule.next_date;
  while (date <= until && (!rule.end_date || date <= rule.end_date)) {
    dates.push(date);
    date = addPeriod(date, rule.frequency, rule.anchor_day);
  }
  return { dates, nextDate: date };
}

export function todayLocal() {
  const now = new Date();
  return toDateStr(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
