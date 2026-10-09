import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';
import { Modal } from '../components/Modal.jsx';
import { GoalProgress } from '../components/GoalProgress.jsx';
import { formatMoney, formatShortDate, todayStr } from '../format.js';

const STATUS_LABELS = { 'on-track': 'On track', behind: 'Behind', overdue: 'Deadline passed', reached: 'Reached', open: 'No deadline' };
const EMPTY = { name: '', target: '', date: '' };

// Mirrors the server: months from this one to the deadline month, counting both.
function monthlyHint(target, date) {
  const amount = parseFloat(target);
  if (!(amount > 0) || !date || date < todayStr()) return '';
  const [y, m] = todayStr().split('-').map(Number);
  const [ty, tm] = date.split('-').map(Number);
  const months = (ty - y) * 12 + (tm - m) + 1;
  return `That's ${formatMoney(Math.ceil(amount / months))} a month for ${months} ${months === 1 ? 'month' : 'months'}.`;
}

function GoalFields({ form, setForm }) {
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  return (
    <>
      <div className="form-grid">
        <label>What are you saving for?<input value={form.name} maxLength={60} placeholder="Goa trip" onChange={set('name')} /></label>
        <label>Target (₹)<input type="number" step="0.01" min="0" value={form.target} placeholder="40000" onChange={set('target')} /></label>
        <label>By when? (optional)<input type="date" value={form.date} onChange={set('date')} /></label>
      </div>
      {monthlyHint(form.target, form.date) && <p className="hint">{monthlyHint(form.target, form.date)}</p>}
    </>
  );
}

const toBody = (form) => ({ name: form.name, targetAmount: parseFloat(form.target), targetDate: form.date || null });

function sentence(g) {
  if (g.status === 'reached') return 'You made it 🎉';
  if (g.status === 'overdue') return `The deadline has passed — ${formatMoney(g.remaining)} to go. Edit the goal to pick a new date.`;
  if (g.status === 'open') return `${formatMoney(g.remaining)} to go. Add a deadline to see how much to put aside each month.`;
  const months = `${g.monthsLeft} ${g.monthsLeft === 1 ? 'month' : 'months'} left`;
  return `Put aside ${formatMoney(g.perMonth)} a month to get there · ${months}`;
}

export function Goals() {
  const { token } = useAuth();
  const [goals, setGoals] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [dialog, setDialog] = useState(null); // { kind: 'add' | 'take' | 'edit', goal, ...fields }
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.getGoals(token).then(setGoals).catch((e) => setError(e.message));
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

  const create = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setError('Give the goal a name');
    if (!(parseFloat(form.target) > 0)) return setError('Enter a target greater than 0');
    run(async () => {
      await api.createGoal(token, toBody(form));
      setForm(EMPTY);
    });
  };

  const submitDialog = async (e) => {
    e.preventDefault();
    const { kind, goal } = dialog;
    let ok;
    if (kind === 'edit') {
      ok = await run(() => api.updateGoal(token, goal.id, toBody(dialog.form)));
    } else {
      const amount = parseFloat(dialog.amount);
      if (!(amount > 0)) return setError('Enter an amount greater than 0');
      ok = await run(() => api.addGoalMoney(token, goal.id, { amount: kind === 'take' ? -amount : amount, date: dialog.date, note: dialog.note }));
    }
    if (ok) setDialog(null);
  };

  const remove = (g) => {
    if (window.confirm(`Delete "${g.name}" and its saving history? This can't be undone.`)) run(() => api.deleteGoal(token, g.id));
  };

  const closeDialog = () => {
    setError('');
    setDialog(null);
  };
  const openMoney = (kind, goal) => {
    setError('');
    setDialog({ kind, goal, amount: '', date: todayStr(), note: '' });
  };
  const openEdit = (goal) => {
    setError('');
    setDialog({ kind: 'edit', goal, form: { name: goal.name, target: String(goal.target_amount), date: goal.target_date ?? '' } });
  };

  if (!goals) return <div className="page">{error ? <p className="error">{error}</p> : <p className="hint">Loading…</p>}</div>;

  const ordered = [...goals].sort((a, b) => (a.status === 'reached') - (b.status === 'reached'));

  return (
    <div className="page">
      <h1>Savings goals</h1>
      {error && !dialog && <p className="error">{error}</p>}

      {!goals.length && (
        <div className="empty">
          <p>Saving for something? Give it a name, a target and a date — you'll see how much to put aside each month.</p>
          <p className="hint">Goal money is a separate tally. It doesn't change your account balances or count as spending.</p>
        </div>
      )}

      {ordered.map((g) => (
        <div key={g.id} className={`card goal ${g.status}`}>
          <div className="row spread">
            <h2>{g.name}</h2>
            <span className={`pill status-${g.status}`}>{STATUS_LABELS[g.status]}</span>
          </div>
          <GoalProgress goal={g} />
          <p className="goal-line">{sentence(g)}</p>
          <div className="row">
            <button onClick={() => openMoney('add', g)}>Add money</button>
            <button className="secondary" disabled={g.saved <= 0} onClick={() => openMoney('take', g)}>Take out</button>
            <button className="secondary" onClick={() => openEdit(g)}>Edit</button>
            <button className="danger" onClick={() => remove(g)}>Delete</button>
            {g.contributions.length > 0 && (
              <button className="link goal-history" onClick={() => setHistory(history === g.id ? null : g.id)}>
                {history === g.id ? 'Hide history' : `History (${g.contributions.length})`}
              </button>
            )}
          </div>
          {history === g.id && (
            <ul className="list">
              {g.contributions.map((c) => (
                <li key={c.id}>
                  <span className="hint">{formatShortDate(c.date)}</span>
                  <span className="grow">{c.note || (c.amount > 0 ? 'Added' : 'Taken out')}</span>
                  <span className={`amount ${c.amount > 0 ? 'income' : 'negative'}`}>{c.amount > 0 ? '+' : '−'}{formatMoney(Math.abs(c.amount))}</span>
                  <button className="icon" aria-label="Remove entry" onClick={() => run(() => api.removeGoalMoney(token, g.id, c.id))}>×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <form className="card" onSubmit={create}>
        <h2>New goal</h2>
        <GoalFields form={form} setForm={setForm} />
        <button type="submit" style={{ marginTop: '.75rem' }}>Create goal</button>
      </form>

      {dialog && (
        <Modal onClose={closeDialog}>
          <form className="quick-add" onSubmit={submitDialog}>
            {dialog.kind === 'edit' ? (
              <>
                <h2>Edit goal</h2>
                <GoalFields form={dialog.form} setForm={(f) => setDialog({ ...dialog, form: f })} />
              </>
            ) : (
              <>
                <h2>{dialog.kind === 'add' ? 'Add money to' : 'Take money out of'} "{dialog.goal.name}"</h2>
                <input className="amount-input" type="number" step="0.01" min="0" autoFocus placeholder="₹0" aria-label="Amount"
                  value={dialog.amount} onChange={(e) => setDialog({ ...dialog, amount: e.target.value })} />
                <label>Date<input type="date" value={dialog.date} max={todayStr()} onChange={(e) => setDialog({ ...dialog, date: e.target.value })} /></label>
                <label>Note (optional)<input value={dialog.note} maxLength={200} onChange={(e) => setDialog({ ...dialog, note: e.target.value })} /></label>
                <p className="hint">
                  {dialog.kind === 'add'
                    ? `${formatMoney(dialog.goal.remaining)} to go. This doesn't change your account balances.`
                    : `${formatMoney(dialog.goal.saved)} saved so far.`}
                </p>
              </>
            )}
            {error && <p className="error">{error}</p>}
            <div className="row">
              <button type="submit">Save</button>
              <button type="button" className="secondary" onClick={closeDialog}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
