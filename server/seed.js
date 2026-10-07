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
};

export function seedNewUser(db, userId) {
  db.prepare("INSERT INTO accounts (user_id, name, type) VALUES (?, 'Cash', 'cash')").run(userId);

  const insertCategory = db.prepare('INSERT INTO categories (user_id, name, color, kind) VALUES (?, ?, ?, ?)');
  const ids = {};
  for (const [name, color] of EXPENSE_CATEGORIES) {
    ids[name] = Number(insertCategory.run(userId, name, color, 'expense').lastInsertRowid);
  }
  for (const [name, color] of INCOME_CATEGORIES) {
    insertCategory.run(userId, name, color, 'income');
  }

  const insertRule = db.prepare('INSERT INTO category_rules (user_id, match_text, category_id) VALUES (?, ?, ?)');
  for (const [category, words] of Object.entries(STARTER_RULES)) {
    for (const word of words) insertRule.run(userId, word, ids[category]);
  }
}
