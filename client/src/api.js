const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) window.dispatchEvent(new Event('auth:expired'));
  if (res.status === 204) return null;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(isJson && data?.error ? data.error : 'Request failed');
  return data;
}

const query = (params = {}) => {
  const clean = Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined);
  const qs = new URLSearchParams(clean).toString();
  return qs ? `?${qs}` : '';
};

export const api = {
  register: (email, password) => request('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),

  getCategories: (token) => request('/categories', { token }),
  createCategory: (token, category) => request('/categories', { method: 'POST', body: category, token }),
  updateCategory: (token, id, category) => request(`/categories/${id}`, { method: 'PUT', body: category, token }),
  deleteCategory: (token, id) => request(`/categories/${id}`, { method: 'DELETE', token }),

  getRules: (token) => request('/rules', { token }),
  createRule: (token, rule) => request('/rules', { method: 'POST', body: rule, token }),
  deleteRule: (token, id) => request(`/rules/${id}`, { method: 'DELETE', token }),

  getAccounts: (token) => request('/accounts', { token }),
  createAccount: (token, account) => request('/accounts', { method: 'POST', body: account, token }),
  updateAccount: (token, id, account) => request(`/accounts/${id}`, { method: 'PUT', body: account, token }),
  deleteAccount: (token, id) => request(`/accounts/${id}`, { method: 'DELETE', token }),

  getTransactions: (token, filters) => request(`/transactions${query(filters)}`, { token }),
  createTransaction: (token, tx) => request('/transactions', { method: 'POST', body: tx, token }),
  updateTransaction: (token, id, tx) => request(`/transactions/${id}`, { method: 'PUT', body: tx, token }),
  deleteTransaction: (token, id) => request(`/transactions/${id}`, { method: 'DELETE', token }),
  getDefaults: (token) => request('/transactions/defaults', { token }),
  getPayees: (token, q, type) => request(`/transactions/payees${query({ q, type })}`, { token }),
  getTags: (token) => request('/transactions/tags', { token }),

  getRecurring: (token) => request('/recurring', { token }),
  getUpcoming: (token, days = 7) => request(`/recurring/upcoming?days=${days}`, { token }),
  createRecurring: (token, item) => request('/recurring', { method: 'POST', body: item, token }),
  updateRecurring: (token, id, item) => request(`/recurring/${id}`, { method: 'PUT', body: item, token }),
  deleteRecurring: (token, id) => request(`/recurring/${id}`, { method: 'DELETE', token }),
  confirmRecurring: (token, id, body) => request(`/recurring/${id}/confirm`, { method: 'POST', body, token }),
  skipRecurring: (token, id) => request(`/recurring/${id}/skip`, { method: 'POST', token }),

  getSummary: (token, from, to, accountId) => request(`/summary${query({ from, to, accountId })}`, { token }),
  getInsights: (token, month, accountId) => request(`/insights${query({ month, accountId })}`, { token }),

  readStatement: (token, fileName, fileBase64) => request('/imports/read', { method: 'POST', body: { fileName, fileBase64 }, token }),
  previewImport: (token, body) => request('/imports/preview', { method: 'POST', body, token }),
  createImport: (token, body) => request('/imports', { method: 'POST', body, token }),
  getImports: (token) => request('/imports', { token }),
  undoImport: (token, id) => request(`/imports/${id}`, { method: 'DELETE', token }),

  getBudgetStatus: (token, month) => request(`/budgets/status/${month}`, { token }),
  createBudget: (token, budget) => request('/budgets', { method: 'POST', body: budget, token }),
  deleteBudget: (token, id) => request(`/budgets/${id}`, { method: 'DELETE', token }),

  getGoals: (token) => request('/goals', { token }),
  createGoal: (token, goal) => request('/goals', { method: 'POST', body: goal, token }),
  updateGoal: (token, id, goal) => request(`/goals/${id}`, { method: 'PUT', body: goal, token }),
  deleteGoal: (token, id) => request(`/goals/${id}`, { method: 'DELETE', token }),
  addGoalMoney: (token, id, body) => request(`/goals/${id}/contributions`, { method: 'POST', body, token }),
  removeGoalMoney: (token, id, entryId) => request(`/goals/${id}/contributions/${entryId}`, { method: 'DELETE', token }),

  getBackup: (token) => request('/backup', { token }),
  restoreBackup: (token, file, preview) => request(`/backup/restore${preview ? '?dryRun=1' : ''}`, { method: 'POST', body: file, token }),

  exportCsv: async (token) => {
    const res = await fetch(`${BASE_URL}/export/csv`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },
};
