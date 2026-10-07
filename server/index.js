import 'dotenv/config';
import { createDb } from './db.js';
import { createApp } from './app.js';

const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const port = process.env.PORT || 4000;

const db = createDb();
const app = createApp(db, jwtSecret);

app.listen(port, () => {
  console.log(`Expense Tracker API listening on http://localhost:${port}`);
});
