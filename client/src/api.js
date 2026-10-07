const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = isJson && data?.error ? data.error : 'Request failed';
    throw new Error(message);
  }
  return data;
}

export const api = {
  register: (email, password) => request('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),

  getCategories: (token) => request('/categories', { token }),
  createCategory: (token, category) => request('/categories', { method: 'POST', body: category, token }),
  updateCategory: (token, id, category) => request(`/categories/${id}`, { method: 'PUT', body: category, token }),
  deleteCategory: (token, id) => request(`/categories/${id}`, { method: 'DELETE', token }),

  getExpenses: (token, filters = {}) => {
    const params = new URLSearchParams(filters);
    const qs = params.toString();
    return request(`/expenses${qs ? `?${qs}` : ''}`, { token });
  },
  createExpense: (token, expense) => request('/expenses', { method: 'POST', body: expense, token }),
  updateExpense: (token, id, expense) => request(`/expenses/${id}`, { method: 'PUT', body: expense, token }),
  deleteExpense: (token, id) => request(`/expenses/${id}`, { method: 'DELETE', token }),

  getBudgets: (token, month) => request(`/budgets${month ? `?month=${month}` : ''}`, { token }),
  getBudgetStatus: (token, month) => request(`/budgets/status/${month}`, { token }),
  createBudget: (token, budget) => request('/budgets', { method: 'POST', body: budget, token }),
  deleteBudget: (token, id) => request(`/budgets/${id}`, { method: 'DELETE', token }),

  exportCsv: async (token) => {
    const res = await fetch(`${BASE_URL}/export/csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },
};

export { BASE_URL };
