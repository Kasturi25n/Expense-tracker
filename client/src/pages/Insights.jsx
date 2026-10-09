import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { InsightCard } from '../components/InsightCard.jsx';
import { AccountPicker, scopeLabel } from '../components/AccountPicker.jsx';
import { formatMoney, todayStr } from '../format.js';

const LIMIT_LABELS = { budget: 'your budget', 'category-budgets': 'your category budgets', income: 'your income' };

const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};

function Change({ now, before, goodWhenUp, short, label }) {
  if (!before) return null;
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  if (pct === 0) return short ? null : <span className="delta">Same as {label}</span>;
  const good = pct > 0 === goodWhenUp;
  return (
    <span className={`delta ${good ? 'good' : 'bad'}`}>
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%{short ? '' : ` vs ${label}`}
    </span>
  );
}

export function Insights() {
  const { token } = useAuth();
  const { version } = useQuickAdd();
  const thisMonth = todayStr().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [accountId, setAccountId] = useState('');
  const [report, setReport] = useState(null);
  const [categories, setCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getCategories(token).then(setCategories).catch((e) => setError(e.message));
    api.getAccounts(token).then((list) => setAccounts(list.filter((a) => !a.archived))).catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    setReport(null);
    api.getInsights(token, month, accountId).then(setReport).catch((e) => setError(e.message));
  }, [token, month, version, accountId]);

  const categoryName = (id) => categories.find((c) => c.id === id)?.name ?? 'Uncategorised';

  return (
    <div className="page">
      <div className="page-header">
        <h1>Insights</h1>
        <div className="month-switch">
          <AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} />
          <button className="secondary" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
          <strong>{monthLabel(month)}</strong>
          <button className="secondary" aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
        </div>
      </div>
      {scopeLabel(accounts, accountId) && <p className="hint scope">{scopeLabel(accounts, accountId)}</p>}
      {error && <p className="error">{error}</p>}
      {!report ? <p className="hint">Loading…</p> : <ReportBody report={report} categoryName={categoryName} />}
    </div>
  );
}

function ReportBody({ report, categoryName }) {
  const { totals, pace, insights } = report;
  const hasData = totals.income > 0 || totals.expense > 0;
  // Mid-month the server compares with the same days of last month.
  const label = report.isCurrentMonth ? 'this point last month' : 'last month';
  return (
    <>
      <div className="stats">
        <div className="stat">
          <span>Money in</span>
          <strong className="amount income">{formatMoney(totals.income)}</strong>
          <Change now={totals.income} before={totals.previous.income} goodWhenUp label={label} />
        </div>
        <div className="stat">
          <span>Money out</span>
          <strong>{formatMoney(totals.expense)}</strong>
          <Change now={totals.expense} before={totals.previous.expense} goodWhenUp={false} label={label} />
        </div>
        <div className="stat">
          <span>{totals.net >= 0 ? 'Saved' : 'Overspent'}</span>
          <strong className={totals.net < 0 ? 'amount negative' : ''}>{formatMoney(Math.abs(totals.net))}</strong>
          {totals.income > 0 && <small>{Math.trunc((totals.net / totals.income) * 100)}% of what came in</small>}
        </div>
      </div>

      {pace && (
        <div className="card">
          <h2>This month's pace</h2>
          <p>
            Spent so far <strong>{formatMoney(pace.spentSoFar)}</strong> · heading for <strong>{formatMoney(Math.round(pace.forecast))}</strong>
            {pace.limit !== null && <> · limit {formatMoney(pace.limit)} ({LIMIT_LABELS[pace.limitSource]})</>}
          </p>
          {pace.safePerDay !== null && (
            <p className="hint">
              {pace.safePerDay > 0
                ? `You can spend about ${formatMoney(Math.floor(pace.safePerDay))} a day for the next ${pace.daysLeft} days.`
                : "There's no room left in this month's limit."}
            </p>
          )}
        </div>
      )}

      <h2>What stands out</h2>
      {!hasData && <div className="empty">Not enough data for this month yet — insights appear as you log transactions.</div>}
      {insights.map((insight) => <InsightCard key={insight.id} insight={insight} />)}

      {hasData && report.categories.length > 0 && (
        <div className="card">
          <h2>Categories</h2>
          <table className="report">
            <thead>
              <tr><th>Category</th><th>This month</th><th>{report.isCurrentMonth ? "Same days last month" : "Last month"}</th><th>3-month avg</th></tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <tr key={c.categoryId ?? 'none'}>
                  <td>{categoryName(c.categoryId)}</td>
                  <td>{formatMoney(c.total)} <Change now={c.total} before={c.previous} goodWhenUp={false} short /></td>
                  <td>{formatMoney(c.previous)}</td>
                  <td>{formatMoney(c.average)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasData && report.topPayees.length > 0 && (
        <div className="card">
          <h2>Top payees</h2>
          <ul className="list">
            {report.topPayees.map((p) => (
              <li key={p.payee}>
                <span className="grow">{p.payee}</span>
                <span className="hint">{p.count} {p.count === 1 ? 'payment' : 'payments'}</span>
                <span className="amount">{formatMoney(p.total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
