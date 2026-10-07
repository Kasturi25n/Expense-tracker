import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';

export function Categories() {
  const { token } = useAuth();
  const [categories, setCategories] = useState([]);
  const [rules, setRules] = useState([]);
  const [form, setForm] = useState({ name: '', color: '#3b6ef5', kind: 'expense' });
  const [editing, setEditing] = useState(null);
  const [ruleForm, setRuleForm] = useState({ matchText: '', categoryId: '' });
  const [error, setError] = useState('');

  const load = () =>
    Promise.all([api.getCategories(token), api.getRules(token)])
      .then(([c, r]) => {
        setCategories(c);
        setRules(r);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [token]);

  const run = async (fn) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const add = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    run(async () => {
      await api.createCategory(token, form);
      setForm({ ...form, name: '' });
    });
  };

  const save = () =>
    run(async () => {
      await api.updateCategory(token, editing.id, { name: editing.name, color: editing.color });
      setEditing(null);
    });

  const remove = (c) => {
    if (window.confirm(`Delete "${c.name}"? Its transactions will become uncategorised.`)) run(() => api.deleteCategory(token, c.id));
  };

  const addRule = (e) => {
    e.preventDefault();
    if (!ruleForm.matchText.trim() || !ruleForm.categoryId) return setError('Enter a word and pick a category');
    run(async () => {
      await api.createRule(token, { matchText: ruleForm.matchText, categoryId: Number(ruleForm.categoryId) });
      setRuleForm({ matchText: '', categoryId: '' });
    });
  };

  const section = (kind, title) => (
    <div className="card">
      <h2>{title}</h2>
      <ul className="list">
        {categories.filter((c) => c.kind === kind).map((c) =>
          editing?.id === c.id ? (
            <li key={c.id}>
              <input className="grow" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <input type="color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
              <button onClick={save}>Save</button>
              <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
            </li>
          ) : (
            <li key={c.id}>
              <span className="grow"><span className="badge" style={{ backgroundColor: c.color }}>{c.name}</span></span>
              <button className="secondary" onClick={() => setEditing({ ...c })}>Edit</button>
              <button className="danger" onClick={() => remove(c)}>Delete</button>
            </li>
          )
        )}
      </ul>
    </div>
  );

  return (
    <div className="page">
      <h1>Categories</h1>
      {error && <p className="error">{error}</p>}

      <form className="card row" onSubmit={add}>
        <input className="grow" placeholder="New category name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          <option value="expense">For spending</option>
          <option value="income">For income</option>
        </select>
        <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
        <button type="submit">Add category</button>
      </form>

      <div className="grid">
        {section('expense', 'Spending')}
        {section('income', 'Income')}
      </div>

      <div className="card">
        <h2>Auto-categorise</h2>
        <p className="hint">When a payee or note contains one of these words, new transactions are filed automatically.</p>
        <form className="row" onSubmit={addRule}>
          <input placeholder='Word, e.g. "chaayos"' value={ruleForm.matchText} onChange={(e) => setRuleForm({ ...ruleForm, matchText: e.target.value })} />
          <span>→</span>
          <select value={ruleForm.categoryId} onChange={(e) => setRuleForm({ ...ruleForm, categoryId: e.target.value })}>
            <option value="">Category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="submit">Add rule</button>
        </form>
        <ul className="list">
          {rules.map((r) => (
            <li key={r.id}>
              <span className="grow">“{r.match_text}” → {r.category_name}</span>
              <button className="icon" aria-label={`Delete rule ${r.match_text}`} onClick={() => run(() => api.deleteRule(token, r.id))}>×</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
