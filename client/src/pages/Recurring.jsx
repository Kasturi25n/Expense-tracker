import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { formatMoney, formatShortDate, todayStr } from '../format.js';

const FREQUENCIES = { weekly: 'Every week', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year' };
const TYPES = [['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']];

const blank = (accountId) => ({
  type: 'expense', amount: '', payee: '', categoryId: '', accountId: accountId ?? '', toAccountId: '',
  frequency: 'monthly', nextDate: todayStr(), endDate: '', mode: 'auto',
});

const ruleToForm = (r) => ({
  id: r.id, active: r.active, type: r.type, amount: String(r.amount), payee: r.payee, categoryId: r.category_id ?? '',
  accountId: r.account_id, toAccountId: r.to_account_id ?? '', frequency: r.frequency, nextDate: r.next_date,
  endDate: r.end_date ?? '', mode: r.mode,
});

const toBody = (f) => ({
  type: f.type,
  amount: parseFloat(f.amount),
  payee: f.type === 'transfer' ? '' : f.payee.trim(),
  accountId: Number(f.accountId),
  toAccountId: f.type === 'transfer' ? Number(f.toAccountId) : null,
  categoryId: f.type === 'transfer' || !f.categoryId ? null : Number(f.categoryId),
  frequency: f.frequency,
  nextDate: f.nextDate,
  endDate: f.endDate || null,
  mode: f.mode,
});

const keyOf = (o) => `${o.ruleId}-${o.date}`;

export function Recurring() {
  const { token } = useAuth();
  const { refresh } = useQuickAdd();
  const [rules, setRules] = useState([]);
  const [pending, setPending] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(null);
  const [amounts, setAmounts] = useState({});
  const [error, setError] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

  const load = () =>
    Promise.all([api.getRecurring(token), api.getUpcoming(token, 7), api.getAccounts(token), api.getCategories(token)])
      .then(([r, u, a, c]) => {
        setRules(r.rules);
        setPending(r.pending);
        setUpcoming(u);
        setAccounts(a);
        setCategories(c);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, [token]);

  useEffect(() => {
    if (searchParams.get('new') !== '1' || !accounts.length) return;
    const params = Object.fromEntries(searchParams);
    const prefill = Object.fromEntries(
      ['type', 'payee', 'amount', 'categoryId', 'accountId', 'frequency', 'nextDate'].filter((k) => params[k]).map((k) => [k, params[k]])
    );
    if (prefill.accountId) prefill.accountId = Number(prefill.accountId);
    if (prefill.categoryId) prefill.categoryId = Number(prefill.categoryId);
    if (prefill.type === 'income' && !prefill.categoryId) {
      prefill.categoryId = categories.find((c) => c.kind === 'income' && c.name === 'Salary')?.id ?? '';
    }
    setForm({ ...blank(accounts.find((a) => !a.archived)?.id), ...prefill });
    setSearchParams({}, { replace: true });
  }, [searchParams, accounts, categories, setSearchParams]);

  const run = async (fn) => {
    setError('');
    try {
      await fn();
      await load();
      refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? '';
  const categoryName = (id) => categories.find((c) => c.id === id)?.name;
  const describe = (r) =>
    r.type === 'transfer' ? `${accountName(r.account_id)} → ${accountName(r.to_account_id)}` : r.payee || categoryName(r.category_id) || 'Repeating item';
  const status = (r) => {
    if (r.active) return `next ${formatShortDate(r.next_date)}`;
    return r.end_date && r.next_date > r.end_date ? 'ended' : 'paused';
  };
  const activeAccounts = accounts.filter((a) => !a.archived || (form && (a.id === form.accountId || a.id === form.toAccountId)));

  const save = async (e) => {
    e.preventDefault();
    if (!(parseFloat(form.amount) > 0)) return setError('Enter an amount greater than 0');
    if (!form.accountId) return setError('Pick an account');
    if (form.type === 'transfer' && !form.toAccountId) return setError('Pick the account the money goes to');
    const body = toBody(form);
    const ok = await run(() => (form.id ? api.updateRecurring(token, form.id, { ...body, active: Boolean(form.active) }) : api.createRecurring(token, body)));
    if (ok) setForm(null);
  };

  const toggle = (r) => run(() => api.updateRecurring(token, r.id, { ...toBody(ruleToForm(r)), active: !r.active }));
  const remove = (r) => {
    if (window.confirm(`Stop repeating "${describe(r)}"? Transactions already added stay.`)) run(() => api.deleteRecurring(token, r.id));
  };
  const confirm = (p) => run(() => api.confirmRecurring(token, p.ruleId, { amount: parseFloat(amounts[keyOf(p)] ?? p.amount) }));
  const skip = (p) => run(() => api.skipRecurring(token, p.ruleId));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Recurring</h1>
        {!form && <button onClick={() => setForm(blank(accounts.find((a) => !a.archived)?.id))}>+ New repeating item</button>}
      </div>
      {error && <p className="error">{error}</p>}

      {form && (
        <form className="card" onSubmit={save}>
          <h2>{form.id ? 'Edit repeating item' : 'New repeating item'}</h2>
          <div className="segmented">
            {TYPES.map(([value, label]) => (
              <button type="button" key={value} className={form.type === value ? `active ${value}` : ''} onClick={() => setForm({ ...form, type: value, categoryId: '' })}>
                {label}
              </button>
            ))}
          </div>
          <div className="form-grid" style={{ marginTop: '.75rem' }}>
            <label>Amount (₹)<input type="number" step="0.01" value={form.amount} onChange={set('amount')} /></label>
            {form.type !== 'transfer' && (
              <label>
                {form.type === 'income' ? 'Received from' : 'Paid to'}
                <input value={form.payee} onChange={set('payee')} placeholder={form.type === 'income' ? 'e.g. Employer' : 'e.g. Landlord'} />
              </label>
            )}
            {form.type !== 'transfer' && (
              <label>
                Category
                <select value={form.categoryId} onChange={set('categoryId')}>
                  <option value="">Uncategorised</option>
                  {categories.filter((c) => c.kind === form.type).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label>
              {form.type === 'transfer' ? 'From account' : 'Account'}
              <select value={form.accountId} onChange={set('accountId')}>
                <option value="" disabled>Choose</option>
                {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            {form.type === 'transfer' && (
              <label>
                To account
                <select value={form.toAccountId} onChange={set('toAccountId')}>
                  <option value="" disabled>Choose</option>
                  {activeAccounts.filter((a) => a.id !== Number(form.accountId)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
            <label>
              Repeats
              <select value={form.frequency} onChange={set('frequency')}>
                {Object.entries(FREQUENCIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>Next date<input type="date" value={form.nextDate} onChange={set('nextDate')} /></label>
            <label>Ends on (optional)<input type="date" value={form.endDate} onChange={set('endDate')} /></label>
          </div>
          {form.mode === 'auto' && form.nextDate < todayStr() && (
            <p className="hint">Dates before today will be added straight away.</p>
          )}
          <fieldset className="choices">
            <label className="choice">
              <input type="radio" checked={form.mode === 'auto'} onChange={() => setForm({ ...form, mode: 'auto' })} />
              Add it automatically <span className="hint">— same amount every time (rent, salary, SIP, Netflix)</span>
            </label>
            <label className="choice">
              <input type="radio" checked={form.mode === 'confirm'} onChange={() => setForm({ ...form, mode: 'confirm' })} />
              Ask me to confirm the amount <span className="hint">— bills that change (electricity, phone)</span>
            </label>
          </fieldset>
          <div className="row">
            <button type="submit">{form.id ? 'Save changes' : 'Save'}</button>
            <button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      {pending.length > 0 && (
        <div className="card">
          <h2>Waiting for you</h2>
          <p className="hint">These bills change each time. Check the amount, then confirm.</p>
          <ul className="list">
            {pending.map((p, i) => {
              const isNext = pending.findIndex((x) => x.ruleId === p.ruleId) === i;
              return (
                <li key={keyOf(p)}>
                  <span className="grow">
                    {describe(p)} <span className="hint">due {formatShortDate(p.date)}</span>
                  </span>
                  <input type="number" step="0.01" style={{ width: '8rem' }} disabled={!isNext}
                    value={amounts[keyOf(p)] ?? p.amount} onChange={(e) => setAmounts({ ...amounts, [keyOf(p)]: e.target.value })} />
                  <button disabled={!isNext} onClick={() => confirm(p)}>Confirm</button>
                  <button className="secondary" disabled={!isNext} onClick={() => skip(p)}>Skip</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Next 7 days</h2>
        {upcoming.length ? (
          <ul className="list">
            {upcoming.map((u) => (
              <li key={keyOf(u)}>
                <span className="grow">{describe(u)}</span>
                <span className="hint">{formatShortDate(u.date)} · {u.mode === 'auto' ? 'adds itself' : 'asks you'}</span>
                <span className={`amount ${u.type}`}>{formatMoney(u.amount)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Nothing due in the next 7 days.</p>
        )}
      </div>

      <div className="card">
        <h2>All repeating items</h2>
        {rules.length ? (
          <ul className="list">
            {rules.map((r) => (
              <li key={r.id}>
                <span className="grow">
                  <strong>{describe(r)}</strong>
                  <br />
                  <span className="hint">
                    {FREQUENCIES[r.frequency]} · {status(r)} · {r.mode === 'auto' ? 'adds itself' : 'asks you to confirm'}
                  </span>
                </span>
                <span className={`amount ${r.type}`}>{formatMoney(r.amount)}</span>
                <button className="secondary" onClick={() => setForm(ruleToForm(r))}>Edit</button>
                <button className="secondary" disabled={status(r) === 'ended'} title={status(r) === 'ended' ? 'This item has ended. Edit it and change the end date to restart it.' : undefined}
                  onClick={() => toggle(r)}>{r.active ? 'Pause' : 'Resume'}</button>
                <button className="danger" onClick={() => remove(r)}>Delete</button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">No repeating items yet. Add your rent, salary, SIPs or subscriptions so they log themselves.</div>
        )}
      </div>
    </div>
  );
}
