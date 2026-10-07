# Part 1 — Fast Logging & Money In/Out — Design

Status: approved (simplified per "never over-engineer" guidance) · Date: 2026-10-07 · Roadmap: Part 1 of 4 (1 Logging & income → 2 Insights → 3 Bank import (Excel/CSV) → 4 Goals & backup)

## 1. Goal

Turn the app from "a list of expenses" into a complete record of where money comes from and goes, cheap enough to log that people keep doing it.

Success criteria:
- A typical expense (₹250, Swiggy, UPI) is logged with **amount + payee + Save** — category, account and time fill themselves.
- Income is tracked, so net (income − expense) is known for any period.
- Each account (Cash, bank/UPI, credit card) shows a correct running balance; moving money between own accounts is not counted as spending.
- Fixed money movements (rent, salary, SIP, Netflix) appear without manual entry; variable bills (electricity) prompt for confirmation.
- Existing data survives the upgrade unchanged in meaning.

Non-goals (later parts): insights engine (Part 2), statement import (Part 3), goals/backup (Part 4), visual polish.

## 2. Users' mental model (drives the design)

- "I paid **someone**, from **some account**, for **something**." → payee, account, category.
- People remember payees ("Swiggy"), not categories. Categorisation should follow from the payee.
- Credit-card bill payment is not spending — the spending happened when the card was swiped. → transfers.
- "Goa trip" spans Food, Travel, Shopping. → tags, orthogonal to categories.

## 3. Data model

All tables scoped by `user_id`. Amounts are positive `REAL` rupees; direction comes from `type`.

```
accounts(id, user_id, name, type, opening_balance REAL DEFAULT 0, archived INTEGER DEFAULT 0, created_at)
  type ∈ cash | bank | credit_card | wallet

categories(id, user_id, name, color, kind)            -- kind added: expense | income (default expense)

transactions(id, user_id, type, amount, occurred_at,
             account_id NOT NULL, to_account_id NULL,
             category_id NULL, payee TEXT, note TEXT,
             recurring_id NULL, created_at)
  type ∈ expense | income | transfer
  occurred_at: 'YYYY-MM-DDTHH:MM' (local time, as entered)
  transfer: account_id = from, to_account_id = to, category_id NULL

tags(id, user_id, name)                               -- UNIQUE(user_id, name), stored lower-case
transaction_tags(transaction_id, tag_id)              -- PK(transaction_id, tag_id)

category_rules(id, user_id, match_text, category_id, created_at)
  -- case-insensitive whole-word match against payee, then note ("ola" matches "Ola Cabs", not "Motorola")

recurring_rules(id, user_id, type, amount, account_id, to_account_id, category_id,
                payee, note, frequency, anchor_day, start_date, end_date NULL,
                next_date, mode, active, created_at)
  frequency ∈ weekly | monthly | quarterly | yearly
  mode ∈ auto | confirm
  anchor_day = day-of-month of start_date (keeps "31st" sticky across short months)

budgets   -- unchanged schema; now computed from transactions of type expense
```

Account balance = opening_balance + Σincome − Σexpense − Σtransfers out + Σtransfers in.
For a credit card the balance is negative when money is owed (opening balance can be entered negative).

## 4. Migration of existing data

Schema version tracked with `PRAGMA user_version` (current DBs = 0/1, target = 2). Runs once at startup inside a single DB transaction:
1. Create new tables; add `categories.kind` (existing rows → `expense`).
2. For each user that has expenses, create an account **"Cash"** (type cash).
3. Copy `expenses` → `transactions`: type `expense`, `description` → `note`, `date` → `occurred_at` (date-only values stay date-only — no time is known), same category, account = that user's Cash.
4. Drop `expenses`.

A failed migration rolls back and the server refuses to start (data never half-migrated).

## 5. New-user setup

On register, seed (all editable/deletable):
- Account: **Cash**.
- Expense categories: Food & Dining, Groceries, Transport, Shopping, Bills & Utilities, Rent, Entertainment, Health, Education, Travel, Personal Care, Other.
- Income categories: Salary, Freelance, Interest, Refunds, Other Income.
- Starter rules for common Indian merchants: swiggy/zomato → Food & Dining; blinkit/zepto/bigbasket/instamart → Groceries; uber/ola/rapido/irctc → Transport; amazon/flipkart/myntra/ajio → Shopping; netflix/hotstar/spotify/prime video/bookmyshow → Entertainment; airtel/jio/bescom/electricity → Bills & Utilities; apollo/pharmeasy/1mg → Health.

## 6. Behaviour

### 6.1 Auto-categorisation (`services/categorize.js`)
`suggestCategory(db, userId, { payee, note, type })` returns a category id or null:
1. Rule match — longest `match_text` found as whole word(s) in payee, else in note (case-insensitive); only categories whose `kind` matches the transaction type.
2. Payee history — the category most recently used with the same payee (case-insensitive).
3. null.

On create: if `categoryId` is omitted (not explicitly null) and type ≠ transfer, the server applies `suggestCategory`. The same function is reused by Part 3 import.
Rule learning (client): when a user changes the category of a transaction whose payee has no rule, offer "Always put '<payee>' in <category>?" → `POST /rules`.

### 6.2 Quick-add defaults
`GET /api/transactions/defaults` → `{ accountId }` of the most recently used non-archived account (fallback: first account).
`GET /api/transactions/payees?q=&type=` → `{ payees: string[], suggestedCategoryId }` — distinct payees of that type, most frequent first, max 10, plus the category `suggestCategory` picks for the typed text (so the form can show it before saving).

### 6.3 Transfers
Require `account_id ≠ to_account_id`, both owned and not archived. Never counted as income or expense in summaries, budgets, charts, or export totals.

### 6.4 Tags
Transactions accept `tags: string[]`; names are trimmed, lower-cased, de-duplicated, created on the fly. `GET /api/transactions/tags` lists tags with usage counts. Filter transactions by tag.

### 6.5 Recurring (`services/recurring.js`)
Pure date maths: `nextOccurrence(rule, fromDate)` honouring frequency and anchor_day (monthly on 31st → Feb 28/29, then back to 31st), end_date.
Materialisation is **lazy**: before any request that reads transactions or totals (transactions, summary, accounts, budgets, export, recurring), `materializeDue(db, userId, today)` posts every `auto` occurrence with `next_date ≤ today` (catching up multiple missed periods), linking `recurring_id`, then advances `next_date`. Runs in one DB transaction; idempotent. No cron, works even if the server was off.
`confirm` rules don't post; their due occurrences are returned as **pending**. User can **Confirm** (optionally editing amount/date) → posts transaction and advances, or **Skip** → advances only.
`GET /api/recurring/upcoming?days=7` → projected occurrences (auto and confirm) in the window.
Editing a rule affects future occurrences only.

### 6.6 Accounts
Create/edit/archive. Delete allowed only when the account has no transactions or recurring rules (409 otherwise, message suggests archiving). Archived accounts are hidden from pickers but keep history and balance.

### 6.7 Summary (for dashboard, extended in Part 2)
`GET /api/summary?from&to` → `{ income, expense, net, byCategory: [{categoryId, total}], accounts: [{id, name, type, balance}] }`.

## 7. API (all under `/api`, JWT required except auth)

| Resource | Endpoints |
|---|---|
| transactions | `GET /transactions?from&to&type&accountId&categoryId&tag&q&limit=100&offset=0` → `{ items, total }` (items include `tags: []`); `POST`, `PUT /:id`, `DELETE /:id`; `GET /transactions/defaults`, `/transactions/payees?q=`, `/transactions/tags` |
| accounts | `GET` (with balance), `POST`, `PUT /:id`, `DELETE /:id` |
| categories | existing + `kind` |
| rules | `GET`, `POST`, `DELETE /:id` |
| recurring | `GET` (rules + pending), `POST`, `PUT /:id`, `DELETE /:id`, `POST /:id/confirm`, `POST /:id/skip`, `GET /upcoming?days=` |
| summary | `GET /summary?from&to` |
| budgets | unchanged API; status uses expense transactions |
| export | CSV columns: occurred_at, type, amount, account, to_account, category, payee, note, tags |

`/api/expenses` is removed (only our client uses it).

Validation (400 with message): amount positive finite ≤ 1,00,00,00,000; `occurred_at` matches `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`; type valid; category kind matches type.
**Ownership (security fix):** every referenced `account_id`, `to_account_id`, `category_id`, `recurring_id` must belong to the requesting user — 400 otherwise. (Today, expenses accept any user's category id.)

## 8. Frontend

### UX principles (apply to every screen)
- **Navigation, in order of use:** Home · Transactions · Budgets · Recurring · Accounts · Categories. Six items, no nested menus.
- **"+ Add" is always one tap away** (in the nav bar), opening the same quick-add form from any page.
- **Progressive disclosure:** the quick-add form shows only amount, payee, category, account. Date/time, tags and note sit behind "More details" (pre-filled, so most people never open it).
- **Colour carries meaning, consistently:** income green "+₹", expense default "−₹", transfer neutral "⇄"; over-budget red.
- **Every empty state tells you what to do next** (e.g. "No recurring items yet — add your rent or salary so it logs itself").
- **Destructive actions confirm**; archive is offered before delete.
- Plain words over jargon in the UI ("Repeats monthly, adds itself" rather than "mode: auto").

### Screens
- **Transactions** (replaces Expenses): type toggle Expense/Income/Transfer; amount; payee with autocomplete (choosing one fills category); category (pre-filled, overridable); account (pre-filled with last used) / to-account for transfers; date-time (now); tags (comma-separated); note. Rule-learning prompt after a category correction. Filters for every query param above; "Load more" pagination. Income shown as +₹ and expense −₹.
- **Accounts**: list with balances; add/edit/archive/delete.
- **Recurring**: pending confirmations (Confirm/Skip, editable amount) at top; upcoming 7 days; rules list with add/edit/pause/delete.
- **Categories**: kind shown and selectable; rules section (list/add/delete).
- **Dashboard**: this month's income, expense, net; account balances; pending confirmations count; upcoming 7 days. Existing charts switch to expense transactions.
- **Budgets**: unchanged UI.

## 9. Code structure

```
server/
  db.js                 -- open DB + run migrations
  migrations.js         -- versioned migrations (v2 = this spec)
  seed.js               -- default accounts/categories/rules for a new user
  validate.js           -- shared validation + ownership checks
  services/categorize.js, services/recurring.js
  routes/transactions.js (incl. defaults, payees, tags), accounts.js (incl. balances), rules.js, recurring.js, summary.js
         (auth, categories, budgets, export updated; expenses.js removed)
client/src/pages/Transactions.jsx, Accounts.jsx, Recurring.jsx (+ updates to Dashboard, Categories, Budgets)
client/src/components/QuickAdd.jsx  -- the one add/edit form, opened from the nav "+ Add"
```

## 10. Testing

Backend (vitest + supertest, in-memory DB), written test-first:
- Migration: a v0 DB with users/categories/expenses migrates to v2 with identical amounts, categories, times and a Cash account; rerunning is a no-op.
- Seeding on register.
- Transactions: CRUD, validation, ownership rejection, filters, pagination, tags.
- Transfers excluded from summary/budgets; balances correct across income/expense/transfer.
- categorize: rule beats history, longest match wins, kind respected, history fallback.
- recurring: monthly anchor on 31st, quarterly, yearly on Feb 29, end_date, multi-period catch-up, idempotence, confirm/skip.
- Export columns.

Frontend: production build passes; manual click-through by the user (no browser automation available in this environment).

## 11. Decisions made (flag if you disagree)

1. Old "description" becomes **note**; payee starts empty for migrated rows.
2. Everything migrated lands in a "Cash" account (rename it afterwards if needed).
3. Seeded categories and merchant rules as listed in §5.
4. Recurring rules choose **auto** or **confirm** individually.
5. Lists are paginated (100 per page) to stay fast once imports arrive in Part 3.
