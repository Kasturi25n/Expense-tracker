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

Runs the backend test suite (vitest + supertest) covering the migration, auth, accounts, transactions, rules, recurring items, budgets, summary and export.

## Features

- **Quick Add** from any page: amount + payee + Save. Category, account and time fill themselves in.
- **Income, expenses and transfers** across accounts (cash, bank/UPI, credit card, wallet) with running balances. Card bill payments are transfers, so they're not double-counted.
- **Auto-categorise rules** (starter rules for Swiggy, Zomato, Uber, Amazon, Netflix, Jio…), plus learning from your past payees.
- **Recurring items** that add themselves (rent, salary, SIP) or wait for you to confirm the amount (electricity).
- **Tags** like `goa-trip`, filters and search, CSV export.
- **Budgets** per category or overall, with progress bars and over-budget warnings.
- **Home** shows this month's money in/out, savings rate, where it went, a 6-month trend, balances and what's coming up.
- Multi-user login (JWT + bcryptjs), self-hosted, no paid APIs.

Existing databases upgrade automatically on first start: old expenses move into a "Cash" account.

## Notes

- Requires Node 22.5+ for `node:sqlite`. Tested on Node v26.
- The SQLite database file (`server/data.db`) is created automatically on first run and is git-ignored.
