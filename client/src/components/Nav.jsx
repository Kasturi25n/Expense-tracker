import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useQuickAdd } from '../context/QuickAddContext.jsx';

export function Nav() {
  const { user, logout } = useAuth();
  const { open } = useQuickAdd();
  if (!user) return null;
  return (
    <nav className="nav">
      <div className="nav-links">
        <NavLink to="/" end>Home</NavLink>
        <NavLink to="/transactions">Transactions</NavLink>
        <NavLink to="/budgets">Budgets</NavLink>
        <NavLink to="/recurring">Recurring</NavLink>
        <NavLink to="/accounts">Accounts</NavLink>
        <NavLink to="/categories">Categories</NavLink>
      </div>
      <button className="nav-add" onClick={() => open()}>+ Add</button>
      <div className="nav-user">
        <span>{user.email}</span>
        <button className="secondary" onClick={logout}>Log out</button>
      </div>
    </nav>
  );
}
