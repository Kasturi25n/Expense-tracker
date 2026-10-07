import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export function Nav() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <nav className="nav">
      <div className="nav-links">
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/expenses">Expenses</NavLink>
        <NavLink to="/categories">Categories</NavLink>
        <NavLink to="/budgets">Budgets</NavLink>
      </div>
      <div className="nav-user">
        <span>{user.email}</span>
        <button onClick={logout}>Log out</button>
      </div>
    </nav>
  );
}
