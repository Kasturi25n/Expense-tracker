const round = (n) => Math.round(n * 100) / 100;
const monthIndex = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));

// Adds what the screens need to a goal row: how much is saved, what's left, and whether it's on track.
// "On track" compares savings with one month's share for every full month since the goal was made,
// so nobody is "behind" just because they save at the end of the month.
export function describeGoal(goal, saved, today) {
  const remaining = round(Math.max(0, goal.target_amount - saved));
  const base = { ...goal, saved: round(saved), remaining, monthsLeft: null, perMonth: null };
  if (remaining === 0) return { ...base, status: 'reached' };
  if (!goal.target_date) return { ...base, status: 'open' };
  if (goal.target_date < today) return { ...base, status: 'overdue' };

  const monthsLeft = monthIndex(goal.target_date) - monthIndex(today) + 1;
  const created = goal.created_at.slice(0, 10);
  const totalMonths = Math.max(1, monthIndex(goal.target_date) - monthIndex(created) + 1);
  const monthsPassed = Math.max(0, monthIndex(today) - monthIndex(created));
  const expected = (goal.target_amount * Math.min(monthsPassed, totalMonths)) / totalMonths;
  return { ...base, monthsLeft, perMonth: Math.ceil(remaining / monthsLeft), status: saved + 0.005 < expected ? 'behind' : 'on-track' };
}

export function listGoals(db, userId, today) {
  const contributions = db
    .prepare(
      `SELECT c.id, c.goal_id, c.amount, c.date, c.note FROM goal_contributions c JOIN goals g ON g.id = c.goal_id
       WHERE g.user_id = ? ORDER BY c.date DESC, c.id DESC`
    )
    .all(userId);
  return db
    .prepare('SELECT id, name, target_amount, target_date, created_at FROM goals WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map((goal) => {
      const own = contributions.filter((c) => c.goal_id === goal.id);
      return { ...describeGoal(goal, own.reduce((sum, c) => sum + c.amount, 0), today), contributions: own };
    });
}
