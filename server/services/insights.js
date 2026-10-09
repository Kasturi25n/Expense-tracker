import { addDays, addPeriod, occurrencesBetween } from './recurring.js';
import { listGoals } from './goals.js';

// Thresholds (spec §2). Tune here.
const PACE_MIN_DAY = 3;
const CHANGE_MIN_AMOUNT = 500;
const CHANGE_MIN_RATIO = 0.25;
const REASON_MIN_SHARE = 0.4;
const MAX_INCREASES = 3;
const LEAK_MAX_AMOUNT = 200;
const LEAK_MIN_COUNT = 10;
const LEAK_MIN_TOTAL = 1000;
const LEAK_PAYEE_MIN = 5;
const UNUSUAL_MIN_AMOUNT = 1000;
const UNUSUAL_MULTIPLE = 3;
const UNUSUAL_MIN_HISTORY = 5;
const UNUSUAL_LOOKBACK_DAYS = 90;
const MAX_UNUSUAL = 2;
const SUBSCRIPTION_MIN_MONTHS = 3;
const SUBSCRIPTION_TOLERANCE = 0.1;
const MAX_SUBSCRIPTIONS = 3;
const HABIT_LOOKBACK_DAYS = 90;
const WEEKEND_MULTIPLE = 1.5;
const WEEKEND_MIN_TOTAL = 2000;
const LATE_NIGHT_MIN_COUNT = 4;
const GOOD_SAVINGS_RATE = 0.2;
const SAVINGS_IMPROVEMENT_POINTS = 5;
const MAX_GOAL_INSIGHTS = 2;

const TONE_ORDER = { warning: 0, info: 1, good: 2 };
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
const round = (n) => Math.round(n * 100) / 100;
const sum = (rows) => rows.reduce((total, r) => total + r.amount, 0);
const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fm = (n) => rupees.format(Math.round(n));
const payeeKey = (r) => r.payee.trim().toLowerCase();
const daysIn = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};
const monthEnd = (month) => `${month}-${pad(daysIn(month))}`;
const shortDate = (s) => `${Number(s.slice(8, 10))} ${MONTH_NAMES[Number(s.slice(5, 7)) - 1]}`;
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function groupBy(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

const biggestGroup = (rows, keyOf) => [...groupBy(rows, keyOf).values()].sort((x, y) => y.length - x.length)[0];

function monthContext(month, today) {
  const daysInMonth = daysIn(month);
  const isCurrent = today.slice(0, 7) === month;
  const dayOfMonth = isCurrent ? Number(today.slice(8, 10)) : daysInMonth;
  const prev = shiftMonth(month, -1);
  return {
    month, today, isCurrent, dayOfMonth, daysInMonth,
    start: `${month}-01`,
    end: monthEnd(month),
    upto: isCurrent ? today : monthEnd(month),
    prev: { month: prev, start: `${prev}-01`, end: monthEnd(prev), sameDay: `${prev}-${pad(Math.min(dayOfMonth, daysIn(prev)))}` },
  };
}

// Mid-month, "last month" means the same days of last month, so comparisons are like-for-like.
const previousUpTo = (ctx) => (ctx.isCurrent ? ctx.prev.sameDay : ctx.prev.end);

// `who` is { who, accountId }; accountId null means all accounts.
function txRows(db, who, type, from, to) {
  return db
    .prepare(
      `SELECT id, amount, occurred_at, category_id, account_id, payee, recurring_id FROM transactions
       WHERE user_id = ? AND type = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ?
         AND (? IS NULL OR account_id = ?) ORDER BY occurred_at, id`
    )
    .all(who.userId, type, from, to, who.accountId, who.accountId);
}
const expenses = (db, who, from, to) => txRows(db, who, 'expense', from, to);

function totalsFor(db, who, from, to) {
  const income = sum(txRows(db, who, 'income', from, to));
  const expense = sum(expenses(db, who, from, to));
  return { income: round(income), expense: round(expense), net: round(income - expense) };
}

function categoryTable(db, who, ctx) {
  const totalsBy = (from, to) => {
    const map = new Map();
    for (const r of expenses(db, who, from, to)) map.set(r.category_id, (map.get(r.category_id) ?? 0) + r.amount);
    return map;
  };
  const now = totalsBy(ctx.start, ctx.upto);
  const previous = totalsBy(ctx.prev.start, previousUpTo(ctx));
  const lastThree = [1, 2, 3].map((n) => shiftMonth(ctx.month, -n)).map((m) => totalsBy(`${m}-01`, monthEnd(m)));
  return [...new Set([...now.keys(), ...previous.keys()])]
    .map((categoryId) => ({
      categoryId,
      total: round(now.get(categoryId) ?? 0),
      previous: round(previous.get(categoryId) ?? 0),
      average: round(lastThree.reduce((s, m) => s + (m.get(categoryId) ?? 0), 0) / 3),
    }))
    .sort((a, b) => b.total - a.total || b.previous - a.previous);
}

function topPayees(db, who, ctx) {
  return [...groupBy(expenses(db, who, ctx.start, ctx.upto).filter((r) => r.payee), payeeKey).values()]
    .map((list) => ({ payee: list[list.length - 1].payee, total: round(sum(list)), count: list.length }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
}

function upcomingOccurrences(db, who, ctx) {
  // Pending confirm-bills (dated ≤ today) are still to be paid, so they count as upcoming.
  return db
    .prepare(
      `SELECT r.* FROM recurring_rules r
       JOIN accounts a ON a.id = r.account_id
       LEFT JOIN accounts ta ON ta.id = r.to_account_id
       WHERE r.user_id = ? AND r.active = 1 AND a.archived = 0 AND (ta.id IS NULL OR ta.archived = 0)
         AND (? IS NULL OR r.account_id = ?)`
    )
    .all(who.userId, who.accountId, who.accountId)
    .flatMap((r) => occurrencesBetween(r, ctx.end).dates.map((date) => ({ type: r.type, amount: r.amount, category_id: r.category_id, date })));
}

function budgetsFor(db, who, month) {
  let overall = null;
  const byCategory = new Map();
  // Budgets cover all accounts, so they don't apply to a single-account view.
  if (who.accountId) return { overall, byCategory };
  for (const b of db.prepare('SELECT category_id, amount FROM budgets WHERE user_id = ? AND month = ? ORDER BY id').all(who.userId, month)) {
    if (b.category_id === null) overall = b.amount;
    else byCategory.set(b.category_id, b.amount);
  }
  return { overall, byCategory };
}

function paceReport(db, who, ctx, names) {
  if (!ctx.isCurrent || ctx.dayOfMonth < PACE_MIN_DAY) return { pace: null, insights: [] };

  const rows = expenses(db, who, ctx.start, ctx.today);
  const upcoming = upcomingOccurrences(db, who, ctx);
  const daysRemaining = ctx.daysInMonth - ctx.dayOfMonth;
  const daysLeft = daysRemaining + 1;
  const project = (list, fixed) => sum(list) + (sum(list.filter((r) => r.recurring_id === null)) / ctx.dayOfMonth) * daysRemaining + fixed;

  const spentSoFar = sum(rows);
  const upcomingFixed = sum(upcoming.filter((o) => o.type === 'expense'));
  if (spentSoFar === 0 && upcomingFixed === 0) return { pace: null, insights: [] };
  const forecast = round(project(rows, upcomingFixed));

  const budgets = budgetsFor(db, who, ctx.month);
  let limit = null;
  let limitSource = null;
  let limitLabel = '';
  if (budgets.overall !== null) {
    [limit, limitSource] = [budgets.overall, 'budget'];
    limitLabel = `your ${fm(limit)} budget`;
  } else if (budgets.byCategory.size) {
    [limit, limitSource] = [[...budgets.byCategory.values()].reduce((a, b) => a + b, 0), 'category-budgets'];
    limitLabel = `your ${fm(limit)} of budgets`;
  } else {
    const income = sum(txRows(db, who, 'income', ctx.start, ctx.end)) + sum(upcoming.filter((o) => o.type === 'income'));
    if (income > 0) {
      [limit, limitSource] = [income, 'income'];
      limitLabel = `your ${fm(limit)} income`;
    }
  }
  const safePerDay = limit === null ? null : round((limit - spentSoFar - upcomingFixed) / daysLeft);

  const insights = [];
  if (limit === null) {
    insights.push({
      id: 'pace', tone: 'info', impact: 0,
      title: `At this pace you'll spend about ${fm(forecast)} this month`,
      detail: 'Set a budget to see how much you can spend each day.',
      action: { label: 'Set a budget', to: '/budgets' },
    });
  } else if (safePerDay <= 0) {
    insights.push({
      id: 'pace', tone: 'warning', impact: spentSoFar + upcomingFixed - limit,
      title: `You've used up ${limitLabel}`,
      detail: upcomingFixed > 0
        ? `Spent ${fm(spentSoFar)} plus ${fm(upcomingFixed)} in bills still due, with ${daysLeft} days to go.`
        : `Spent ${fm(spentSoFar)} with ${daysLeft} days to go.`,
    });
  } else if (forecast > limit) {
    insights.push({
      id: 'pace', tone: 'warning', impact: forecast - limit,
      title: `At this pace you'll spend ${fm(forecast)} this month`,
      detail: `That's ${fm(forecast - limit)} over ${limitLabel}. Try to keep to ${fm(safePerDay)} a day for the next ${daysLeft} days.`,
    });
  } else {
    insights.push({
      id: 'pace', tone: 'good', impact: 0,
      title: `On track: about ${fm(forecast)} this month`,
      detail: `You can spend ${fm(safePerDay)} a day for the next ${daysLeft} days.`,
    });
  }

  const byCategory = groupBy(rows, (r) => r.category_id);
  for (const [categoryId, budget] of budgets.byCategory) {
    const catRows = byCategory.get(categoryId) ?? [];
    const spent = sum(catRows);
    if (spent >= budget) continue;
    const catForecast = project(catRows, sum(upcoming.filter((o) => o.type === 'expense' && o.category_id === categoryId)));
    if (catForecast > budget) {
      insights.push({
        id: `pace-category:${categoryId}`, tone: 'warning', impact: catForecast - budget,
        title: `${names.get(categoryId)} is heading for ${fm(catForecast)}`,
        detail: `Its budget is ${fm(budget)}, with ${fm(budget - spent)} left for ${daysLeft} days.`,
      });
    }
  }

  return { pace: { spentSoFar: round(spentSoFar), forecast, limit, limitSource, safePerDay, daysLeft }, insights };
}

function mainPayee(nowRows, beforeRows, delta) {
  const before = groupBy(beforeRows.filter((r) => r.payee), payeeKey);
  let best = null;
  for (const [key, list] of groupBy(nowRows.filter((r) => r.payee), payeeKey)) {
    const prior = before.get(key) ?? [];
    const growth = sum(list) - sum(prior);
    if (!best || growth > best.growth) best = { name: list[list.length - 1].payee, growth, count: list.length, prior: prior.length };
  }
  if (!best || best.growth < delta * REASON_MIN_SHARE) return null;
  const payments = `${best.count} ${best.count === 1 ? 'payment' : 'payments'}`;
  return best.prior === 0 ? `${best.name}: ${payments}, none before` : `${best.name}: ${payments} vs ${best.prior}`;
}

function changeInsights(db, who, ctx, names) {
  const nowBy = groupBy(expenses(db, who, ctx.start, ctx.upto).filter((r) => r.category_id !== null), (r) => r.category_id);
  const beforeBy = groupBy(expenses(db, who, ctx.prev.start, previousUpTo(ctx)).filter((r) => r.category_id !== null), (r) => r.category_id);
  // Without any earlier spending there is no baseline, so "new spending" would flag everything.
  const hasHistory = Boolean(
    db.prepare("SELECT 1 FROM transactions WHERE user_id = ? AND type = 'expense' AND substr(occurred_at, 1, 10) < ? LIMIT 1").get(who.userId, ctx.start)
  );

  const changes = [];
  for (const id of new Set([...nowBy.keys(), ...beforeBy.keys()])) {
    const a = sum(nowBy.get(id) ?? []);
    const b = sum(beforeBy.get(id) ?? []);
    const delta = a - b;
    if (b === 0 && !hasHistory) continue;
    if (Math.abs(delta) < CHANGE_MIN_AMOUNT) continue;
    if (b > 0 && Math.abs(delta) / b < CHANGE_MIN_RATIO) continue;
    changes.push({ id, a, b, delta });
  }

  const compare = (a, b) => (ctx.isCurrent ? `${fm(a)} so far vs ${fm(b)} by this point last month` : `${fm(a)} vs ${fm(b)} last month`);
  const action = (id) => ({ label: 'See transactions', to: `/transactions?categoryId=${id}&from=${ctx.start}&to=${ctx.upto}` });

  const insights = changes
    .filter((c) => c.delta > 0)
    .sort((x, y) => y.delta - x.delta)
    .slice(0, MAX_INCREASES)
    .map(({ id, a, b, delta }) => {
      const reason = mainPayee(nowBy.get(id) ?? [], beforeBy.get(id) ?? [], delta);
      return {
        id: `category-up:${id}`, tone: 'warning', impact: delta,
        title: b === 0 ? `New spending on ${names.get(id)}: ${fm(a)}` : `${names.get(id)} up ${Math.round((delta / b) * 100)}% (${fm(delta)}) vs last month`,
        detail: `${compare(a, b)}${reason ? ` — mostly ${reason}` : ''}.`,
        action: action(id),
      };
    });

  const drop = changes.filter((c) => c.delta < 0).sort((x, y) => x.delta - y.delta)[0];
  if (drop) {
    insights.push({
      id: `category-down:${drop.id}`, tone: 'good', impact: -drop.delta,
      title: `${names.get(drop.id)} down ${Math.round((-drop.delta / drop.b) * 100)}% (${fm(-drop.delta)}) vs last month`,
      detail: `${compare(drop.a, drop.b)}. Nice.`,
      action: action(drop.id),
    });
  }
  return insights;
}

function leakInsights(db, who, ctx) {
  const small = expenses(db, who, ctx.start, ctx.upto).filter((r) => r.amount < LEAK_MAX_AMOUNT);
  const total = sum(small);
  if (small.length < LEAK_MIN_COUNT || total < LEAK_MIN_TOTAL) return [];
  const top = biggestGroup(small.filter((r) => r.payee), payeeKey);
  return [{
    id: 'leaks', tone: 'info', impact: total,
    title: `${small.length} small purchases under ${fm(LEAK_MAX_AMOUNT)} added up to ${fm(total)}`,
    detail: top && top.length >= LEAK_PAYEE_MIN ? `Mostly ${top[top.length - 1].payee} (${top.length}).` : 'Small amounts add up quietly.',
  }];
}

function unusualInsights(db, who, ctx, names) {
  const history = db.prepare(
    `SELECT amount FROM transactions WHERE user_id = ? AND type = 'expense' AND category_id = ?
     AND substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) < ?`
  );
  const found = [];
  for (const r of expenses(db, who, ctx.start, ctx.upto)) {
    if (r.amount < UNUSUAL_MIN_AMOUNT || r.category_id === null) continue;
    const day = r.occurred_at.slice(0, 10);
    const past = history.all(who.userId, r.category_id, addDays(day, -UNUSUAL_LOOKBACK_DAYS), day).map((h) => h.amount);
    if (past.length < UNUSUAL_MIN_HISTORY) continue;
    const usual = median(past);
    if (r.amount >= UNUSUAL_MULTIPLE * usual) found.push({ r, usual, multiple: r.amount / usual });
  }
  return found
    .sort((x, y) => y.multiple - x.multiple)
    .slice(0, MAX_UNUSUAL)
    .map(({ r, usual, multiple }) => ({
      id: `unusual:${r.id}`, tone: 'info', impact: r.amount - usual,
      title: `${fm(r.amount)} at ${r.payee || names.get(r.category_id)} was unusually high`,
      detail: `It's ${Math.round(multiple)}× your usual ${names.get(r.category_id)} spend of ${fm(usual)} (${shortDate(r.occurred_at)}).`,
    }));
}

function subscriptionInsights(db, who, ctx) {
  const rows = expenses(db, who, `${shiftMonth(ctx.month, -3)}-01`, ctx.upto).filter((r) => r.payee);
  const tracked = new Set(
    db.prepare("SELECT lower(trim(payee)) AS payee FROM recurring_rules WHERE user_id = ? AND payee != ''").all(who.userId).map((x) => x.payee)
  );
  const found = [];
  for (const [key, list] of groupBy(rows, payeeKey)) {
    if (tracked.has(key) || list.some((r) => r.recurring_id !== null)) continue;
    const months = groupBy(list, (r) => r.occurred_at.slice(0, 7));
    if (months.size < SUBSCRIPTION_MIN_MONTHS || [...months.values()].some((m) => m.length > 1)) continue;
    const usual = median(list.map((r) => r.amount));
    if (list.some((r) => Math.abs(r.amount - usual) > usual * SUBSCRIPTION_TOLERANCE)) continue;
    found.push({ last: list[list.length - 1], usual });
  }
  return found
    .sort((x, y) => y.usual - x.usual)
    .slice(0, MAX_SUBSCRIPTIONS)
    .map(({ last, usual }) => {
      const day = last.occurred_at.slice(0, 10);
      const anchor = Number(day.slice(8, 10));
      let nextDate = addPeriod(day, 'monthly', anchor);
      while (nextDate < ctx.today) nextDate = addPeriod(nextDate, 'monthly', anchor);
      const params = new URLSearchParams({
        new: '1', type: 'expense', payee: last.payee, amount: String(round(usual)),
        categoryId: last.category_id ?? '', accountId: last.account_id, frequency: 'monthly', nextDate,
      });
      return {
        id: `subscription:${payeeKey(last)}`, tone: 'info', impact: usual,
        title: `${last.payee} looks like a subscription: ${fm(usual)} every month`,
        detail: 'Track it as a repeating item so it logs itself and counts in your forecast.',
        action: { label: 'Track it', to: `/recurring?${params}` },
      };
    });
}

const isWeekend = (s) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
};

function habitInsights(db, who, ctx) {
  const insights = [];

  const from = addDays(ctx.upto, -(HABIT_LOOKBACK_DAYS - 1));
  const rows = expenses(db, who, from, ctx.upto).filter((r) => r.recurring_id === null);
  let weekendDays = 0;
  let weekdayDays = 0;
  for (let d = from; d <= ctx.upto; d = addDays(d, 1)) {
    if (isWeekend(d)) weekendDays += 1;
    else weekdayDays += 1;
  }
  const weekendTotal = sum(rows.filter((r) => isWeekend(r.occurred_at)));
  const weekendAvg = weekendTotal / weekendDays;
  const weekdayAvg = (sum(rows) - weekendTotal) / weekdayDays;
  if (weekdayAvg > 0 && weekendTotal >= WEEKEND_MIN_TOTAL && weekendAvg >= WEEKEND_MULTIPLE * weekdayAvg) {
    insights.push({
      id: 'weekends', tone: 'info', impact: weekendTotal - weekdayAvg * weekendDays,
      title: `You spend ${(weekendAvg / weekdayAvg).toFixed(1)}× more per day on weekends`,
      detail: `${fm(weekendAvg)} a day on weekends vs ${fm(weekdayAvg)} on weekdays, over the last ${HABIT_LOOKBACK_DAYS} days.`,
    });
  }

  const late = expenses(db, who, ctx.start, ctx.upto).filter((r) => {
    if (!r.occurred_at.includes('T')) return false;
    const hour = Number(r.occurred_at.slice(11, 13));
    return hour >= 23 || hour < 4;
  });
  if (late.length >= LATE_NIGHT_MIN_COUNT) {
    const top = biggestGroup(late.filter((r) => r.payee), payeeKey);
    const mostly = top && top.length * 2 >= late.length ? top[top.length - 1].payee : null;
    insights.push({
      id: 'late-nights', tone: 'info', impact: sum(late),
      title: `${late.length} late-night purchases this month (${fm(sum(late))})`,
      detail: mostly ? `Mostly ${mostly}, between 11 pm and 4 am.` : 'Between 11 pm and 4 am.',
    });
  }
  return insights;
}

function savingsInsights(db, who, ctx) {
  const income = sum(txRows(db, who, 'income', ctx.start, ctx.upto));
  if (income === 0) {
    if (who.accountId) return [];
    const hasIncomeItem = db.prepare("SELECT 1 FROM recurring_rules WHERE user_id = ? AND type = 'income' AND active = 1 LIMIT 1").get(who.userId);
    if (hasIncomeItem) return [];
    // Start from this month's 1st so an old report can't backfill months of salary.
    const params = new URLSearchParams({ new: '1', type: 'income', frequency: 'monthly', nextDate: `${ctx.today.slice(0, 7)}-01` });
    return [{
      id: 'add-income', tone: 'info', impact: Number.MAX_SAFE_INTEGER,
      title: 'How much do you earn?',
      detail: "Add your salary once and it logs itself every month — then you'll see how much you save.",
      action: { label: 'Add income', to: `/recurring?${params}` },
    }];
  }

  const expense = sum(expenses(db, who, ctx.start, ctx.upto));
  const net = income - expense;
  const soFar = ctx.isCurrent ? ' so far' : '';
  if (net < 0) {
    return [{
      id: 'savings', tone: 'warning', impact: -net,
      title: `You spent ${fm(-net)} more than you earned${soFar}`,
      detail: `Money in ${fm(income)}, money out ${fm(expense)}.`,
    }];
  }

  const pastRates = [1, 2, 3]
    .map((n) => shiftMonth(ctx.month, -n))
    .map((m) => {
      const monthIncome = sum(txRows(db, who, 'income', `${m}-01`, monthEnd(m)));
      return monthIncome > 0 ? (monthIncome - sum(expenses(db, who, `${m}-01`, monthEnd(m)))) / monthIncome : null;
    })
    .filter((rate) => rate !== null);
  // Round down so 99.5% reads as 99%, never a premature 100%.
  const pct = Math.floor((net / income) * 100);
  const avgPct = pastRates.length ? Math.round((pastRates.reduce((a, b) => a + b, 0) / pastRates.length) * 100) : null;
  const span = `the last ${pastRates.length} ${pastRates.length === 1 ? 'month' : 'months'}`;
  const title = `You saved ${pct}% of your income${soFar} (${fm(net)})`;

  if (pct >= GOOD_SAVINGS_RATE * 100 || (avgPct !== null && pct >= avgPct + SAVINGS_IMPROVEMENT_POINTS)) {
    const detail = avgPct === null ? 'Keep it up.' : pct > avgPct ? `Up from ${avgPct}% on average over ${span}.` : `Your average over ${span} is ${avgPct}%.`;
    return [{ id: 'savings', tone: 'good', impact: net, title, detail }];
  }
  return [{
    id: 'savings', tone: 'info', impact: net, title,
    detail: avgPct === null ? 'Aim to save 20% or more.' : `Your average over ${span} is ${avgPct}%.`,
  }];
}

// Goals are a whole-household tally, so they only show for the current month across all accounts.
function goalInsights(db, who, ctx) {
  if (!ctx.isCurrent || who.accountId !== null) return [];
  return listGoals(db, who.userId, ctx.today)
    .filter((g) => g.status === 'behind' || g.status === 'overdue')
    .sort((x, y) => y.remaining - x.remaining)
    .slice(0, MAX_GOAL_INSIGHTS)
    .map((g) => ({
      id: `goal-${g.id}`, tone: 'info', impact: g.remaining,
      title: g.status === 'overdue' ? `"${g.name}" is past its deadline` : `"${g.name}" is behind plan`,
      detail:
        g.status === 'overdue'
          ? `${fm(g.saved)} of ${fm(g.target_amount)} saved. Add the remaining ${fm(g.remaining)} or pick a new deadline.`
          : `${fm(g.saved)} of ${fm(g.target_amount)} saved. Putting aside ${fm(g.perMonth)} a month gets you there by ${shortDate(g.target_date)}.`,
      action: { label: 'Open goals', to: '/goals' },
    }));
}

const DETECTORS = [changeInsights, leakInsights, unusualInsights, subscriptionInsights, habitInsights, savingsInsights, goalInsights];

export function buildMonthReport(db, userId, month, today, accountId = null) {
  const who = { userId, accountId };
  const ctx = monthContext(month, today);
  const names = new Map(db.prepare('SELECT id, name FROM categories WHERE user_id = ?').all(userId).map((c) => [c.id, c.name]));
  const { pace, insights: paceInsights } = paceReport(db, who, ctx, names);
  const insights = [...paceInsights, ...DETECTORS.flatMap((detect) => detect(db, who, ctx, names))]
    .sort((x, y) => TONE_ORDER[x.tone] - TONE_ORDER[y.tone] || y.impact - x.impact)
    .map(({ impact, ...insight }) => insight);
  return {
    month,
    isCurrentMonth: ctx.isCurrent,
    totals: {
      ...totalsFor(db, who, ctx.start, ctx.upto),
      expectedIncome: round(
        sum(txRows(db, who, 'income', ctx.start, ctx.end)) +
          sum(upcomingOccurrences(db, who, ctx).filter((o) => o.type === 'income' && o.date >= ctx.start))
      ),
      previous: totalsFor(db, who, ctx.prev.start, previousUpTo(ctx)),
    },
    pace,
    insights,
    categories: categoryTable(db, who, ctx),
    topPayees: topPayees(db, who, ctx),
  };
}
