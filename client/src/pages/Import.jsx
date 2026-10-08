import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';
import { api } from '../api.js';
import { formatMoney, formatShortDate } from '../format.js';

const DATE_STYLES = {
  dmy: 'Day first — 05/10/26 is 5 Oct',
  mdy: 'Month first — 10/05/26 is 5 Oct',
  ymd: 'Year first — 2026-10-05',
};

const readAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error("Couldn't open that file"));
    reader.readAsDataURL(file);
  });

const mappingComplete = (m) =>
  m && m.date !== null && m.description !== null && (m.layout === 'split' ? m.debit !== null && m.credit !== null : m.amount !== null);

export function Import() {
  const { token } = useAuth();
  const { refresh } = useQuickAdd();
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [accountId, setAccountId] = useState(searchParams.get('accountId') ?? '');
  const [fileName, setFileName] = useState('');
  const [sheet, setSheet] = useState(null);
  const [editColumns, setEditColumns] = useState(false);
  const [preview, setPreview] = useState(null);
  const [picks, setPicks] = useState([]);
  const [done, setDone] = useState(null);
  const [imports, setImports] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadImports = () => api.getImports(token).then(setImports).catch((e) => setError(e.message));

  useEffect(() => {
    Promise.all([api.getAccounts(token), api.getCategories(token)])
      .then(([a, c]) => {
        const active = a.filter((x) => !x.archived);
        setAccounts(active);
        setCategories(c);
        setAccountId((current) => current || String(active[0]?.id ?? ''));
      })
      .catch((e) => setError(e.message));
    loadImports();
  }, [token]);

  const account = accounts.find((a) => String(a.id) === String(accountId));

  const runPreview = async (s = sheet, forAccount = accountId) => {
    setError('');
    setBusy(true);
    try {
      const p = await api.previewImport(token, {
        accountId: Number(forAccount), rows: s.rows, headerRow: s.headerRow, mapping: s.mapping, dateFormat: s.dateFormat,
      });
      setPreview(p);
      setPicks(p.transactions.map((t) => ({ selected: !t.duplicate, payee: t.payee, categoryId: t.categoryId ?? '', transferAccountId: '' })));
      setEditColumns(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setDone(null);
    setPreview(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const s = await api.readStatement(token, file.name, await readAsBase64(file));
      setSheet(s);
      if (mappingComplete(s.mapping) && s.headerRow >= 0) {
        await runPreview(s);
      } else {
        setEditColumns(true);
        setBusy(false);
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const setMapping = (field, value) =>
    setSheet((s) => ({ ...s, mapping: { ...s.mapping, [field]: value === '' ? null : Number(value) } }));

  const totals = useMemo(() => {
    if (!preview) return null;
    const chosen = preview.transactions.filter((_, i) => picks[i]?.selected);
    const net = chosen.reduce((sum, t) => sum + (t.direction === 'in' ? t.amount : -t.amount), 0);
    return { count: chosen.length, after: preview.balance.now + net };
  }, [preview, picks]);

  const setPick = (i, changes) => setPicks((all) => all.map((p, j) => (j === i ? { ...p, ...changes } : p)));
  const selectAll = (selected) => setPicks((all) => all.map((p) => ({ ...p, selected })));

  const doImport = async () => {
    setError('');
    setBusy(true);
    try {
      const transactions = preview.transactions
        .map((t, i) => ({ t, p: picks[i] }))
        .filter(({ p }) => p.selected)
        .map(({ t, p }) => ({
          occurredAt: t.occurredAt,
          amount: t.amount,
          direction: t.direction,
          note: t.note,
          payee: p.payee,
          categoryId: p.transferAccountId || p.categoryId === '' ? null : Number(p.categoryId),
          transferAccountId: p.transferAccountId ? Number(p.transferAccountId) : null,
        }));
      const result = await api.createImport(token, {
        accountId: Number(accountId), fileName, transactions,
        headers: sheet.headerRow >= 0 ? sheet.rows[sheet.headerRow] : null,
        headerRow: sheet.headerRow, mapping: sheet.mapping, dateFormat: sheet.dateFormat,
      });
      setDone({ ...result, accountName: account?.name });
      setPreview(null);
      setSheet(null);
      loadImports();
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (batch) => {
    if (!window.confirm(`Remove the ${batch.row_count} transactions added by "${batch.file_name}", including any you edited since?`)) return;
    try {
      await api.undoImport(token, batch.id);
      if (done?.id === batch.id) setDone(null);
      loadImports();
      refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const headerCells = sheet && sheet.headerRow >= 0 ? sheet.rows[sheet.headerRow] : [];
  const columnName = (i) => (i === null || i === undefined ? '—' : headerCells[i] || `Column ${i + 1}`);
  const columnSelect = (field, optional) => (
    <select value={sheet.mapping?.[field] ?? ''} onChange={(e) => setMapping(field, e.target.value)}>
      <option value="">{optional ? 'None' : 'Choose…'}</option>
      {headerCells.map((cell, i) => <option key={i} value={i}>{cell || `Column ${i + 1}`}</option>)}
    </select>
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Import a bank statement</h1>
        <Link to="/transactions">Back to transactions</Link>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <h2>1. Choose the account and file</h2>
        <div className="form-grid">
          <label>
            Account
            <select
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                if (preview) runPreview(sheet, e.target.value);
              }}
            >
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label>
            Statement file
            <input type="file" accept=".csv,.xls,.xlsx" onChange={chooseFile} disabled={!accountId || busy} />
          </label>
        </div>
        <p className="hint">Download your statement from net banking as Excel or CSV. PDF statements aren't supported. Nothing is saved until you press Import.</p>
      </div>

      {sheet && (
        <div className="card">
          <div className="row spread">
            <h2>2. Columns</h2>
            {!editColumns && <button className="link" onClick={() => setEditColumns(true)}>Change</button>}
          </div>
          {!editColumns ? (
            <p className="hint">
              {sheet.savedFormat ? 'Using your saved format for this bank. ' : ''}
              Date: <strong>{columnName(sheet.mapping.date)}</strong> · Description: <strong>{columnName(sheet.mapping.description)}</strong> ·{' '}
              {sheet.mapping.layout === 'split'
                ? <>Money out: <strong>{columnName(sheet.mapping.debit)}</strong> · Money in: <strong>{columnName(sheet.mapping.credit)}</strong></>
                : <>Amount: <strong>{columnName(sheet.mapping.amount)}</strong></>}
              {' '}· {DATE_STYLES[sheet.dateFormat]}
            </p>
          ) : (
            <>
              {(sheet.headerRow < 0 || !mappingComplete(sheet.mapping)) && (
                <p className="hint">We couldn't work out every column — please pick them below.</p>
              )}
              <div className="form-grid">
                <label>
                  Headings are on
                  <select value={sheet.headerRow} onChange={(e) => setSheet({ ...sheet, headerRow: Number(e.target.value) })}>
                    <option value={-1} disabled>Choose a row</option>
                    {sheet.rows.slice(0, 30).map((r, i) => (
                      <option key={i} value={i}>Row {i + 1}: {r.slice(0, 4).join(' · ').slice(0, 50)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Amounts are shown as
                  <select value={sheet.mapping?.layout ?? 'split'} onChange={(e) => setSheet({ ...sheet, mapping: { ...sheet.mapping, layout: e.target.value } })}>
                    <option value="split">Separate money out / money in columns</option>
                    <option value="single">One amount column</option>
                  </select>
                </label>
                <label>Date{columnSelect('date')}</label>
                <label>Description{columnSelect('description')}</label>
                {sheet.mapping?.layout === 'single' ? (
                  <>
                    <label>Amount{columnSelect('amount')}</label>
                    <label>Dr / Cr column (optional){columnSelect('drcr', true)}</label>
                  </>
                ) : (
                  <>
                    <label>Money out (withdrawals){columnSelect('debit')}</label>
                    <label>Money in (deposits){columnSelect('credit')}</label>
                  </>
                )}
                <label>Balance (optional){columnSelect('balance', true)}</label>
                <label>
                  Dates are written
                  <select value={sheet.dateFormat} onChange={(e) => setSheet({ ...sheet, dateFormat: e.target.value })}>
                    {Object.entries(DATE_STYLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
              <div className="row" style={{ marginTop: '.75rem' }}>
                <button onClick={() => runPreview()} disabled={busy || sheet.headerRow < 0 || !mappingComplete(sheet.mapping)}>Show transactions</button>
              </div>
            </>
          )}
        </div>
      )}

      {preview && (
        <div className="card">
          <div className="row spread">
            <h2>3. Review</h2>
            <span className="hint">
              {totals.count} selected · {preview.transactions.filter((t) => t.duplicate).length} look like duplicates · {preview.skipped.length} skipped
            </span>
          </div>

          {preview.transactions.length > 0 && (
            <p className="hint">
              Dates read as: {preview.transactions.slice(0, 3).map((t) => `${sheet.rows[t.row][sheet.mapping.date]} → ${formatShortDate(t.occurredAt)} ${t.occurredAt.slice(0, 4)}`).join(' · ')}
            </p>
          )}

          {preview.balance.statementClosing !== null && (
            Math.abs(preview.balance.statementClosing - totals.after) > 1 ? (
              <div className="banner">
                <span>
                  After import, {account?.name} will show {formatMoney(totals.after)} but your statement ends at{' '}
                  {formatMoney(preview.balance.statementClosing)} ({formatMoney(Math.abs(preview.balance.statementClosing - totals.after))} apart).
                  Usually a few earlier transactions are missing or the account's starting balance is off — you can fix it on <Link to="/accounts">Accounts</Link>.
                </span>
              </div>
            ) : (
              <p className="hint">✓ After import, {account?.name}'s balance matches your statement ({formatMoney(preview.balance.statementClosing)}).</p>
            )
          )}

          <div className="row">
            <button className="link" onClick={() => selectAll(true)}>Select all</button>
            <button className="link" onClick={() => selectAll(false)}>Select none</button>
          </div>

          <ul className="import-list">
            {preview.transactions.map((t, i) => {
              const p = picks[i];
              const kind = t.direction === 'out' ? 'expense' : 'income';
              return (
                <li key={t.row} className={`import-row ${p.selected ? '' : 'off'}`}>
                  <input type="checkbox" aria-label="Import this row" checked={p.selected} onChange={(e) => setPick(i, { selected: e.target.checked })} />
                  <span className="hint">{formatShortDate(t.occurredAt)}</span>
                  <span className="grow">
                    <input value={p.payee} onChange={(e) => setPick(i, { payee: e.target.value })} aria-label="Payee" />
                    <span className="note" title={t.note}>{t.note}</span>
                    {t.duplicate && <span className="pill">Looks like a duplicate</span>}
                  </span>
                  <select value={p.transferAccountId} onChange={(e) => setPick(i, { transferAccountId: e.target.value })} aria-label="Type">
                    <option value="">{t.direction === 'out' ? 'Expense' : 'Income'}</option>
                    {accounts.filter((a) => a.id !== account?.id).map((a) => (
                      <option key={a.id} value={a.id}>{t.direction === 'out' ? `Transfer to ${a.name}` : `Transfer from ${a.name}`}</option>
                    ))}
                  </select>
                  {p.transferAccountId ? (
                    <span className="hint">Not counted as spending</span>
                  ) : (
                    <select value={p.categoryId} onChange={(e) => setPick(i, { categoryId: e.target.value })} aria-label="Category">
                      <option value="">Uncategorised</option>
                      {categories.filter((c) => c.kind === kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                  <span className={`amount ${t.direction === 'in' ? 'income' : ''}`}>
                    {t.direction === 'in' ? '+' : '−'}{formatMoney(t.amount)}
                  </span>
                </li>
              );
            })}
          </ul>

          {preview.skipped.length > 0 && (
            <details className="skipped">
              <summary>{preview.skipped.length} rows weren't transactions</summary>
              <ul className="list">
                {preview.skipped.map((s) => (
                  <li key={s.row}><span className="hint">Row {s.row + 1} · {s.reason}</span><span className="grow">{s.text}</span></li>
                ))}
              </ul>
            </details>
          )}

          <div className="row" style={{ marginTop: '1rem' }}>
            <button onClick={doImport} disabled={busy || totals.count === 0}>
              Import {totals.count} {totals.count === 1 ? 'transaction' : 'transactions'}
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="card">
          <h2>Done</h2>
          <p>Imported {done.rowCount} transactions into {done.accountName}.</p>
          <div className="row">
            <Link to={`/transactions?accountId=${accountId}`}>View transactions</Link>
            <button className="secondary" onClick={() => undo({ id: done.id, row_count: done.rowCount, file_name: fileName })}>Undo</button>
          </div>
        </div>
      )}

      {imports.length > 0 && (
        <div className="card">
          <h2>Past imports</h2>
          <ul className="list">
            {imports.map((b) => (
              <li key={b.id}>
                <span className="grow">
                  <strong>{b.file_name}</strong>
                  <br />
                  <span className="hint">{b.account_name} · {b.row_count} transactions · {formatShortDate(b.created_at)}</span>
                </span>
                <button className="secondary" onClick={() => undo(b)}>Undo</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
