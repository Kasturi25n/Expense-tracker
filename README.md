# Expense Tracker

Full-featured, multi-user expense tracker. React frontend, Express + SQLite (Node's built-in `node:sqlite`) backend, JWT auth.

## Setup

```bash
npm install
npm --prefix server install
npm --prefix client install
```

## Run

```bash
npm run dev
```

This starts the API on `http://localhost:4000` and the frontend on `http://localhost:5173`.

Or run them separately:

```bash
npm --prefix server run dev   # API on :4000
npm --prefix client run dev   # UI on :5173
```

## Test

```bash
npm test
```

Runs the backend test suite (vitest + supertest) covering migrations, auth, accounts, transactions, rules, recurring items, budgets, summary, insights, statement import, goals, backup/restore and CSV export.

## Features

- **Quick Add** from any page: amount + payee + Save. Category, account and time fill themselves in.
- **Income, expenses and transfers** across accounts (cash, bank/UPI, credit card, wallet) with running balances. Card bill payments are transfers, so they're not double-counted.
- **Auto-categorise rules** (starter rules for Swiggy, Zomato, Uber, Amazon, Netflix, Jio…), plus learning from your past payees.
- **Recurring items** that add themselves (rent, salary, SIP) or wait for you to confirm the amount (electricity).
- **Tags** like `goa-trip`, filters and search, CSV export.
- **Bank statement import** (Excel or CSV, no PDF): pick the file, check the column mapping the app guessed, review the rows and import. Duplicates are flagged, transfers between your own accounts can be marked, the format is remembered for next time, and any import can be undone.
- **Budgets** per category or overall, with progress bars and over-budget warnings.
- **Savings goals**: "Goa trip, ₹40,000 by March" tells you how much to put aside each month and whether you're on track. Goal money is a separate tally and never changes account balances.
- **Home** shows this month's money in/out, savings rate, where it went, a 6-month trend, balances, goals and what's coming up. An account picker narrows Home and Insights to a single account.
- **Insights** (Home + Insights page): pace and safe-to-spend per day, what changed vs last month and why, small leaks, unusual spends, untracked subscriptions, weekend and late-night habits, savings rate — all computed from your own data, no AI service.
- **Backup and restore**: download everything as one JSON file and load it back into the same or a new account. Restore only adds what's missing — you get a preview first, existing data is never changed, and restoring the same file twice adds nothing.
- **Bento-style interface**: sidebar navigation and rounded, softly tinted tiles; collapses to a top bar on phones.
- Multi-user login (JWT + bcryptjs), self-hosted, no paid APIs.

Existing databases upgrade automatically on first start: old expenses move into a "Cash" account.

## Project layout

```
server/   Express API — routes/, services/ (insights, recurring, statement import, goals, backup), migrations.js, tests/
client/   React + Vite UI — src/pages/, src/components/, src/api.js
```

## Notes

- Requires Node 22.5+ for `node:sqlite`. Tested on Node v26.
- The SQLite database file (`server/data.db`) is created automatically on first run and is git-ignored. Use **Backup** in the app (next to your email) to keep a copy of your data.
