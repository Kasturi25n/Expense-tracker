import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { formatMoney, todayStr } from '../format.js';

export function Budgets() {
  const { token } = useAuth();
  const [categories, setCategories] = useState([]);
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [status, setStatus] = useState([]);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState('');
  const [income, setIncome] = useState(null);

  const load = useCallback(() => {
    api.getBudgetStatus(token, month).then(setStatus).catch((e) => setError(e.message));
    api.getInsights(token, month).then((r) => setIncome(r.totals.expectedIncome)).catch((e) => setError(e.message));
  }, [token, month]);

  useEffect(() => {
    api.getCategories(token).then((c) => setCategories(c.filter((x) => x.kind === 'expense'))).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const categoryName = (id) => (id === null ? 'All spending' : categories.find((c) => c.id === id)?.name ?? 'Deleted category');

  const add = async (e) => {
    e.preventDefault();
    setError('');
    const value = parseFloat(amount);
    if (!(value > 0)) return setError('Enter a budget greater than 0');
    try {
      await api.createBudget(token, { month, amount: value, categoryId: categoryId ? Number(categoryId) : null });
      setAmount('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this budget?')) return;
    await api.deleteBudget(token, id);
    load();
  };

  const latest = new Map(status.map((b) => [b.category_id, b.amount]));
  const budgeted = latest.has(null) ? latest.get(null) : [...latest.values()].reduce((a, b) => a + b, 0);
  const unplanned = (income ?? 0) - budgeted;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Budgets</h1>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}

      {income !== null && (
        <div className="card row spread">
          {income > 0 ? (
            <>
              <span>Money in this month <strong>{formatMoney(income)}</strong> <small className="hint">incl. expected salary</small></span>
              <span>Budgeted <strong>{formatMoney(budgeted)}</strong></span>
              <span className={unplanned < 0 ? 'amount negative' : ''}>
                {unplanned >= 0 ? <>Not budgeted <strong>{formatMoney(unplanned)}</strong></> : `Budgeted ${formatMoney(-unplanned)} more than you earn`}
              </span>
            </>
          ) : (
            <>
              <span>Add your income to see how your budgets compare.</span>
              <Link to={`/recurring?new=1&type=income&frequency=monthly&nextDate=${todayStr().slice(0, 7)}-01`}>Add income</Link>
            </>
          )}
        </div>
      )}

      <div className="card">
        {status.length ? (
          <ul className="list">
            {status.map((b) => (
              <li key={b.id}>
                <div className="grow">
                  <div className="row spread">
                    <strong>{categoryName(b.category_id)}</strong>
                    <span className={`amount ${b.overBudget ? 'negative' : ''}`}>{formatMoney(b.spent)} of {formatMoney(b.amount)}</span>
                  </div>
                  <div className="meter">
                    <div className={`meter-fill ${b.overBudget ? 'over' : ''}`} style={{ width: `${Math.min(100, (b.spent / b.amount) * 100)}%` }} />
                  </div>
                  <small className="hint">{b.overBudget ? `Over by ${formatMoney(b.spent - b.amount)}` : `${formatMoney(b.amount - b.spent)} left`}</small>
                </div>
                <button className="icon" aria-label="Remove budget" onClick={() => remove(b.id)}>×</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No budgets for this month yet. Start with your biggest category below.</p>
        )}
      </div>

      <form className="card" onSubmit={add}>
        <h2>Set a budget</h2>
        <div className="form-grid">
          <label>
            Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All spending</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>Limit for the month (₹)<input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <button type="submit">Save budget</button>
        </div>
      </form>
    </div>
  );
}
