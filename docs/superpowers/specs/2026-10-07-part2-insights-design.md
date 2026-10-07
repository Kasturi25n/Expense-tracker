# Part 2 — Insights — Design

Status: draft for review · Date: 2026-10-07 · Roadmap: Part 2 of 4 (1 Logging & income ✓ → **2 Insights** → 3 Bank import (Excel/CSV) → 4 Goals & backup)

## 1. Goal

Answer the questions people actually ask about their money, in plain sentences with real numbers, without them building a single chart:

- **Mid-month:** "Can I afford this? How much can I still spend?"
- **End of month:** "Where did my money go? Did I save? Is it worse than last month — and why?"
- **Over time:** "What's quietly eating my money?" (small leaks, subscriptions, weekend habits)
- **Earning:** "How much do I earn vs spend?" — the app must ask for income when it has none.

Success criteria:
- Opening Home on any day of the month shows at most 3 insight cards, most urgent first, each with a number and (where useful) a one-tap action.
- An **Insights** page shows a month-by-month report and every insight for that month.
- Every insight is computed from the user's own data on our server — no AI service, no paid API — and is explainable ("mostly Swiggy: 12 orders vs 5").
- An insight only appears when it is meaningful (thresholds below); an empty month shows a friendly "not enough data yet" instead of noise.

Non-goals: notifications/emails, ML predictions, user-configurable thresholds, dismissing individual insights.

## 2. The insights (rules, thresholds, wording)

All amounts are expenses unless stated; transfers never count. "Month M" is the month being viewed. For the **current** month, "so far" means day 1 → today (`today` is the server's local date, as in Part 1). Thresholds live as named constants at the top of `services/insights.js`.

### 2.1 Pace & safe-to-spend (current month only, from day 3)
- `spentSoFar` = expenses this month up to today; `variableSoFar` = same minus those posted by recurring items.
- `upcomingFixed` = expense occurrences of active recurring items due after today and within this month.
- **Forecast** = `spentSoFar + variableSoFar ÷ daysElapsed × daysRemaining + upcomingFixed`.
- **Limit** = the month's overall budget if set; else the sum of category budgets if any; else this month's income (logged + upcoming recurring income) if > 0; else no limit.
- With a limit: **safe per day** = (limit − spentSoFar − upcomingFixed) ÷ days left including today.
  - Forecast > limit → ⚠ "At this pace you'll spend ₹42,300 this month — ₹7,300 over your ₹35,000 budget. Try to keep to ₹610 a day for the next 12 days."
  - Otherwise → ✓ "On track: about ₹31,800 this month. You can spend ₹890 a day for the next 12 days."
  - Safe per day ≤ 0 → ⚠ "You've used this month's ₹35,000 budget."
- Without a limit → ℹ "At this pace you'll spend about ₹31,800 this month." (+ action: "Set a budget")
- **Per-category budgets:** same forecast per budgeted category not already over → ⚠ "Food & Dining is heading for ₹6,200 against its ₹5,000 budget."

### 2.2 What changed vs last month (with the reason)
- Compare each expense category in M with the previous month. For the current month compare like-for-like: days 1→today of both months.
- Show when the change is **≥ 25 % and ≥ ₹500** (or new spending ≥ ₹500 in a category that had none).
- **Reason:** the payee whose spending grew the most in that category, when it explains ≥ 40 % of the change: "mostly Swiggy: 12 orders vs 5".
- Up to **3 increases** (⚠) and the **1 largest decrease** (✓ "Shopping down 45% (₹3,100) — nice.").
- Action: "See transactions" → Transactions filtered to that category and month.

### 2.3 Small leaks
- Expenses under **₹200** in M: if **≥ 10** of them and they total **≥ ₹1,000** → ℹ "41 small purchases under ₹200 added up to ₹3,140 — mostly Chaayos (14)." (payee named when it has ≥ 5 of them).

### 2.4 Unusual spends
- A categorised expense in M of **≥ ₹1,000** that is **≥ 3×** the median of that category over the 90 days before it (needing ≥ 5 earlier expenses) → ℹ "₹8,000 at Croma on 12 Oct is 4× your usual Shopping spend (₹2,000)." Up to 2, biggest multiple first.

### 2.5 Subscriptions you haven't set up
- A payee with exactly one expense in each of **≥ 3 of the 4 months** ending with M, all within **±10 %** of their median, none posted by a recurring item, and no recurring item with that payee → ℹ "Spotify looks like a subscription: ₹119 every month." Action: "Track it" → opens a new repeating item pre-filled with payee, amount, category and account. Up to 3.

### 2.6 Habits
- **Weekends** (90 days ending with M, recurring postings excluded): average spend per weekend day ≥ **1.5×** per weekday and weekend total ≥ ₹2,000 → ℹ "You spend 1.8× more per day on weekends (₹1,240 vs ₹690)."
- **Late nights:** ≥ **4** expenses in M timed 23:00–03:59 → ℹ "6 late-night purchases this month (₹2,100), mostly Swiggy." (only entries with a time count)

### 2.7 Savings & income
- **No income logged in M** → ℹ "How much do you earn? Add your salary once and it logs itself every month." Action: "Add income" → new repeating item pre-filled as monthly Income on the 1st of the current month. Not shown when an active income repeating item already exists.
- Otherwise savings rate = (income − expenses) ÷ income, compared with the average of up to 3 previous months that had income:
  - negative → ⚠ "You spent ₹4,200 more than you earned this month."
  - ≥ 20 % or ≥ 5 points above average → ✓ "You saved 24% of your income (₹19,200) — up from 15%."
  - else → ℹ "You saved 9% of your income (₹7,200)."
- For the current month the wording says "so far".

### Ordering
⚠ warnings first, then ℹ, then ✓; within a group, larger rupee impact first. Home shows the first 3.

## 3. Monthly report (Insights page)

For month M (← / → month switcher, defaults to the current month):
1. **Headline:** Money in, Money out, Saved (+ rate), each with change vs previous month.
2. **Pace card** (current month only, §2.1).
3. **All insights** for M as cards.
4. **Categories table:** this month, last month, 3-month average, with ▲/▼.
5. **Top 5 payees:** total and number of payments.
Empty month → "Not enough data for this month yet — insights appear as you log transactions."

## 4. Income next to budgets
The Budgets page shows a strip above the list: "Money in this month ₹80,000 · Budgeted ₹55,000 · Not budgeted ₹25,000". No income → "Add your income to see how your budgets compare" with the same "Add income" action. (This is the change proposed after Part 1.)

## 5. API

`GET /api/insights?month=YYYY-MM` (auth + recurring materialisation, like other reads) →

```json
{
  "month": "2026-10", "isCurrentMonth": true,
  "totals": { "income": 80000, "expense": 41230, "net": 38770, "expectedIncome": 80000,
              "previous": { "income": 80000, "expense": 38900, "net": 41100 } },
  "pace": { "spentSoFar": 21000, "forecast": 31800, "limit": 35000, "limitSource": "budget",
            "safePerDay": 890, "daysLeft": 25 } ,
  "insights": [ { "id": "category-up:12", "tone": "warning", "title": "…", "detail": "…",
                  "action": { "label": "See transactions", "to": "/transactions?categoryId=12&from=2026-10-01&to=2026-10-31" } } ],
  "categories": [ { "categoryId": 12, "total": 6200, "previous": 4100, "average": 4500 } ],
  "topPayees": [ { "payee": "Swiggy", "total": 3400, "count": 12 } ]
}
```
`pace` is `null` for past months and before day 3. `limitSource` ∈ `budget | category-budgets | income | null`. Invalid `month` → 400.

## 6. Frontend
- **Navigation:** Home · Transactions · **Insights** · Budgets · Recurring · Accounts · Categories (7 items; Insights sits next to the data it explains).
- **Home:** replace nothing; add an "Insights" card above the charts with the top 3 insight cards and "See all insights →".
- **Insights page:** the report in §3.
- **InsightCard** component shared by Home and Insights: tone colour stripe (⚠ amber/red, ℹ blue, ✓ green), title, one-line detail, optional action button.
- **Deep links** so actions work: Transactions reads its initial filters from the URL (`categoryId, from, to, q`); Recurring opens a pre-filled new-item form from `?new=1&type=&payee=&amount=&categoryId=&accountId=&frequency=&nextDate=`.
- **Budgets:** income strip (§4).

## 7. Code structure
```
server/services/insights.js   -- thresholds + one small function per insight + buildMonthReport()
server/routes/insights.js     -- GET /api/insights
client/src/pages/Insights.jsx, client/src/components/InsightCard.jsx
(+ edits: app.js, api.js, App.jsx, Nav.jsx, Dashboard.jsx, Budgets.jsx, Transactions.jsx, Recurring.jsx)
```
Each insight function takes `(db, userId, monthCtx)` and returns zero or more insight objects, so each is tested on its own.

## 8. Testing
Backend (vitest + supertest, fixed clock, fixtures via `addTx`), written test-first, one describe per insight:
- pace: forecast arithmetic, each limit source, before day 3 → null, past month → null, over-limit wording, used-up limit, per-category budget warning.
- changes: like-for-like comparison mid-month, both thresholds, new-category spending, reason payee shown only when ≥ 40 %, caps (3 up, 1 down).
- leaks, unusual, subscriptions (incl. "already a recurring item" exclusion and ±10 %), weekends (recurring excluded), late nights (date-only ignored), savings (no income, negative, good, neutral).
- endpoint: shape, ordering, invalid month, other users' data never included, empty month.
Frontend: build + manual click-through on localhost by the user.

## 9. Decisions to check
1. Thresholds in §2 (₹500/25 %, ₹200 leaks, 3× unusual, ±10 % subscriptions, 1.5× weekends, 23:00–04:00 late night) — sensible defaults for Indian monthly budgets; easy to tune later.
2. A 7th navigation item, **Insights**.
3. The "How much do you earn?" prompt and the income strip on Budgets are included here.
4. No commits until you verify on localhost (your standing rule).
