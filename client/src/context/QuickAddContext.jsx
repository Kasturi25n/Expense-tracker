import { createContext, useContext, useState, useCallback } from 'react';
import { useAuth } from './AuthContext.jsx';
import { QuickAdd } from '../components/QuickAdd.jsx';

const QuickAddContext = createContext(null);

export function QuickAddProvider({ children }) {
  const { token } = useAuth();
  const [editing, setEditing] = useState(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const open = useCallback((tx = {}) => setEditing(tx), []);
  const close = useCallback(() => setEditing(null), []);
  const saved = useCallback(() => {
    setEditing(null);
    setVersion((v) => v + 1);
  }, []);

  return (
    <QuickAddContext.Provider value={{ open, version, refresh }}>
      {children}
      {token && editing && <QuickAdd initial={editing} onClose={close} onSaved={saved} />}
    </QuickAddContext.Provider>
  );
}

export function useQuickAdd() {
  const ctx = useContext(QuickAddContext);
  if (!ctx) throw new Error('useQuickAdd must be used within QuickAddProvider');
  return ctx;
}
