import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { todayStr } from '../format.js';

const KINDS = [
  ['transactions', 'Transactions'],
  ['accounts', 'Accounts'],
  ['categories', 'Categories'],
  ['categoryRules', 'Auto-categorise rules'],
  ['tags', 'Tags'],
  ['recurringRules', 'Recurring items'],
  ['budgets', 'Budgets'],
  ['goals', 'Goals'],
  ['goalContributions', 'Goal savings'],
  ['imports', 'Statement imports'],
  ['importFormats', 'Saved statement formats'],
];

function SummaryTable({ summary, done }) {
  const rows = KINDS.filter(([key]) => summary[key].added + summary[key].skipped > 0);
  return (
    <table className="report">
      <thead>
        <tr><th>In the file</th><th>{done ? 'Added' : 'Will be added'}</th><th>Already here</th></tr>
      </thead>
      <tbody>
        {rows.map(([key, label]) => (
          <tr key={key}>
            <td>{label}</td>
            <td>{summary[key].added > 0 ? <strong>{summary[key].added}</strong> : '—'}</td>
            <td>{summary[key].skipped || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Backup() {
  const { token } = useAuth();
  const [file, setFile] = useState(null); // { name, content, summary }
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    setError('');
    try {
      const data = await api.getBackup(token);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `expense-tracker-backup-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  };

  const choose = async (e) => {
    const picked = e.target.files[0];
    e.target.value = '';
    if (!picked) return;
    setError('');
    setFile(null);
    setResult(null);
    let content;
    try {
      content = JSON.parse(await picked.text());
    } catch {
      return setError("That file isn't an Expense Tracker backup. Choose the .json file you downloaded from this page.");
    }
    setBusy(true);
    try {
      const { summary } = await api.restoreBackup(token, content, true);
      setFile({ name: picked.name, content, summary });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    setError('');
    try {
      const { summary } = await api.restoreBackup(token, file.content, false);
      setResult(summary);
      setFile(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toAdd = file ? KINDS.reduce((n, [key]) => n + file.summary[key].added, 0) : 0;

  return (
    <div className="page">
      <h1>Backup</h1>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <h2>Download a backup</h2>
        <p className="hint">One file with everything: transactions, accounts, categories and rules, recurring items, budgets and goals. Your email and password are not included.</p>
        <button onClick={download}>Download backup</button>
      </div>

      <div className="card">
        <h2>Restore from a backup</h2>
        <p className="hint">
          Restoring only adds what's missing. Nothing you have now is changed or deleted, and anything already here is skipped, so it's safe to restore the same file twice.
        </p>
        <label className="file-pick">
          <span className="button-link secondary">{busy ? 'Checking…' : 'Choose backup file'}</span>
          <input type="file" accept=".json,application/json" hidden disabled={busy} onChange={choose} />
        </label>

        {file && (
          <>
            <h3>{file.name}</h3>
            <SummaryTable summary={file.summary} />
            {toAdd > 0 ? (
              <div className="row" style={{ marginTop: '1rem' }}>
                <button disabled={busy} onClick={restore}>{busy ? 'Restoring…' : 'Restore'}</button>
                <button className="secondary" disabled={busy} onClick={() => setFile(null)}>Cancel</button>
              </div>
            ) : (
              <p className="hint">Everything in this file is already in your account. Nothing to restore.</p>
            )}
          </>
        )}

        {result && (
          <>
            <h3>Restore complete</h3>
            <SummaryTable summary={result} done />
          </>
        )}
      </div>
    </div>
  );
}
