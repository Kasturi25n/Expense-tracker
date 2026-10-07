import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend, ResponsiveContainer } from 'recharts';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { formatMoney, formatShortDate, monthRange } from '../format.js';

export function Dashboard() {
  const { token } = useAuth();
  const { open, version } = useQuickAdd();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const months = [-5, -4, -3, -2, -1, 0].map(monthRange);
    const current = months[months.length - 1];
    Promise.all([
      Promise.all(months.map((m) => api.getSummary(token, m.from, m.to))),
      api.getCategories(token),
      api.getRecurring(token),
      api.getUpcoming(token, 7),
      api.getBudgetStatus(token, current.from.slice(0, 7)),
      api.getTransactions(token, { limit: 1 }),
    ])
      .then(([history, categories, recurring, upcoming, budgets, anyTx]) =>
        setData({
          summary: history[history.length - 1],
          history: history.map((h, i) => ({ month: months[i].label, 'Money in': h.income, 'Money out': h.expense })),
          categories,
          pending: recurring.pending,
          upcoming,
          budgets,
          hasTransactions: anyTx.total > 0,
        })
      )
      .catch((e) => setError(e.message));
  }, [token, version]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!data) return <div className="page"><p className="hint">Loading…</p></div>;

  const { summary, history, categories, pending, upcoming, budgets, hasTransactions } = data;
  if (!hasTransactions) {
    return (
      <div className="page">
        <h1>Welcome</h1>
        <div className="empty">
          <p>Your home screen fills up as you log money in and out.</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button onClick={() => open()}>Add your first transaction</button>
            <Link to="/accounts">Set up your bank and card accounts</Link>
          </div>
        </div>
      </div>
    );
  }

  const categoryOf = (id) => categories.find((c) => c.id === id);
  const pieData = summary.byCategory.map((b) => ({
    name: categoryOf(b.categoryId)?.name ?? 'Uncategorised',
    value: b.total,
    color: categoryOf(b.categoryId)?.color ?? '#a3a8b8',
  }));
  const savingsRate = summary.income > 0 ? Math.round((summary.net / summary.income) * 100) : null;
  const overBudget = budgets.filter((b) => b.overBudget);
  const totalBalance = summary.accounts.reduce((sum, a) => sum + a.balance, 0);

  return (
    <div className="page">
      <h1>This month</h1>

      {pending.length > 0 && (
        <div className="banner">
          <span>{pending.length === 1 ? '1 bill is' : `${pending.length} bills are`} waiting for you to confirm the amount.</span>
          <Link to="/recurring">Review</Link>
        </div>
      )}
      {overBudget.map((b) => (
        <div key={b.id} className="banner danger">
          <span>
            Over budget in {b.category_id === null ? 'total spending' : categoryOf(b.category_id)?.name}: {formatMoney(b.spent)} of {formatMoney(b.amount)}
          </span>
          <Link to="/budgets">Budgets</Link>
        </div>
      ))}

      <div className="stats">
        <div className="stat"><span>Money in</span><strong className="amount income">{formatMoney(summary.income)}</strong></div>
        <div className="stat"><span>Money out</span><strong>{formatMoney(summary.expense)}</strong></div>
        <div className="stat">
          <span>{summary.net >= 0 ? 'Saved' : 'Overspent'}</span>
          <strong className={summary.net < 0 ? 'amount negative' : ''}>{formatMoney(Math.abs(summary.net))}</strong>
          {savingsRate !== null && <small>{savingsRate}% of what came in</small>}
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Where it went</h2>
          {pieData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95}>
                  {pieData.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v) => formatMoney(v)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="hint">No spending logged this month yet.</p>
          )}
        </div>
        <div className="card">
          <h2>Last 6 months</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={history}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" />
              <YAxis tickFormatter={(v) => `₹${Math.round(v / 1000)}k`} width={50} />
              <Tooltip formatter={(v) => formatMoney(v)} />
              <Legend />
              <Bar dataKey="Money in" fill="#15803d" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Money out" fill="#3b6ef5" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Accounts</h2>
          <ul className="list">
            {summary.accounts.map((a) => (
              <li key={a.id}>
                <span className="grow">{a.name}</span>
                <span className={`amount ${a.balance < 0 ? 'negative' : ''}`}>{formatMoney(a.balance)}</span>
              </li>
            ))}
          </ul>
          <p className="hint">Total across accounts: {formatMoney(totalBalance)}</p>
        </div>
        <div className="card">
          <h2>Coming up in 7 days</h2>
          {upcoming.length ? (
            <ul className="list">
              {upcoming.map((u) => (
                <li key={`${u.ruleId}-${u.date}`}>
                  <span className="grow">{u.payee || 'Repeating item'}</span>
                  <span className="hint">{formatShortDate(u.date)}</span>
                  <span className={`amount ${u.type}`}>{formatMoney(u.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              Nothing due. <Link to="/recurring">Add rent, salary or subscriptions</Link> so they log themselves.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
