import { useState, useEffect } from 'react';
import { nowLocalDateTime } from '../format.js';

const emptyForm = () => ({ amount: '', description: '', date: nowLocalDateTime(), categoryId: '' });

export function ExpenseForm({ categories, initial, onSubmit, onCancel }) {
  const [form, setForm] = useState(initial || emptyForm());
  const [error, setError] = useState('');

  useEffect(() => {
    setForm(initial || emptyForm());
  }, [initial]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const amount = parseFloat(form.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      setError('Enter a positive amount');
      return;
    }
    if (!form.date) {
      setError('Date and time are required');
      return;
    }
    try {
      await onSubmit({
        amount,
        description: form.description,
        date: form.date,
        categoryId: form.categoryId ? Number(form.categoryId) : null,
      });
      setForm(emptyForm());
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="expense-form" onSubmit={handleSubmit}>
      <input
        type="number"
        step="0.01"
        placeholder="Amount"
        value={form.amount}
        onChange={(e) => setForm({ ...form, amount: e.target.value })}
      />
      <input
        type="text"
        placeholder="Description"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <input
        type="datetime-local"
        value={form.date}
        onChange={(e) => setForm({ ...form, date: e.target.value })}
      />
      <select
        value={form.categoryId || ''}
        onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
      >
        <option value="">Uncategorized</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <button type="submit">{initial ? 'Save' : 'Add expense'}</button>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
