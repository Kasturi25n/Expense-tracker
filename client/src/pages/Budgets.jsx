import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { formatMoney } from '../format.js';

const currentMonth = new Date().toISOString().slice(0, 7);

export function Budgets() {
  const { token } = useAuth();
  const [categories, setCategories] = useState([]);
  const [month, setMonth] = useState(currentMonth);
  const [status, setStatus] = useState([]);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.getBudgetStatus(token, month).then(setStatus).catch((e) => setError(e.message));
  }, [token, month]);

  useEffect(() => {
    api.getCategories(token).then(setCategories).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const categoryName = (id) => categories.find((c) => c.id === id)?.name || 'Overall';

  const handleAdd = async (e) => {
    e.preventDefault();
    setError('');
    const value = parseFloat(amount);
    if (Number.isNaN(value) || value <= 0) {
      setError('Enter a positive budget amount');
      return;
    }
    try {
      await api.createBudget(token, { month, amount: value, categoryId: categoryId ? Number(categoryId) : null });
      setAmount('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    await api.deleteBudget(token, id);
    load();
  };

  return (
    <div className="page">
      <h1>Budgets</h1>
      <div className="filters">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </div>

      <form className="category-form" onSubmit={handleAdd}>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Overall (all categories)</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="number" step="0.01" placeholder="Budget amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button type="submit">Set budget</button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="budget-list">
        {status.map((b) => (
          <li key={b.id} className={b.overBudget ? 'over-budget' : ''}>
            <span>{categoryName(b.category_id)}</span>
            <span>{formatMoney(b.spent)} / {formatMoney(b.amount)}</span>
            {b.overBudget && <span className="warning">Over budget!</span>}
            <button onClick={() => handleDelete(b.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
