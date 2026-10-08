import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { formatMoney } from '../format.js';

const TYPE_LABELS = { cash: 'Cash', bank: 'Bank / UPI', credit_card: 'Credit card', wallet: 'Wallet' };
const EMPTY = { name: '', type: 'bank', balance: '' };

// Credit cards are entered as "amount you owe" and stored as a negative balance.
const toOpeningBalance = (type, value) => {
  const n = parseFloat(value) || 0;
  return type === 'credit_card' ? -Math.abs(n) : n;
};

export function Accounts() {
  const { token } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.getAccounts(token).then(setAccounts).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [token]);

  const run = async (fn) => {
    setError('');
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };

  const add = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setError('Give the account a name');
    run(async () => {
      await api.createAccount(token, { name: form.name, type: form.type, openingBalance: toOpeningBalance(form.type, form.balance) });
      setForm(EMPTY);
    });
  };

  const update = (a, changes) =>
    run(() => api.updateAccount(token, a.id, { name: a.name, type: a.type, openingBalance: a.opening_balance, archived: Boolean(a.archived), ...changes }));

  const saveEdit = async () => {
    const ok = await update(editing, { name: editing.name, openingBalance: Number(editing.opening_balance) || 0 });
    if (ok) setEditing(null);
  };

  const remove = (a) => {
    if (window.confirm(`Delete "${a.name}"? This can't be undone.`)) run(() => api.deleteAccount(token, a.id));
  };

  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);
  const total = active.reduce((sum, a) => sum + a.balance, 0);

  const row = (a) =>
    editing?.id === a.id ? (
      <li key={a.id}>
        <input className="grow" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        <label className="inline">
          Starting balance
          <input type="number" step="0.01" value={editing.opening_balance} onChange={(e) => setEditing({ ...editing, opening_balance: e.target.value })} />
        </label>
        <button onClick={saveEdit}>Save</button>
        <button className="secondary" onClick={() => setEditing(null)}>Cancel</button>
      </li>
    ) : (
      <li key={a.id}>
        <span className="grow">
          <strong>{a.name}</strong> <span className="pill">{TYPE_LABELS[a.type]}</span>
        </span>
        <span className={`amount ${a.balance < 0 ? 'negative' : ''}`}>
          {a.type === 'credit_card' && a.balance < 0 ? `You owe ${formatMoney(-a.balance)}` : formatMoney(a.balance)}
        </span>
        {!a.archived && <Link className="button-link secondary" to={`/import?accountId=${a.id}`}>Import</Link>}
        <button className="secondary" onClick={() => setEditing({ ...a })}>Edit</button>
        <button className="secondary" onClick={() => update(a, { archived: !a.archived })}>{a.archived ? 'Restore' : 'Archive'}</button>
        <button className="danger" onClick={() => remove(a)}>Delete</button>
      </li>
    );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Accounts</h1>
        <span className="hint">Total balance <strong>{formatMoney(total)}</strong></span>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <ul className="list">{active.map(row)}</ul>
      </div>

      <form className="card" onSubmit={add}>
        <h2>Add an account</h2>
        <div className="form-grid">
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. HDFC Savings" /></label>
          <label>
            Type
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            {form.type === 'credit_card' ? 'Amount you owe today (₹)' : 'Balance today (₹)'}
            <input type="number" step="0.01" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} placeholder="0" />
          </label>
          <button type="submit">Add account</button>
        </div>
        <p className="hint">
          Paying a credit card bill? Log it as a <strong>Transfer</strong> from your bank to the card — the spending was already counted when you used the card.
        </p>
      </form>

      {archived.length > 0 && (
        <div className="card">
          <h2>Archived</h2>
          <p className="hint">Hidden when adding transactions. History and balances are kept.</p>
          <ul className="list">{archived.map(row)}</ul>
        </div>
      )}
    </div>
  );
}
