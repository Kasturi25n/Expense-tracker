import 'dotenv/config';
import { createDb } from './db.js';
import { createApp } from './app.js';

const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const port = process.env.PORT || 4000;
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET is not set, so a built-in development secret is in use. Copy .env.example to .env and set your own before putting this online.');
}

const db = createDb();
const app = createApp(db, jwtSecret);

app.listen(port, () => {
  console.log(`Expense Tracker API listening on http://localhost:${port}`);
});
