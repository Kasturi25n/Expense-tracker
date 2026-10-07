# Part 2 — Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a rule-based insights engine (`GET /api/insights?month=`) and show it on a new Insights page, on Home, and as an income strip on Budgets.

**Architecture:** One service file, `server/services/insights.js`, holds named thresholds, a month context, small query helpers and one detector function per insight, composed by `buildMonthReport()`. A thin router exposes it behind auth + recurring materialisation. The client adds an `InsightCard`, an `Insights` page, and URL deep links so insight actions open pre-filtered Transactions or a pre-filled Recurring form.

**Tech Stack:** Node ≥ 22.5 (`node:sqlite`), Express 4, vitest + supertest; React + Vite, react-router-dom.

**Spec:** `docs/superpowers/specs/2026-10-07-part2-insights-design.md`

## Global Constraints

- **No commits or pushes** — the user commits after verifying on localhost (standing rule). Work stays uncommitted on `main`.
- No new npm dependencies.
- Insight text uses whole rupees, en-IN grouping (`₹42,300`); month abbreviations come from a fixed array (ICU writes "Sept", so never rely on locale month names in server text).
- `today` always comes from the app's injectable clock (`createApp(db, secret, { today })`).
- Transfers never count; "expenses" = `type = 'expense'`.
- Thresholds are named constants at the top of `services/insights.js` with the spec's values.
- Server tests: `cd server && npx vitest run`. Client check: `cd client && npx vite build`.

## Review Focus

1. **Mid-month comparisons must be like-for-like** — days 1→today vs the same days last month (and a 31st vs a 30-day month clamps). Pinned in Task 3.
2. **Recurring postings must not inflate "variable" pace or weekend habits**, and pending confirm-bills must count as upcoming spend. Pinned in Tasks 2 and 6.
3. **A brand-new user (no data, no income)** must get a calm report: zero totals, no crashes on divide-by-zero, only the "How much do you earn?" prompt. Pinned in Tasks 1 and 6.
4. **Other users' data never leaks into a report.** Pinned in Task 1.
5. **Entries without a time** (migrated date-only rows, recurring postings) must not count as late-night. Pinned in Task 6.

---

### Task 1: Month report skeleton — endpoint, totals, categories table, top payees

**Files:**
- Create: `server/services/insights.js`, `server/routes/insights.js`, `server/tests/insights-report.test.js`
- Modify: `server/app.js` (mount), `server/tests/helpers.js` (add `insightsEnv`)

**Interfaces:**
- Produces: `buildMonthReport(db, userId, month, today) → { month, isCurrentMonth, totals: { income, expense, net, previous: { income, expense, net } }, pace, insights, categories: [{ categoryId, total, previous, average }], topPayees: [{ payee, total, count }] }`; `createInsightsRouter(db, today)`; detectors have the signature `(db, userId, ctx, names) → insight[]` where insight = `{ id, tone: 'warning'|'info'|'good', impact, title, detail, action? }` (`impact` is stripped from the response); helper `insightsEnv(today?)` for tests.

- [ ] **Step 1: Add the test environment helper** — append to `server/tests/helpers.js`:

```js
export async function insightsEnv(today = '2026-10-20') {
  const clock = { today };
  const { app, db } = freshApp({ today: () => clock.today });
  const { token, userId } = await signup(app);
  const api = client(app, token);
  return {
    app, db, userId, api, clock,
    cash: cashId(db, userId),
    id: (name) => catId(db, userId, name),
    tx: (amount, occurredAt, extra = {}) => addTx(db, userId, { amount, occurredAt, ...extra }),
    report: async (month = clock.today.slice(0, 7)) => (await api.get(`/api/insights?month=${month}`)).body,
  };
}

export const pick = (report, prefix) => report.insights.filter((i) => i.id.startsWith(prefix));
```

- [ ] **Step 2: Write the failing tests** — `server/tests/insights-report.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { insightsEnv, signup, addTx } from './helpers.js';

describe('insights report', () => {
  it('returns totals, a categories table and top payees for the month', async () => {
    const env = await insightsEnv();
    const food = env.id('Food & Dining');
    const transport = env.id('Transport');
    env.tx(50000, '2026-10-01', { type: 'income' });
    env.tx(500, '2026-10-02T13:00', { categoryId: food, payee: 'Swiggy' });
    env.tx(300, '2026-10-05T20:00', { categoryId: food, payee: 'swiggy' });
    env.tx(200, '2026-10-06T09:00', { categoryId: transport, payee: 'Uber' });
    env.tx(1000, '2026-09-10', { categoryId: food });
    env.tx(100, '2026-09-11', { categoryId: transport });
    env.tx(600, '2026-08-10', { categoryId: food });
    env.tx(1400, '2026-07-10', { categoryId: food });

    const r = await env.report();
    expect(r).toMatchObject({ month: '2026-10', isCurrentMonth: true });
    expect(r.totals).toEqual({ income: 50000, expense: 1000, net: 49000, previous: { income: 0, expense: 1100, net: -1100 } });
    expect(r.categories).toEqual([
      { categoryId: food, total: 800, previous: 1000, average: 1000 },
      { categoryId: transport, total: 200, previous: 100, average: 33.33 },
    ]);
    expect(r.topPayees).toEqual([
      { payee: 'swiggy', total: 800, count: 2 },
      { payee: 'Uber', total: 200, count: 1 },
    ]);
  });

  it('rejects an invalid month', async () => {
    const env = await insightsEnv();
    expect((await env.api.get('/api/insights?month=2026-13')).status).toBe(400);
    expect((await env.api.get('/api/insights?month=oct')).status).toBe(400);
  });

  it("never includes another user's transactions", async () => {
    const env = await insightsEnv();
    const other = await signup(env.app, 'other@example.com');
    addTx(env.db, other.userId, { amount: 9999, occurredAt: '2026-10-05', payee: 'Secret' });
    const r = await env.report();
    expect(r.totals.expense).toBe(0);
    expect(r.topPayees).toEqual([]);
  });

  it('handles an empty month calmly', async () => {
    const env = await insightsEnv();
    const r = await env.report('2026-05');
    expect(r).toMatchObject({
      month: '2026-05', isCurrentMonth: false, pace: null, categories: [], topPayees: [],
      totals: { income: 0, expense: 0, net: 0, previous: { income: 0, expense: 0, net: 0 } },
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `cd server && npx vitest run tests/insights-report.test.js` → FAIL (404 / undefined).

- [ ] **Step 4: Write the service skeleton** — `server/services/insights.js`:

```js
import { addDays, addPeriod, occurrencesBetween } from './recurring.js';

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

function txRows(db, userId, type, from, to) {
  return db
    .prepare(
      `SELECT id, amount, occurred_at, category_id, account_id, payee, recurring_id FROM transactions
       WHERE user_id = ? AND type = ? AND substr(occurred_at, 1, 10) BETWEEN ? AND ? ORDER BY occurred_at, id`
    )
    .all(userId, type, from, to);
}
const expenses = (db, userId, from, to) => txRows(db, userId, 'expense', from, to);

function totalsFor(db, userId, from, to) {
  const income = sum(txRows(db, userId, 'income', from, to));
  const expense = sum(expenses(db, userId, from, to));
  return { income: round(income), expense: round(expense), net: round(income - expense) };
}

function categoryTable(db, userId, ctx) {
  const totalsBy = (from, to) => {
    const map = new Map();
    for (const r of expenses(db, userId, from, to)) map.set(r.category_id, (map.get(r.category_id) ?? 0) + r.amount);
    return map;
  };
  const now = totalsBy(ctx.start, ctx.upto);
  const previous = totalsBy(ctx.prev.start, ctx.prev.end);
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

function topPayees(db, userId, ctx) {
  return [...groupBy(expenses(db, userId, ctx.start, ctx.upto).filter((r) => r.payee), payeeKey).values()]
    .map((list) => ({ payee: list[list.length - 1].payee, total: round(sum(list)), count: list.length }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
}

const DETECTORS = [];

export function buildMonthReport(db, userId, month, today) {
  const ctx = monthContext(month, today);
  const names = new Map(db.prepare('SELECT id, name FROM categories WHERE user_id = ?').all(userId).map((c) => [c.id, c.name]));
  const pace = null;
  const insights = DETECTORS.flatMap((detect) => detect(db, userId, ctx, names))
    .sort((x, y) => TONE_ORDER[x.tone] - TONE_ORDER[y.tone] || y.impact - x.impact)
    .map(({ impact, ...insight }) => insight);
  return {
    month,
    isCurrentMonth: ctx.isCurrent,
    totals: { ...totalsFor(db, userId, ctx.start, ctx.upto), previous: totalsFor(db, userId, ctx.prev.start, ctx.prev.end) },
    pace,
    insights,
    categories: categoryTable(db, userId, ctx),
    topPayees: topPayees(db, userId, ctx),
  };
}
```

(The unused imports and constants are consumed by Tasks 2–6.)

`server/routes/insights.js`:

```js
import { Router } from 'express';
import { ValidationError } from '../validate.js';
import { buildMonthReport } from '../services/insights.js';

export function createInsightsRouter(db, today) {
  const router = Router();
  router.get('/', (req, res) => {
    const month = req.query.month ?? today().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError('Month must look like 2026-10');
    res.json(buildMonthReport(db, req.userId, month, today()));
  });
  return router;
}
```

In `server/app.js` add `import { createInsightsRouter } from './routes/insights.js';` and mount `app.use('/api/insights', ...authed, createInsightsRouter(db, today));` after the summary line.

- [ ] **Step 5: Run to verify it passes** — `cd server && npx vitest run` → PASS (88 tests).

---

### Task 2: Pace & safe-to-spend

**Files:** Modify `server/services/insights.js`; Test `server/tests/insights-pace.test.js`

**Interfaces:** Produces `pace = { spentSoFar, forecast, limit, limitSource, safePerDay, daysLeft }` or `null`; insight ids `pace`, `pace-category:<categoryId>`.

- [ ] **Step 1: Write the failing tests** — `server/tests/insights-pace.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('pace insight', () => {
  it('forecasts without a limit (day 20 of 31)', async () => {
    const env = await insightsEnv();
    env.tx(2000, '2026-10-05T10:00');
    env.tx(2000, '2026-10-15T10:00');
    const r = await env.report();
    expect(r.pace).toEqual({ spentSoFar: 4000, forecast: 6200, limit: null, limitSource: null, safePerDay: null, daysLeft: 12 });
    expect(pick(r, 'pace')).toEqual([expect.objectContaining({ tone: 'info', title: "At this pace you'll spend about ₹6,200 this month" })]);
  });

  it('projects only variable spending and adds upcoming and pending repeating items', async () => {
    const env = await insightsEnv();
    const base = { type: 'expense', accountId: env.cash, frequency: 'monthly', mode: 'auto' };
    await env.api.post('/api/recurring', { ...base, amount: 3000, payee: 'SIP', nextDate: '2026-10-05' });
    await env.api.post('/api/recurring', { ...base, amount: 10000, payee: 'Landlord', nextDate: '2026-10-25' });
    await env.api.post('/api/recurring', { ...base, amount: 1500, payee: 'BESCOM', nextDate: '2026-10-15', mode: 'confirm' });
    env.tx(2000, '2026-10-10T10:00');
    const r = await env.report();
    expect(r.pace).toMatchObject({ spentSoFar: 5000, forecast: 17600 });
  });

  it('warns when the forecast passes the overall budget', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/budgets', { month: '2026-10', amount: 10000 });
    env.tx(4000, '2026-10-05T10:00');
    env.tx(4000, '2026-10-12T10:00');
    const r = await env.report();
    expect(r.pace).toMatchObject({ forecast: 12400, limit: 10000, limitSource: 'budget', safePerDay: 166.67 });
    expect(pick(r, 'pace')[0]).toMatchObject({
      tone: 'warning',
      title: "At this pace you'll spend ₹12,400 this month",
      detail: "That's ₹2,400 over your ₹10,000 budget. Try to keep to ₹167 a day for the next 12 days.",
    });
  });

  it('says when the limit is already used up', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/budgets', { month: '2026-10', amount: 5000 });
    env.tx(6000, '2026-10-05T10:00');
    expect(pick(await env.report(), 'pace')[0]).toMatchObject({
      tone: 'warning', title: "You've used up your ₹5,000 budget", detail: 'Spent ₹6,000 with 12 days to go.',
    });
  });

  it('uses income as the limit when there are no budgets', async () => {
    const env = await insightsEnv();
    env.tx(50000, '2026-10-01', { type: 'income' });
    env.tx(4000, '2026-10-05T10:00');
    const r = await env.report();
    expect(r.pace).toMatchObject({ limit: 50000, limitSource: 'income', safePerDay: 3833.33 });
    expect(pick(r, 'pace')[0]).toMatchObject({
      tone: 'good', title: 'On track: about ₹6,200 this month', detail: 'You can spend ₹3,833 a day for the next 12 days.',
    });
  });

  it('warns when a category is heading over its budget', async () => {
    const env = await insightsEnv();
    const food = env.id('Food & Dining');
    await env.api.post('/api/budgets', { month: '2026-10', amount: 3000, categoryId: food });
    env.tx(2000, '2026-10-08T13:00', { categoryId: food });
    expect(pick(await env.report(), 'pace-category')).toEqual([
      expect.objectContaining({
        id: `pace-category:${food}`, tone: 'warning',
        title: 'Food & Dining is heading for ₹3,100',
        detail: 'Its budget is ₹3,000, with ₹1,000 left for 12 days.',
      }),
    ]);
  });

  it('stays quiet before day 3 and for past months', async () => {
    const env = await insightsEnv('2026-10-02');
    env.tx(500, '2026-10-01T10:00');
    expect((await env.report()).pace).toBeNull();
    expect(pick(await env.report(), 'pace')).toEqual([]);
    expect((await env.report('2026-09')).pace).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run tests/insights-pace.test.js` → FAIL (`pace` is null).

- [ ] **Step 3: Implement** — add to `server/services/insights.js` (above `DETECTORS`):

```js
function upcomingOccurrences(db, userId, ctx) {
  // Pending confirm-bills (dated ≤ today) are still to be paid, so they count as upcoming.
  return db
    .prepare(
      `SELECT r.* FROM recurring_rules r
       JOIN accounts a ON a.id = r.account_id
       LEFT JOIN accounts ta ON ta.id = r.to_account_id
       WHERE r.user_id = ? AND r.active = 1 AND a.archived = 0 AND (ta.id IS NULL OR ta.archived = 0)`
    )
    .all(userId)
    .flatMap((r) => occurrencesBetween(r, ctx.end).dates.map((date) => ({ type: r.type, amount: r.amount, category_id: r.category_id, date })));
}

function budgetsFor(db, userId, month) {
  let overall = null;
  const byCategory = new Map();
  for (const b of db.prepare('SELECT category_id, amount FROM budgets WHERE user_id = ? AND month = ? ORDER BY id').all(userId, month)) {
    if (b.category_id === null) overall = b.amount;
    else byCategory.set(b.category_id, b.amount);
  }
  return { overall, byCategory };
}

function paceReport(db, userId, ctx, names) {
  if (!ctx.isCurrent || ctx.dayOfMonth < PACE_MIN_DAY) return { pace: null, insights: [] };

  const rows = expenses(db, userId, ctx.start, ctx.today);
  const upcoming = upcomingOccurrences(db, userId, ctx);
  const daysRemaining = ctx.daysInMonth - ctx.dayOfMonth;
  const daysLeft = daysRemaining + 1;
  const project = (list, fixed) => sum(list) + (sum(list.filter((r) => r.recurring_id === null)) / ctx.dayOfMonth) * daysRemaining + fixed;

  const spentSoFar = sum(rows);
  const upcomingFixed = sum(upcoming.filter((o) => o.type === 'expense'));
  const forecast = round(project(rows, upcomingFixed));

  const budgets = budgetsFor(db, userId, ctx.month);
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
    const income = sum(txRows(db, userId, 'income', ctx.start, ctx.end)) + sum(upcoming.filter((o) => o.type === 'income'));
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
      detail: `Spent ${fm(spentSoFar)} with ${daysLeft} days to go.`,
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
```

In `buildMonthReport` replace `const pace = null;` and the `insights` expression with:

```js
  const { pace, insights: paceInsights } = paceReport(db, userId, ctx, names);
  const insights = [...paceInsights, ...DETECTORS.flatMap((detect) => detect(db, userId, ctx, names))]
    .sort((x, y) => TONE_ORDER[x.tone] - TONE_ORDER[y.tone] || y.impact - x.impact)
    .map(({ impact, ...insight }) => insight);
```

- [ ] **Step 4: Run to verify it passes** — `cd server && npx vitest run` → PASS (95 tests).

---

### Task 3: What changed vs last month (with the reason)

**Files:** Modify `server/services/insights.js`; Test `server/tests/insights-changes.test.js`

**Interfaces:** insight ids `category-up:<id>` (warning), `category-down:<id>` (good), action `{ label: 'See transactions', to: '/transactions?categoryId=<id>&from=<start>&to=<upto>' }`.

- [ ] **Step 1: Write the failing tests** — `server/tests/insights-changes.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('category change insights', () => {
  it('compares like-for-like days and names the payee behind a rise', async () => {
    const env = await insightsEnv();
    const food = env.id('Food & Dining');
    const fun = env.id('Entertainment');
    env.tx(500, '2026-09-05', { categoryId: food, payee: 'Swiggy' });
    env.tx(500, '2026-09-10', { categoryId: food, payee: 'Dominos' });
    env.tx(5000, '2026-09-25', { categoryId: food, payee: 'Wedding dinner' });
    for (const day of ['02', '05', '08']) env.tx(500, `2026-10-${day}`, { categoryId: food, payee: 'Swiggy' });
    env.tx(500, '2026-10-09', { categoryId: food, payee: 'Dominos' });
    env.tx(1000, '2026-09-03', { categoryId: fun, payee: 'PVR' });
    env.tx(1000, '2026-10-03', { categoryId: fun, payee: 'PVR' });
    env.tx(300, '2026-10-04', { categoryId: fun, payee: 'Concert' });
    env.tx(300, '2026-10-05', { categoryId: fun, payee: 'Bowling' });
    env.tx(350, '2026-10-06', { categoryId: fun, payee: 'Arcade' });
    env.tx(50, '2026-10-07', { categoryId: fun, payee: 'Games' });

    const r = await env.report();
    expect(pick(r, `category-up:${food}`)[0]).toMatchObject({
      tone: 'warning',
      title: 'Food & Dining up 100% (₹1,000) vs last month',
      detail: '₹2,000 so far vs ₹1,000 by this point last month — mostly Swiggy: 3 payments vs 1.',
      action: { label: 'See transactions', to: `/transactions?categoryId=${food}&from=2026-10-01&to=2026-10-20` },
    });
    expect(pick(r, `category-up:${fun}`)[0].detail).toBe('₹2,000 so far vs ₹1,000 by this point last month.');
  });

  it('ignores small or modest changes and reports new spending', async () => {
    const env = await insightsEnv();
    env.tx(2000, '2026-09-05', { categoryId: env.id('Transport') });
    env.tx(2400, '2026-10-05', { categoryId: env.id('Transport') });
    env.tx(4000, '2026-09-05', { categoryId: env.id('Shopping') });
    env.tx(4900, '2026-10-05', { categoryId: env.id('Shopping') });
    env.tx(800, '2026-10-06', { categoryId: env.id('Health'), payee: 'Apollo' });
    const ups = pick(await env.report(), 'category-up');
    expect(ups.map((i) => i.title)).toEqual(['New spending on Health: ₹800']);
  });

  it('celebrates the biggest drop', async () => {
    const env = await insightsEnv();
    const groceries = env.id('Groceries');
    env.tx(3000, '2026-09-05', { categoryId: groceries });
    env.tx(1000, '2026-10-05', { categoryId: groceries });
    expect(pick(await env.report(), 'category-down')).toEqual([
      expect.objectContaining({ tone: 'good', title: 'Groceries down 67% (₹2,000) vs last month', detail: '₹1,000 so far vs ₹3,000 by this point last month. Nice.' }),
    ]);
  });

  it('shows at most three rises, largest first, and uses full months in the past', async () => {
    const env = await insightsEnv();
    const names = ['Food & Dining', 'Transport', 'Shopping', 'Health'];
    names.forEach((name, i) => {
      env.tx(1000, '2026-08-05', { categoryId: env.id(name) });
      env.tx(2000 + i * 1000, '2026-09-28', { categoryId: env.id(name) });
    });
    const ups = pick(await env.report('2026-09'), 'category-up');
    expect(ups.map((i) => i.title)).toEqual([
      'Health up 400% (₹4,000) vs last month',
      'Shopping up 300% (₹3,000) vs last month',
      'Transport up 200% (₹2,000) vs last month',
    ]);
    expect(ups[0].detail).toBe('₹5,000 vs ₹1,000 last month.');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run tests/insights-changes.test.js` → FAIL (no `category-up` insights).

- [ ] **Step 3: Implement** — add above `DETECTORS`:

```js
function mainPayee(nowRows, beforeRows, delta) {
  const before = groupBy(beforeRows.filter((r) => r.payee), payeeKey);
  let best = null;
  for (const [key, list] of groupBy(nowRows.filter((r) => r.payee), payeeKey)) {
    const prior = before.get(key) ?? [];
    const growth = sum(list) - sum(prior);
    if (!best || growth > best.growth) best = { name: list[list.length - 1].payee, growth, count: list.length, prior: prior.length };
  }
  if (!best || best.growth < delta * REASON_MIN_SHARE) return null;
  return `${best.name}: ${best.count} ${best.count === 1 ? 'payment' : 'payments'} vs ${best.prior}`;
}

function changeInsights(db, userId, ctx, names) {
  const nowBy = groupBy(expenses(db, userId, ctx.start, ctx.upto).filter((r) => r.category_id !== null), (r) => r.category_id);
  const beforeTo = ctx.isCurrent ? ctx.prev.sameDay : ctx.prev.end;
  const beforeBy = groupBy(expenses(db, userId, ctx.prev.start, beforeTo).filter((r) => r.category_id !== null), (r) => r.category_id);

  const changes = [];
  for (const id of new Set([...nowBy.keys(), ...beforeBy.keys()])) {
    const a = sum(nowBy.get(id) ?? []);
    const b = sum(beforeBy.get(id) ?? []);
    const delta = a - b;
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
```

and change `const DETECTORS = [];` to `const DETECTORS = [changeInsights];`.

- [ ] **Step 4: Run to verify it passes** — `cd server && npx vitest run` → PASS (99 tests).

---

### Task 4: Small leaks and unusual spends

**Files:** Modify `server/services/insights.js`; Test `server/tests/insights-leaks.test.js`

**Interfaces:** insight ids `leaks`, `unusual:<transactionId>` (both info).

- [ ] **Step 1: Write the failing tests** — `server/tests/insights-leaks.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('small leaks', () => {
  it('adds up many small purchases and names the usual place', async () => {
    const env = await insightsEnv();
    for (let i = 1; i <= 6; i += 1) env.tx(100, `2026-10-0${i}`, { payee: 'Chaayos' });
    for (const payee of ['Tea stall', 'Tea stall', 'Bus', 'Bus', 'Kirana', 'Kirana']) env.tx(100, '2026-10-10', { payee });
    expect(pick(await env.report(), 'leaks')).toEqual([
      expect.objectContaining({ tone: 'info', title: '12 small purchases under ₹200 added up to ₹1,200', detail: 'Mostly Chaayos (6).' }),
    ]);
  });

  it('stays quiet below ten purchases', async () => {
    const env = await insightsEnv();
    for (let i = 1; i <= 9; i += 1) env.tx(150, `2026-10-0${i}`, { payee: 'Chaayos' });
    expect(pick(await env.report(), 'leaks')).toEqual([]);
  });
});

describe('unusual spends', () => {
  it('flags a purchase far above the category median', async () => {
    const env = await insightsEnv();
    const shopping = env.id('Shopping');
    for (const day of ['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-15', '2026-09-30']) env.tx(2000, day, { categoryId: shopping });
    const croma = env.tx(8000, '2026-10-12T18:00', { categoryId: shopping, payee: 'Croma' });
    expect(pick(await env.report(), 'unusual')).toEqual([
      expect.objectContaining({
        id: `unusual:${croma}`, tone: 'info',
        title: '₹8,000 at Croma was unusually high',
        detail: "It's 4× your usual Shopping spend of ₹2,000 (12 Oct).",
      }),
    ]);
  });

  it('needs at least five earlier purchases to judge', async () => {
    const env = await insightsEnv();
    const shopping = env.id('Shopping');
    for (const day of ['2026-08-01', '2026-08-15', '2026-09-01', '2026-09-15']) env.tx(2000, day, { categoryId: shopping });
    env.tx(8000, '2026-10-12', { categoryId: shopping, payee: 'Croma' });
    expect(pick(await env.report(), 'unusual')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run tests/insights-leaks.test.js` → FAIL.

- [ ] **Step 3: Implement** — add above `DETECTORS`:

```js
function leakInsights(db, userId, ctx) {
  const small = expenses(db, userId, ctx.start, ctx.upto).filter((r) => r.amount < LEAK_MAX_AMOUNT);
  const total = sum(small);
  if (small.length < LEAK_MIN_COUNT || total < LEAK_MIN_TOTAL) return [];
  const top = biggestGroup(small.filter((r) => r.payee), payeeKey);
  return [{
    id: 'leaks', tone: 'info', impact: total,
    title: `${small.length} small purchases under ${fm(LEAK_MAX_AMOUNT)} added up to ${fm(total)}`,
    detail: top && top.length >= LEAK_PAYEE_MIN ? `Mostly ${top[top.length - 1].payee} (${top.length}).` : 'Small amounts add up quietly.',
  }];
}

function unusualInsights(db, userId, ctx, names) {
  const history = db.prepare(
    `SELECT amount FROM transactions WHERE user_id = ? AND type = 'expense' AND category_id = ?
     AND substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) < ?`
  );
  const found = [];
  for (const r of expenses(db, userId, ctx.start, ctx.upto)) {
    if (r.amount < UNUSUAL_MIN_AMOUNT || r.category_id === null) continue;
    const day = r.occurred_at.slice(0, 10);
    const past = history.all(userId, r.category_id, addDays(day, -UNUSUAL_LOOKBACK_DAYS), day).map((h) => h.amount);
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
```

and set `const DETECTORS = [changeInsights, leakInsights, unusualInsights];`.

- [ ] **Step 4: Run to verify it passes** — `cd server && npx vitest run` → PASS (103 tests).

---

### Task 5: Subscriptions you haven't set up

**Files:** Modify `server/services/insights.js`; Test `server/tests/insights-subscriptions.test.js`

**Interfaces:** insight id `subscription:<lower-case payee>`, action `{ label: 'Track it', to: '/recurring?new=1&type=expense&payee=…&amount=…&categoryId=…&accountId=…&frequency=monthly&nextDate=YYYY-MM-DD' }` (Task 8 consumes these query keys).

- [ ] **Step 1: Write the failing tests** — `server/tests/insights-subscriptions.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('subscription insights', () => {
  it('spots a steady monthly payment and offers to track it', async () => {
    const env = await insightsEnv();
    const fun = env.id('Entertainment');
    for (const month of ['07', '08', '09', '10']) env.tx(119, `2026-${month}-03`, { payee: 'Spotify', categoryId: fun });
    const [sub] = pick(await env.report(), 'subscription');
    expect(sub).toMatchObject({ id: 'subscription:spotify', tone: 'info', title: 'Spotify looks like a subscription: ₹119 every month' });
    const params = new URLSearchParams(sub.action.to.split('?')[1]);
    expect(Object.fromEntries(params)).toEqual({
      new: '1', type: 'expense', payee: 'Spotify', amount: '119', categoryId: String(fun),
      accountId: String(env.cash), frequency: 'monthly', nextDate: '2026-11-03',
    });
  });

  it('skips tracked items, changing amounts and repeat purchases', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/recurring', {
      type: 'expense', amount: 649, accountId: env.cash, payee: 'Netflix', frequency: 'monthly', nextDate: '2026-11-05', mode: 'confirm',
    });
    for (const month of ['08', '09', '10']) env.tx(649, `2026-${month}-05`, { payee: 'Netflix' });
    [1000, 1500, 1000].forEach((amount, i) => env.tx(amount, `2026-${['08', '09', '10'][i]}-07`, { payee: 'Gym' }));
    for (const day of ['2026-08-09', '2026-09-09', '2026-10-09', '2026-10-15']) env.tx(300, day, { payee: 'Zomato' });
    expect(pick(await env.report(), 'subscription')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run tests/insights-subscriptions.test.js` → FAIL.

- [ ] **Step 3: Implement** — add above `DETECTORS`:

```js
function subscriptionInsights(db, userId, ctx) {
  const rows = expenses(db, userId, `${shiftMonth(ctx.month, -3)}-01`, ctx.upto).filter((r) => r.payee);
  const tracked = new Set(
    db.prepare("SELECT lower(trim(payee)) AS payee FROM recurring_rules WHERE user_id = ? AND payee != ''").all(userId).map((x) => x.payee)
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
      const params = new URLSearchParams({
        new: '1', type: 'expense', payee: last.payee, amount: String(round(usual)),
        categoryId: last.category_id ?? '', accountId: last.account_id, frequency: 'monthly',
        nextDate: addPeriod(day, 'monthly', Number(day.slice(8, 10))),
      });
      return {
        id: `subscription:${payeeKey(last)}`, tone: 'info', impact: usual,
        title: `${last.payee} looks like a subscription: ${fm(usual)} every month`,
        detail: 'Track it as a repeating item so it logs itself and counts in your forecast.',
        action: { label: 'Track it', to: `/recurring?${params}` },
      };
    });
}
```

and set `const DETECTORS = [changeInsights, leakInsights, unusualInsights, subscriptionInsights];`.

- [ ] **Step 4: Run to verify it passes** — `cd server && npx vitest run` → PASS (105 tests).

---

### Task 6: Habits, savings & income, ordering

**Files:** Modify `server/services/insights.js`; Test `server/tests/insights-habits.test.js`

**Interfaces:** insight ids `weekends`, `late-nights`, `savings`, `add-income` (action `/recurring?new=1&type=income&frequency=monthly&nextDate=<month>-01`, consumed by Task 8).

- [ ] **Step 1: Write the failing tests** — `server/tests/insights-habits.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { insightsEnv, pick } from './helpers.js';

describe('weekend habit', () => {
  it('compares spend per weekend day with weekdays', async () => {
    const env = await insightsEnv();
    env.tx(3000, '2026-10-17T20:00');
    env.tx(3000, '2026-10-10T20:00');
    env.tx(1000, '2026-10-14T20:00');
    const [w] = pick(await env.report(), 'weekends');
    expect(w.tone).toBe('info');
    expect(w.title).toMatch(/^You spend [\d.]+× more per day on weekends$/);
    expect(w.detail).toMatch(/a day on weekends vs .* on weekdays, over the last 90 days\.$/);
  });

  it('ignores repeating items', async () => {
    const env = await insightsEnv();
    await env.api.post('/api/recurring', {
      type: 'expense', amount: 5000, accountId: env.cash, payee: 'Saturday class', frequency: 'weekly', nextDate: '2026-08-01', mode: 'auto',
    });
    env.tx(1000, '2026-10-14T20:00');
    expect(pick(await env.report(), 'weekends')).toEqual([]);
  });
});

describe('late-night habit', () => {
  it('counts timed purchases between 11 pm and 4 am only', async () => {
    const env = await insightsEnv();
    for (const at of ['2026-10-02T23:30', '2026-10-05T01:15', '2026-10-08T02:00']) env.tx(300, at, { payee: 'Swiggy' });
    env.tx(300, '2026-10-09T23:59', { payee: 'Uber' });
    env.tx(300, '2026-10-10', { payee: 'Swiggy' });
    env.tx(300, '2026-10-11T22:59', { payee: 'Swiggy' });
    expect(pick(await env.report(), 'late-nights')).toEqual([
      expect.objectContaining({ tone: 'info', title: '4 late-night purchases this month (₹1,200)', detail: 'Mostly Swiggy, between 11 pm and 4 am.' }),
    ]);
  });

  it('needs at least four', async () => {
    const env = await insightsEnv();
    for (const at of ['2026-10-02T23:30', '2026-10-05T01:15', '2026-10-08T02:00']) env.tx(300, at, { payee: 'Swiggy' });
    expect(pick(await env.report(), 'late-nights')).toEqual([]);
  });
});

describe('savings and income', () => {
  it('asks for income when none is logged, and that is all an empty month says', async () => {
    const env = await insightsEnv();
    expect((await env.report('2026-05')).insights).toEqual([
      expect.objectContaining({
        id: 'add-income', tone: 'info', title: 'How much do you earn?',
        action: { label: 'Add income', to: '/recurring?new=1&type=income&frequency=monthly&nextDate=2026-05-01' },
      }),
    ]);
  });

  it('warns when spending is above income', async () => {
    const env = await insightsEnv();
    env.tx(10000, '2026-10-01', { type: 'income' });
    env.tx(12000, '2026-10-05');
    expect(pick(await env.report(), 'savings')[0]).toMatchObject({
      tone: 'warning', title: 'You spent ₹2,000 more than you earned so far', detail: 'Money in ₹10,000, money out ₹12,000.',
    });
  });

  it('celebrates a good savings rate against recent months', async () => {
    const env = await insightsEnv();
    [['07', 45000], ['08', 40000], ['09', 42500]].forEach(([m, spent]) => {
      env.tx(50000, `2026-${m}-01`, { type: 'income' });
      env.tx(spent, `2026-${m}-10`);
    });
    env.tx(50000, '2026-10-01', { type: 'income' });
    env.tx(38000, '2026-10-10');
    expect(pick(await env.report(), 'savings')[0]).toMatchObject({
      tone: 'good', title: 'You saved 24% of your income so far (₹12,000)', detail: 'Up from 15% on average over the last 3 months.',
    });
  });

  it('gives a neutral note for a low rate in a past month', async () => {
    const env = await insightsEnv();
    env.tx(50000, '2026-09-01', { type: 'income' });
    env.tx(46000, '2026-09-10');
    expect(pick(await env.report('2026-09'), 'savings')[0]).toMatchObject({
      tone: 'info', title: 'You saved 8% of your income (₹4,000)', detail: 'Aim to save 20% or more.',
    });
  });
});

describe('ordering', () => {
  it('puts warnings first, then information, then good news', async () => {
    const env = await insightsEnv();
    env.tx(1000, '2026-10-01', { type: 'income' });
    for (let i = 1; i <= 9; i += 1) env.tx(150, `2026-10-0${i}`, { payee: 'Chaayos' });
    for (let i = 10; i <= 12; i += 1) env.tx(150, `2026-10-${i}`, { payee: 'Chaayos' });
    env.tx(3000, '2026-09-05', { categoryId: env.id('Groceries') });
    const tones = (await env.report()).insights.map((i) => i.tone);
    expect(tones).toContain('warning');
    expect(tones).toContain('info');
    expect(tones).toContain('good');
    const rank = { warning: 0, info: 1, good: 2 };
    expect(tones.map((t) => rank[t])).toEqual([...tones.map((t) => rank[t])].sort((a, b) => a - b));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run tests/insights-habits.test.js` → FAIL.

- [ ] **Step 3: Implement** — add above `DETECTORS`:

```js
const isWeekend = (s) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
};

function habitInsights(db, userId, ctx) {
  const insights = [];

  const from = addDays(ctx.upto, -(HABIT_LOOKBACK_DAYS - 1));
  const rows = expenses(db, userId, from, ctx.upto).filter((r) => r.recurring_id === null);
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

  const late = expenses(db, userId, ctx.start, ctx.upto).filter((r) => {
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

function savingsInsights(db, userId, ctx) {
  const income = sum(txRows(db, userId, 'income', ctx.start, ctx.upto));
  if (income === 0) {
    const params = new URLSearchParams({ new: '1', type: 'income', frequency: 'monthly', nextDate: ctx.start });
    return [{
      id: 'add-income', tone: 'info', impact: Number.MAX_SAFE_INTEGER,
      title: 'How much do you earn?',
      detail: "Add your salary once and it logs itself every month — then you'll see how much you save.",
      action: { label: 'Add income', to: `/recurring?${params}` },
    }];
  }

  const expense = sum(expenses(db, userId, ctx.start, ctx.upto));
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
      const monthIncome = sum(txRows(db, userId, 'income', `${m}-01`, monthEnd(m)));
      return monthIncome > 0 ? (monthIncome - sum(expenses(db, userId, `${m}-01`, monthEnd(m)))) / monthIncome : null;
    })
    .filter((rate) => rate !== null);
  const pct = Math.round((net / income) * 100);
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
```

and set `const DETECTORS = [changeInsights, leakInsights, unusualInsights, subscriptionInsights, habitInsights, savingsInsights];`.

- [ ] **Step 4: Run to verify it passes** — `cd server && npx vitest run` → PASS (114 tests).

---

### Task 7: Insights page, InsightCard, navigation

**Files:**
- Create: `client/src/components/InsightCard.jsx`, `client/src/pages/Insights.jsx`
- Modify: `client/src/api.js`, `client/src/components/Nav.jsx`, `client/src/App.jsx`, `client/src/App.css`

**Interfaces:** Consumes `GET /api/insights`. Produces `InsightCard({ insight })`, `api.getInsights(token, month)`.

- [ ] **Step 1: API client** — in `client/src/api.js`, after `getSummary` add:

```js
  getInsights: (token, month) => request(`/insights${query({ month })}`, { token }),
```

- [ ] **Step 2: InsightCard** — `client/src/components/InsightCard.jsx`:

```jsx
import { Link } from 'react-router-dom';

const ICONS = { warning: '!', info: 'i', good: '✓' };

export function InsightCard({ insight }) {
  return (
    <div className={`insight ${insight.tone}`}>
      <span className="insight-icon" aria-hidden="true">{ICONS[insight.tone]}</span>
      <div className="grow">
        <strong>{insight.title}</strong>
        <p className="hint">{insight.detail}</p>
      </div>
      {insight.action && <Link className="insight-action" to={insight.action.to}>{insight.action.label}</Link>}
    </div>
  );
}
```

- [ ] **Step 3: Insights page** — `client/src/pages/Insights.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { InsightCard } from '../components/InsightCard.jsx';
import { formatMoney, todayStr } from '../format.js';

const LIMIT_LABELS = { budget: 'your budget', 'category-budgets': 'your category budgets', income: 'your income' };

const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};

function Change({ now, before, goodWhenUp, short }) {
  if (!before) return null;
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  if (pct === 0) return short ? null : <span className="delta">Same as last month</span>;
  const good = pct > 0 === goodWhenUp;
  return (
    <span className={`delta ${good ? 'good' : 'bad'}`}>
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%{short ? '' : ' vs last month'}
    </span>
  );
}

export function Insights() {
  const { token } = useAuth();
  const { version } = useQuickAdd();
  const thisMonth = todayStr().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [report, setReport] = useState(null);
  const [categories, setCategories] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getCategories(token).then(setCategories).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    setReport(null);
    api.getInsights(token, month).then(setReport).catch((e) => setError(e.message));
  }, [token, month, version]);

  const categoryName = (id) => categories.find((c) => c.id === id)?.name ?? 'Uncategorised';

  return (
    <div className="page">
      <div className="page-header">
        <h1>Insights</h1>
        <div className="month-switch">
          <button className="secondary" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
          <strong>{monthLabel(month)}</strong>
          <button className="secondary" aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!report ? (
        <p className="hint">Loading…</p>
      ) : (
        <ReportBody report={report} categoryName={categoryName} />
      )}
    </div>
  );
}

function ReportBody({ report, categoryName }) {
  const { totals, pace, insights } = report;
  const hasData = totals.income > 0 || totals.expense > 0;
  return (
    <>
      <div className="stats">
        <div className="stat">
          <span>Money in</span>
          <strong className="amount income">{formatMoney(totals.income)}</strong>
          <Change now={totals.income} before={totals.previous.income} goodWhenUp />
        </div>
        <div className="stat">
          <span>Money out</span>
          <strong>{formatMoney(totals.expense)}</strong>
          <Change now={totals.expense} before={totals.previous.expense} goodWhenUp={false} />
        </div>
        <div className="stat">
          <span>{totals.net >= 0 ? 'Saved' : 'Overspent'}</span>
          <strong className={totals.net < 0 ? 'amount negative' : ''}>{formatMoney(Math.abs(totals.net))}</strong>
          {totals.income > 0 && <small>{Math.round((totals.net / totals.income) * 100)}% of what came in</small>}
        </div>
      </div>

      {pace && (
        <div className="card">
          <h2>This month's pace</h2>
          <p>
            Spent so far <strong>{formatMoney(pace.spentSoFar)}</strong> · heading for <strong>{formatMoney(pace.forecast)}</strong>
            {pace.limit !== null && <> · limit {formatMoney(pace.limit)} ({LIMIT_LABELS[pace.limitSource]})</>}
          </p>
          {pace.safePerDay !== null && (
            <p className="hint">
              {pace.safePerDay > 0
                ? `You can spend about ${formatMoney(pace.safePerDay)} a day for the next ${pace.daysLeft} days.`
                : "There's no room left in this month's limit."}
            </p>
          )}
        </div>
      )}

      <h2>What stands out</h2>
      {!hasData && <div className="empty">Not enough data for this month yet — insights appear as you log transactions.</div>}
      {insights.map((insight) => <InsightCard key={insight.id} insight={insight} />)}

      {hasData && report.categories.length > 0 && (
        <div className="card">
          <h2>Categories</h2>
          <table className="report">
            <thead>
              <tr><th>Category</th><th>This month</th><th>Last month</th><th>3-month avg</th></tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <tr key={c.categoryId ?? 'none'}>
                  <td>{categoryName(c.categoryId)}</td>
                  <td>{formatMoney(c.total)} <Change now={c.total} before={c.previous} goodWhenUp={false} short /></td>
                  <td>{formatMoney(c.previous)}</td>
                  <td>{formatMoney(c.average)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasData && report.topPayees.length > 0 && (
        <div className="card">
          <h2>Top payees</h2>
          <ul className="list">
            {report.topPayees.map((p) => (
              <li key={p.payee}>
                <span className="grow">{p.payee}</span>
                <span className="hint">{p.count} {p.count === 1 ? 'payment' : 'payments'}</span>
                <span className="amount">{formatMoney(p.total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Navigation, route, styles**

In `client/src/components/Nav.jsx`, after the Transactions link add `<NavLink to="/insights">Insights</NavLink>`.

In `client/src/App.jsx` add `import { Insights } from './pages/Insights.jsx';` and after the `/transactions` route add `<Route path="/insights" element={guard(<Insights />)} />`.

Append to `client/src/App.css`:

```css
/* Insights */
.insight { display: flex; align-items: flex-start; gap: .75rem; padding: .75rem 1rem; margin-bottom: .6rem; background: var(--card); border: 1px solid var(--border); border-left: 4px solid var(--primary); border-radius: var(--radius); }
.insight.warning { border-left-color: #e8a317; }
.insight.good { border-left-color: var(--income); }
.insight p { margin: .2rem 0 0; }
.insight-icon { flex: none; display: grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--primary); color: #fff; font-size: .8rem; font-weight: 700; }
.insight.warning .insight-icon { background: #e8a317; }
.insight.good .insight-icon { background: var(--income); }
.insight-action { align-self: center; white-space: nowrap; color: var(--primary); font-weight: 600; text-decoration: none; }
.month-switch { display: flex; align-items: center; gap: .5rem; }
.delta { display: block; font-size: .8rem; color: var(--muted); }
td .delta { display: inline; }
.delta.good { color: var(--income); }
.delta.bad { color: var(--danger); }
table.report { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
table.report th, table.report td { padding: .45rem .5rem; text-align: right; border-bottom: 1px solid var(--border); }
table.report th:first-child, table.report td:first-child { text-align: left; }
table.report th { font-size: .8rem; color: var(--muted); font-weight: 500; }
```

- [ ] **Step 5: Build** — `cd client && npx vite build` → `✓ built`, no errors.

---

### Task 8: Home insights card, income strip on Budgets, deep links, final verification

**Files:** Modify `client/src/pages/Dashboard.jsx`, `client/src/pages/Budgets.jsx`, `client/src/pages/Transactions.jsx`, `client/src/pages/Recurring.jsx`, `README.md`

**Interfaces:** Consumes `InsightCard`, `api.getInsights`, action URLs from Tasks 3, 5, 6.

- [ ] **Step 1: Home** — in `client/src/pages/Dashboard.jsx`:
  - import `InsightCard` from `'../components/InsightCard.jsx'`;
  - add `api.getInsights(token, current.from.slice(0, 7))` as the last entry of the `Promise.all`, receive it as `report`, and store `insights: report.insights` in `setData`;
  - destructure `insights` from `data`;
  - in the welcome (no transactions) branch, after the `.empty` block, add `{insights.filter((i) => i.id === 'add-income').map((i) => <InsightCard key={i.id} insight={i} />)}`;
  - in the main view, directly after the over-budget banners, add:

```jsx
      {insights.length > 0 && (
        <div className="card">
          <div className="row spread">
            <h2>Insights</h2>
            <Link to="/insights">See all insights →</Link>
          </div>
          {insights.slice(0, 3).map((insight) => <InsightCard key={insight.id} insight={insight} />)}
        </div>
      )}
```

- [ ] **Step 2: Budgets income strip** — in `client/src/pages/Budgets.jsx`:
  - import `Link` from `react-router-dom`;
  - add state `const [income, setIncome] = useState(null);`
  - in `load`, also fetch the month's summary:

```js
  const load = useCallback(() => {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    api.getBudgetStatus(token, month).then(setStatus).catch((e) => setError(e.message));
    api.getSummary(token, `${month}-01`, `${month}-${lastDay}`).then((s) => setIncome(s.income)).catch((e) => setError(e.message));
  }, [token, month]);
```

  - before the `return`, compute what is budgeted (the overall budget if set, otherwise the sum of category budgets, last entry per category winning):

```js
  const latest = new Map(status.map((b) => [b.category_id, b.amount]));
  const budgeted = latest.has(null) ? latest.get(null) : [...latest.values()].reduce((a, b) => a + b, 0);
  const unplanned = (income ?? 0) - budgeted;
```

  - insert directly after the `{error && …}` line:

```jsx
      {income !== null && (
        <div className="card row spread">
          {income > 0 ? (
            <>
              <span>Money in this month <strong>{formatMoney(income)}</strong></span>
              <span>Budgeted <strong>{formatMoney(budgeted)}</strong></span>
              <span className={unplanned < 0 ? 'amount negative' : ''}>
                {unplanned >= 0 ? <>Not budgeted <strong>{formatMoney(unplanned)}</strong></> : `Budgeted ${formatMoney(-unplanned)} more than you earn`}
              </span>
            </>
          ) : (
            <>
              <span>Add your income to see how your budgets compare.</span>
              <Link to={`/recurring?new=1&type=income&frequency=monthly&nextDate=${month}-01`}>Add income</Link>
            </>
          )}
        </div>
      )}
```

- [ ] **Step 3: Transactions reads filters from the URL** — in `client/src/pages/Transactions.jsx` import `useSearchParams` from `react-router-dom`, and replace `const [filters, setFilters] = useState(NO_FILTERS);` with:

```js
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    ...NO_FILTERS,
    ...Object.fromEntries([...searchParams].filter(([key]) => key in NO_FILTERS)),
  }));
```

- [ ] **Step 4: Recurring opens a pre-filled form from the URL** — in `client/src/pages/Recurring.jsx` import `useSearchParams` from `react-router-dom`, add `const [searchParams, setSearchParams] = useSearchParams();` with the other hooks, and add after the existing load effect:

```js
  useEffect(() => {
    if (searchParams.get('new') !== '1' || !accounts.length) return;
    const params = Object.fromEntries(searchParams);
    const prefill = Object.fromEntries(
      ['type', 'payee', 'amount', 'categoryId', 'accountId', 'frequency', 'nextDate'].filter((k) => params[k]).map((k) => [k, params[k]])
    );
    if (prefill.accountId) prefill.accountId = Number(prefill.accountId);
    if (prefill.categoryId) prefill.categoryId = Number(prefill.categoryId);
    if (prefill.type === 'income' && !prefill.categoryId) {
      prefill.categoryId = categories.find((c) => c.kind === 'income' && c.name === 'Salary')?.id ?? '';
    }
    setForm({ ...blank(accounts.find((a) => !a.archived)?.id), ...prefill });
    setSearchParams({}, { replace: true });
  }, [searchParams, accounts, categories, setSearchParams]);
```

- [ ] **Step 5: README** — in `README.md` Features list, after the **Home** bullet add:

```markdown
- **Insights** (Home + Insights page): pace and safe-to-spend per day, what changed vs last month and why, small leaks, unusual spends, untracked subscriptions, weekend and late-night habits, savings rate — all computed from your own data, no AI service.
```

- [ ] **Step 6: Full verification**
  - `cd server && npx vitest run` → PASS (114 tests).
  - `cd client && npx vite build` → `✓ built`.
  - Live API smoke on a scratch copy of `server/data.db` (never the real file): start `createApp` on port 4100 with today's clock, register a user, add a few expenses/income, `GET /api/insights` → valid report with ordered insights.
  - Hand the browser click-through to the user (no browser tool in this session): Insights page month switcher, Home card, "Track it" opening a pre-filled repeating item, "See transactions" opening a filtered list, Budgets income strip and its "Add income" link.
  - Do **not** commit.
