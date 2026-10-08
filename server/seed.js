const EXPENSE_CATEGORIES = [
  ['Food & Dining', '#f97316'],
  ['Groceries', '#84cc16'],
  ['Transport', '#0ea5e9'],
  ['Shopping', '#ec4899'],
  ['Bills & Utilities', '#eab308'],
  ['Rent', '#8b5cf6'],
  ['Entertainment', '#f43f5e'],
  ['Health', '#14b8a6'],
  ['Education', '#6366f1'],
  ['Travel', '#06b6d4'],
  ['Personal Care', '#d946ef'],
  ['Other', '#94a3b8'],
];

const INCOME_CATEGORIES = [
  ['Salary', '#16a34a'],
  ['Freelance', '#22c55e'],
  ['Interest', '#4ade80'],
  ['Refunds', '#65a30d'],
  ['Other Income', '#15803d'],
];

const STARTER_RULES = {
  'Food & Dining': ['swiggy', 'zomato'],
  Groceries: ['blinkit', 'zepto', 'bigbasket', 'instamart'],
  Transport: ['uber', 'ola', 'rapido', 'irctc'],
  Shopping: ['amazon', 'flipkart', 'myntra', 'ajio'],
  Entertainment: ['netflix', 'hotstar', 'spotify', 'prime video', 'bookmyshow'],
  'Bills & Utilities': ['airtel', 'jio', 'bescom', 'electricity'],
  Health: ['apollo', 'pharmeasy', '1mg'],
  Salary: ['salary'],
};

// Adds whatever starter data the user is missing, so it is safe for new and existing users alike.
export function seedStarterData(db, userId) {
  if (!db.prepare('SELECT 1 FROM accounts WHERE user_id = ? LIMIT 1').get(userId)) {
    db.prepare("INSERT INTO accounts (user_id, name, type) VALUES (?, 'Cash', 'cash')").run(userId);
  }

  const existing = new Map(
    db.prepare('SELECT id, lower(name) AS name FROM categories WHERE user_id = ?').all(userId).map((c) => [c.name, c.id])
  );
  const insertCategory = db.prepare('INSERT INTO categories (user_id, name, color, kind) VALUES (?, ?, ?, ?)');
  const ensureCategory = (name, color, kind) =>
    existing.get(name.toLowerCase()) ?? Number(insertCategory.run(userId, name, color, kind).lastInsertRowid);

  const ids = {};
  for (const [name, color] of EXPENSE_CATEGORIES) ids[name] = ensureCategory(name, color, 'expense');
  for (const [name, color] of INCOME_CATEGORIES) ids[name] = ensureCategory(name, color, 'income');

  const words = new Set(db.prepare('SELECT match_text FROM category_rules WHERE user_id = ?').all(userId).map((r) => r.match_text));
  const insertRule = db.prepare('INSERT INTO category_rules (user_id, match_text, category_id) VALUES (?, ?, ?)');
  for (const [category, list] of Object.entries(STARTER_RULES)) {
    for (const word of list) if (!words.has(word)) insertRule.run(userId, word, ids[category]);
  }
}
