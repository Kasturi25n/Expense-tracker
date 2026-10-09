import { formatMoney } from '../format.js';

const longDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

export function GoalProgress({ goal }) {
  const pct = Math.min(100, (goal.saved / goal.target_amount) * 100);
  return (
    <>
      <div className="row spread">
        <span><strong>{formatMoney(goal.saved)}</strong> of {formatMoney(goal.target_amount)}</span>
        <span className="hint">{goal.target_date ? `by ${longDate(goal.target_date)}` : `${Math.floor(pct)}%`}</span>
      </div>
      <div className="meter goal-meter">
        <div className={`meter-fill ${goal.status === 'reached' ? 'done' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}
