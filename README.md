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

Runs the backend test suite (vitest + supertest) covering auth and CRUD.

## Features

- Multi-user auth (register/login, JWT + bcryptjs, self-hosted, no paid APIs)
- Expense CRUD with filtering by date range, category, and text search
- Categories with color coding
- Monthly budgets per category or overall, with over-budget warnings
- Dashboard with total spend, category breakdown pie chart, and monthly trend line chart
- CSV export of expenses

## Notes

- Requires Node 22.5+ for `node:sqlite`. Tested on Node v26.
- The SQLite database file (`server/data.db`) is created automatically on first run and is git-ignored.
