import { useState, useEffect, useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend, ResponsiveContainer } from 'recharts';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { formatMoney } from '../format.js';

const currentMonth = new Date().toISOString().slice(0, 7);
const FALLBACK_COLOR = '#888888';

export function Dashboard() {
  const { token } = useAuth();
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [budgetStatus, setBudgetStatus] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.getExpenses(token),
      api.getCategories(token),
      api.getBudgetStatus(token, currentMonth),
    ])
      .then(([e, c, b]) => {
        setExpenses(e);
        setCategories(c);
        setBudgetStatus(b);
      })
      .catch((e) => setError(e.message));
  }, [token]);

  const total = useMemo(() => expenses.reduce((sum, e) => sum + e.amount, 0), [expenses]);

  const categoryBreakdown = useMemo(() => {
    const map = new Map();
    for (const e of expenses) {
      const key = e.category_id || 'none';
      map.set(key, (map.get(key) || 0) + e.amount);
    }
    return Array.from(map.entries()).map(([key, value]) => {
      const cat = categories.find((c) => c.id === key);
      return { name: cat ? cat.name : 'Uncategorized', value, color: cat ? cat.color : FALLBACK_COLOR };
    });
  }, [expenses, categories]);

  const monthlyTrend = useMemo(() => {
    const map = new Map();
    for (const e of expenses) {
      const month = e.date.slice(0, 7);
      map.set(month, (map.get(month) || 0) + e.amount);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, total]) => ({ month, total }));
  }, [expenses]);

  const categoryName = (id) => categories.find((c) => c.id === id)?.name || 'Overall';

  return (
    <div className="page">
      <h1>Dashboard</h1>
      {error && <p className="error">{error}</p>}

      <div className="stat-tile">
        <span>Total spend</span>
        <strong>{formatMoney(total)}</strong>
      </div>

      {budgetStatus.some((b) => b.overBudget) && (
        <div className="warning-banner">
          {budgetStatus.filter((b) => b.overBudget).map((b) => (
            <p key={b.id}>Over budget in {categoryName(b.category_id)}: {formatMoney(b.spent)} / {formatMoney(b.amount)}</p>
          ))}
        </div>
      )}

      <div className="charts">
        <div className="chart-box">
          <h2>Spend by category</h2>
          {categoryBreakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={categoryBreakdown} dataKey="value" nameKey="name" outerRadius={100} label>
                  {categoryBreakdown.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : <p>No expenses yet.</p>}
        </div>

        <div className="chart-box">
          <h2>Monthly trend</h2>
          {monthlyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={monthlyTrend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="total" stroke="#4f8ef7" />
              </LineChart>
            </ResponsiveContainer>
          ) : <p>No expenses yet.</p>}
        </div>
      </div>
    </div>
  );
}
