const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchesWord(text, phrase) {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase.toLowerCase())}($|[^a-z0-9])`);
  return pattern.test(text.toLowerCase());
}

export function suggestCategory(db, userId, { payee = '', note = '', type }) {
  if (type === 'transfer') return null;

  const rules = db
    .prepare(
      `SELECT r.match_text, r.category_id FROM category_rules r
       JOIN categories c ON c.id = r.category_id
       WHERE r.user_id = ? AND c.kind = ?`
    )
    .all(userId, type);
  for (const text of [payee, note]) {
    if (!text) continue;
    const hits = rules.filter((r) => matchesWord(text, r.match_text));
    if (hits.length) return hits.sort((a, b) => b.match_text.length - a.match_text.length)[0].category_id;
  }

  if (!payee) return null;
  const last = db
    .prepare(
      `SELECT t.category_id FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = ? AND lower(t.payee) = lower(?) AND c.kind = ?
       ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1`
    )
    .get(userId, payee, type);
  return last ? last.category_id : null;
}
