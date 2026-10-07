import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { QuickAddProvider } from './context/QuickAddContext.jsx';
import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { Nav } from './components/Nav.jsx';
import { Login } from './pages/Login.jsx';
import { Register } from './pages/Register.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Transactions } from './pages/Transactions.jsx';
import { Budgets } from './pages/Budgets.jsx';
import { Categories } from './pages/Categories.jsx';
import './App.css';

const guard = (page) => <ProtectedRoute>{page}</ProtectedRoute>;

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <QuickAddProvider>
          <Nav />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/" element={guard(<Dashboard />)} />
            <Route path="/transactions" element={guard(<Transactions />)} />
            <Route path="/budgets" element={guard(<Budgets />)} />
            <Route path="/categories" element={guard(<Categories />)} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </QuickAddProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
