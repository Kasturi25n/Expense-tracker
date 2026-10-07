import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { CategoryBadge } from '../components/CategoryBadge.jsx';
import { formatDay, formatMoney, signedMoney, timeOf } from '../format.js';

const PAGE_SIZE = 100;
const NO_FILTERS = { q: '', type: '', accountId: '', categoryId: '', tag: '', from: '', to: '' };

function groupByDay(items) {
  const groups = [];
  for (const tx of items) {
    const day = tx.occurred_at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(tx);
    else groups.push({ day, items: [tx] });
  }
  return groups;
}

export function Transactions() {
  const { token } = useAuth();
  const { open, version } = useQuickAdd();
  const [filters, setFilters] = useState(NO_FILTERS);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getAccounts(token), api.getCategories(token), api.getTags(token)])
      .then(([a, c, t]) => {
        setAccounts(a);
        setCategories(c);
        setTags(t);
      })
      .catch((e) => setError(e.message));
  }, [token, version]);

  const load = useCallback(
    (offset = 0) => {
      api.getTransactions(token, { ...filters, limit: PAGE_SIZE, offset })
        .then((page) => {
          setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
          setTotal(page.total);
          setLoaded(true);
        })
        .catch((e) => setError(e.message));
    },
    [token, filters]
  );

  useEffect(() => {
    load(0);
  }, [load, version]);

  const setFilter = (field) => (e) => setFilters((f) => ({ ...f, [field]: e.target.value }));
  const hasFilters = Object.values(filters).some(Boolean);
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? '';
  const categoryOf = (id) => categories.find((c) => c.id === id);
  const title = (tx) =>
    tx.type === 'transfer'
      ? `${accountName(tx.account_id)} → ${accountName(tx.to_account_id)}`
      : tx.payee || tx.note || categoryOf(tx.category_id)?.name || (tx.type === 'income' ? 'Income' : 'Expense');

  const remove = async (tx) => {
    if (!window.confirm(`Delete this ${tx.type} of ${formatMoney(tx.amount)}?`)) return;
    try {
      await api.deleteTransaction(token, tx.id);
      load(0);
    } catch (e) {
      setError(e.message);
    }
  };

  const exportCsv = async () => {
    try {
      const url = URL.createObjectURL(await api.exportCsv(token));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'transactions.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Transactions</h1>
        <button className="secondary" onClick={exportCsv}>Export CSV</button>
      </div>

      <div className="filters">
        <input type="search" placeholder="Search payee or note" value={filters.q} onChange={setFilter('q')} />
        <select value={filters.type} onChange={setFilter('type')}>
          <option value="">All types</option>
          <option value="expense">Expenses</option>
          <option value="income">Income</option>
          <option value="transfer">Transfers</option>
        </select>
        <select value={filters.accountId} onChange={setFilter('accountId')}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={filters.categoryId} onChange={setFilter('categoryId')}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {tags.length > 0 && (
          <select value={filters.tag} onChange={setFilter('tag')}>
            <option value="">All tags</option>
            {tags.map((t) => <option key={t.name} value={t.name}>#{t.name}</option>)}
          </select>
        )}
        <label className="inline">From <input type="date" value={filters.from} onChange={setFilter('from')} /></label>
        <label className="inline">To <input type="date" value={filters.to} onChange={setFilter('to')} /></label>
        {hasFilters && <button className="link" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </div>

      {error && <p className="error">{error}</p>}

      {loaded && items.length === 0 && (
        <div className="empty">
          {hasFilters ? (
            'No transactions match these filters.'
          ) : (
            <>
              <p>Nothing logged yet.</p>
              <button onClick={() => open()}>Add your first transaction</button>
            </>
          )}
        </div>
      )}

      {groupByDay(items).map((group) => (
        <section key={group.day}>
          <h3>{formatDay(group.day)}</h3>
          <ul className="tx-list">
            {group.items.map((tx) => (
              <li key={tx.id} className="tx-row" onClick={() => open(tx)}>
                <div className="tx-main">
                  <span className="tx-title">{title(tx)}</span>
                  <span className="tx-meta">
                    {tx.type !== 'transfer' && <CategoryBadge category={categoryOf(tx.category_id)} />}
                    {tx.type !== 'transfer' && <span>{accountName(tx.account_id)}</span>}
                    {timeOf(tx.occurred_at) && <span>{timeOf(tx.occurred_at)}</span>}
                    {tx.recurring_id !== null && <span title="Added by a repeating item">↻ repeating</span>}
                    {tx.tags.map((t) => <span key={t} className="tag">#{t}</span>)}
                  </span>
                </div>
                <span className={`amount ${tx.type}`}>{signedMoney(tx)}</span>
                <button className="icon" aria-label="Delete" onClick={(e) => { e.stopPropagation(); remove(tx); }}>×</button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {items.length < total && (
        <button className="secondary load-more" onClick={() => load(items.length)}>
          Show more ({total - items.length} older)
        </button>
      )}
    </div>
  );
}
