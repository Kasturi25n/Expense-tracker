import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { nowLocalDateTime } from '../format.js';
import { Modal } from './Modal.jsx';

const TYPES = [['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']];

function toForm(tx) {
  if (!tx.id) {
    return { type: 'expense', amount: '', payee: '', categoryId: '', accountId: '', toAccountId: '', occurredAt: nowLocalDateTime(), tags: '', note: '' };
  }
  return {
    type: tx.type,
    amount: String(tx.amount),
    payee: tx.payee,
    categoryId: tx.category_id ?? '',
    accountId: tx.account_id,
    toAccountId: tx.to_account_id ?? '',
    occurredAt: tx.occurred_at.includes('T') ? tx.occurred_at : `${tx.occurred_at}T00:00`,
    tags: tx.tags.join(', '),
    note: tx.note,
  };
}

export function QuickAdd({ initial, onClose, onSaved }) {
  const { token } = useAuth();
  const isEdit = Boolean(initial.id);
  const [form, setForm] = useState(() => toForm(initial));
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [payees, setPayees] = useState([]);
  const [categoryTouched, setCategoryTouched] = useState(isEdit);
  const [showMore, setShowMore] = useState(isEdit);
  const [ruleOffer, setRuleOffer] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getAccounts(token), api.getCategories(token), isEdit ? null : api.getDefaults(token)])
      .then(([accountList, categoryList, defaults]) => {
        setAccounts(accountList.filter((a) => !a.archived || a.id === initial.account_id || a.id === initial.to_account_id));
        setCategories(categoryList);
        if (defaults?.accountId) setForm((f) => ({ ...f, accountId: f.accountId || defaults.accountId }));
      })
      .catch((e) => setError(e.message));
  }, [token, isEdit, initial]);

  useEffect(() => {
    if (form.type === 'transfer') return undefined;
    const timer = setTimeout(() => {
      api.getPayees(token, form.payee.trim(), form.type)
        .then(({ payees: list, suggestedCategoryId }) => {
          setPayees(list);
          if (!categoryTouched && form.payee.trim()) setForm((f) => ({ ...f, categoryId: suggestedCategoryId ?? '' }));
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [token, form.payee, form.type, categoryTouched]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const chooseType = (type) => {
    setForm((f) => ({ ...f, type, categoryId: '' }));
    setCategoryTouched(false);
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    const amount = parseFloat(form.amount);
    if (!(amount > 0)) return setError('Enter an amount greater than 0');
    if (!form.accountId) return setError('Pick an account');
    if (form.type === 'transfer' && !form.toAccountId) return setError('Pick the account the money went to');

    const body = {
      type: form.type,
      amount,
      occurredAt: form.occurredAt,
      accountId: Number(form.accountId),
      toAccountId: form.type === 'transfer' ? Number(form.toAccountId) : null,
      payee: form.type === 'transfer' ? '' : form.payee.trim(),
      note: form.note.trim(),
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    };
    // A blank category on a new entry lets the server pick one from the payee.
    if (form.type !== 'transfer' && (form.categoryId || isEdit)) {
      body.categoryId = form.categoryId ? Number(form.categoryId) : null;
    }

    try {
      if (isEdit) await api.updateTransaction(token, initial.id, body);
      else await api.createTransaction(token, body);
    } catch (err) {
      return setError(err.message);
    }

    if (isEdit && body.payee && body.categoryId && body.categoryId !== initial.category_id) {
      const rules = await api.getRules(token).catch(() => []);
      if (!rules.some((r) => r.match_text === body.payee.toLowerCase())) {
        const category = categories.find((c) => c.id === body.categoryId);
        return setRuleOffer({ payee: body.payee, categoryId: category.id, categoryName: category.name });
      }
    }
    onSaved();
  };

  const acceptRule = async () => {
    await api.createRule(token, { matchText: ruleOffer.payee, categoryId: ruleOffer.categoryId }).catch(() => {});
    onSaved();
  };

  if (ruleOffer) {
    return (
      <Modal onClose={onSaved}>
        <h2>Remember this?</h2>
        <p>
          Always put <strong>{ruleOffer.payee}</strong> in <strong>{ruleOffer.categoryName}</strong> from now on?
        </p>
        <div className="row">
          <button onClick={acceptRule}>Yes, always</button>
          <button className="secondary" onClick={onSaved}>No thanks</button>
        </div>
      </Modal>
    );
  }

  const kindCategories = categories.filter((c) => c.kind === form.type);
  const accountOptions = (exclude) =>
    accounts.filter((a) => String(a.id) !== String(exclude)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>);

  return (
    <Modal onClose={onClose}>
      <form className="quick-add" onSubmit={save}>
        <h2>{isEdit ? 'Edit transaction' : 'Add transaction'}</h2>
        <div className="segmented">
          {TYPES.map(([value, label]) => (
            <button type="button" key={value} className={form.type === value ? `active ${value}` : ''} onClick={() => chooseType(value)}>
              {label}
            </button>
          ))}
        </div>

        <label>
          Amount (₹)
          <input className="amount-input" type="number" inputMode="decimal" step="0.01" min="0" placeholder="0" autoFocus value={form.amount} onChange={set('amount')} />
        </label>

        {form.type !== 'transfer' && (
          <>
            <label>
              {form.type === 'income' ? 'Received from' : 'Paid to'}
              <input list="payee-options" value={form.payee} onChange={set('payee')} placeholder={form.type === 'income' ? 'e.g. Employer' : 'e.g. Swiggy'} />
              <datalist id="payee-options">{payees.map((p) => <option key={p} value={p} />)}</datalist>
            </label>
            <label>
              Category
              <select value={form.categoryId} onChange={(e) => { setCategoryTouched(true); set('categoryId')(e); }}>
                <option value="">{isEdit ? 'Uncategorised' : 'Pick automatically'}</option>
                {kindCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {!categoryTouched && form.categoryId !== '' && <small className="hint">Picked from the payee — change it if it's wrong</small>}
            </label>
          </>
        )}

        <label>
          {form.type === 'transfer' ? 'From account' : form.type === 'income' ? 'Into account' : 'Paid from'}
          <select value={form.accountId} onChange={set('accountId')}>
            <option value="" disabled>Choose an account</option>
            {accountOptions(null)}
          </select>
        </label>
        {form.type === 'transfer' && (
          <label>
            To account
            <select value={form.toAccountId} onChange={set('toAccountId')}>
              <option value="" disabled>Choose an account</option>
              {accountOptions(form.accountId)}
            </select>
          </label>
        )}

        {showMore ? (
          <>
            <label>Date &amp; time<input type="datetime-local" value={form.occurredAt} onChange={set('occurredAt')} /></label>
            <label>Tags<input value={form.tags} onChange={set('tags')} placeholder="e.g. goa-trip, office" /></label>
            <label>Note<input value={form.note} onChange={set('note')} /></label>
          </>
        ) : (
          <button type="button" className="link" onClick={() => setShowMore(true)}>More details (date, tags, note)</button>
        )}

        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="submit">{isEdit ? 'Save changes' : 'Save'}</button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
