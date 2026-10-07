import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { ExpenseForm } from '../components/ExpenseForm.jsx';
import { CategoryBadge } from '../components/CategoryBadge.jsx';
import { formatMoney, formatDateTime } from '../format.js';

export function Expenses() {
  const { token } = useAuth();
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [filters, setFilters] = useState({ from: '', to: '', categoryId: '', q: '' });
  const [error, setError] = useState('');

  const categoryById = (id) => categories.find((c) => c.id === id);

  const loadExpenses = useCallback(() => {
    const cleaned = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    api.getExpenses(token, cleaned).then(setExpenses).catch((e) => setError(e.message));
  }, [token, filters]);

  useEffect(() => {
    api.getCategories(token).then(setCategories).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => { loadExpenses(); }, [loadExpenses]);

  const handleCreate = async (expense) => {
    await api.createExpense(token, expense);
    loadExpenses();
  };

  const handleUpdate = async (expense) => {
    await api.updateExpense(token, editingId, expense);
    setEditingId(null);
    loadExpenses();
  };

  const handleDelete = async (id) => {
    await api.deleteExpense(token, id);
    loadExpenses();
  };

  const handleExport = async () => {
    const blob = await api.exportCsv(token);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'expenses.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const editingExpense = expenses.find((e) => e.id === editingId);

  return (
    <div className="page">
      <h1>Expenses</h1>

      <ExpenseForm
        categories={categories}
        initial={editingExpense ? {
          amount: editingExpense.amount,
          description: editingExpense.description,
          date: editingExpense.date.includes('T') ? editingExpense.date : `${editingExpense.date}T00:00`,
          categoryId: editingExpense.category_id || '',
        } : null}
        onSubmit={editingId ? handleUpdate : handleCreate}
        onCancel={editingId ? () => setEditingId(null) : null}
      />
      {error && <p className="error">{error}</p>}

      <div className="filters">
        <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        <select value={filters.categoryId} onChange={(e) => setFilters({ ...filters, categoryId: e.target.value })}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="text" placeholder="Search description" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <button onClick={handleExport}>Export CSV</button>
      </div>

      <table className="expense-table">
        <thead>
          <tr><th>Date &amp; time</th><th>Description</th><th>Category</th><th>Amount</th><th></th></tr>
        </thead>
        <tbody>
          {expenses.map((e) => (
            <tr key={e.id}>
              <td>{formatDateTime(e.date)}</td>
              <td>{e.description}</td>
              <td><CategoryBadge category={categoryById(e.category_id)} /></td>
              <td>{formatMoney(e.amount)}</td>
              <td>
                <button onClick={() => setEditingId(e.id)}>Edit</button>
                <button onClick={() => handleDelete(e.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
