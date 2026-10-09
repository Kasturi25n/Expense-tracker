import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';

const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  transactions: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  insights: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  budgets: 'M12 3v9h9A9 9 0 1 1 12 3z',
  goals: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  recurring: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  accounts: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18',
  categories: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  backup: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};

const Icon = ({ name }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
);

const LINKS = [
  ['/', 'home', 'Home'],
  ['/transactions', 'transactions', 'Transactions'],
  ['/insights', 'insights', 'Insights'],
  ['/budgets', 'budgets', 'Budgets'],
  ['/goals', 'goals', 'Goals'],
  ['/recurring', 'recurring', 'Recurring'],
  ['/accounts', 'accounts', 'Accounts'],
  ['/categories', 'categories', 'Categories'],
];

export function Nav() {
  const { user, logout } = useAuth();
  const { open } = useQuickAdd();
  if (!user) return null;
  return (
    <nav className="nav">
      <div className="nav-brand">
        <span className="nav-logo" aria-hidden="true">₹</span>
        <strong>Expense Tracker</strong>
      </div>
      <button className="nav-add" onClick={() => open()}>+ Add</button>
      <div className="nav-links">
        {LINKS.map(([to, icon, label]) => (
          <NavLink key={to} to={to} end={to === '/'}><Icon name={icon} />{label}</NavLink>
        ))}
      </div>
      <div className="nav-user">
        <span className="nav-email" title={user.email}>{user.email}</span>
        <NavLink to="/backup"><Icon name="backup" />Backup</NavLink>
        <button onClick={logout}><Icon name="logout" />Log out</button>
      </div>
    </nav>
  );
}
