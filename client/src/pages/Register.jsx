import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await register(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="auth-page">
      <div className="nav-brand auth-brand"><span className="nav-logo" aria-hidden="true">₹</span><strong>Expense Tracker</strong></div>
      <h1>Register</h1>
      <form onSubmit={handleSubmit}>
        <input type="email" placeholder="Email" aria-label="Email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" aria-label="Password" autoComplete="new-password" placeholder="Password (min 6 characters)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
        <button type="submit">Register</button>
        {error && <p className="error">{error}</p>}
      </form>
      <p>Already have an account? <Link to="/login">Log in</Link></p>
    </div>
  );
}
